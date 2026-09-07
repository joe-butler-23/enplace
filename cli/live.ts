import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { COOKING_OPERATIONS } from "../src/agent/operations";
import { openCookingSession } from "../src/agent/session";
import { associationPath, parseAssociation, readAssociation, readCookbookLink, saveAssociation } from "./association";

const HELP = `mep cookbook use [--relay URL]  Connect once; paste the link at the hidden prompt
mep tools                     Print the cooking operation schemas
mep call <operation> [file|-]  Run an operation using JSON arguments (stdin by default)
mep list [--json]              List live recipes
mep show <path>                Read one live recipe as Markdown
mep add <file|->               Add RecipeMD to the live cookbook
mep amend <path> <file|-> --base <file>  Merge an edited recipe with its read base
mep plan                      Read the live meal plan
mep shop                      Read the live shopping list
mep shop --week YYYY-MM-DD     Build shopping for the selected week
mep export <file.zip>          Explicitly export cookbook files

Every mutating operation takes operationId. Reuse it when retrying an uncertain result.
Use mep tools for the full recipe, planning, shopping and recovery operations.
Existing folder commands remain available with --folder; there is no folder sync.
`;

async function stdinText(): Promise<string> {
  let value = "";
  for await (const chunk of process.stdin) {
    value += String(chunk);
    if (Buffer.byteLength(value) > 2 * 1024 * 1024) throw new Error("Input exceeds 2 MiB.");
  }
  return value;
}
const inputText = (file: string): Promise<string> => file === "-" ? stdinText() : readFile(file, "utf8");

/** Returns false only for the existing explicit folder/formatting CLI. */
export async function executeLiveCli(argv: string[]): Promise<boolean> {
  if (argv.includes("--help") || argv[0] === "help") { process.stdout.write(HELP); return true; }
  if (argv.includes("--folder") || ["check", "convert"].includes(argv[0])) return false;
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--json") { options.set(value, ""); continue; }
    if (["--config", "--relay", "--base", "--operation-id", "--week"].includes(value)) {
      const next = argv[++index];
      if (!next || next.startsWith("--")) throw new Error(`${value} needs a value`);
      options.set(value, next); continue;
    }
    if (value.startsWith("--")) throw new Error(`unknown option: ${value}`);
    positional.push(value);
  }
  const [command, ...rest] = positional;
  if (options.has("--week") && command !== "shop") throw new Error("--week is only valid with shop");
  const config = options.get("--config") ?? associationPath();
  if (command === "cookbook") {
    if (rest.length !== 1 || rest[0] !== "use") throw new Error("Use mep cookbook use and paste the link at the hidden prompt; links are never command arguments.");
    const association = parseAssociation(await readCookbookLink(), options.get("--relay"));
    const session = await openCookingSession(association);
    try { await saveAssociation(association, config); }
    finally { await session.close(); }
    process.stdout.write("Cookbook connected.\n");
    return true;
  }
  if (command === "tools") { process.stdout.write(JSON.stringify(COOKING_OPERATIONS, null, 2) + "\n"); return true; }
  if (!["call", "list", "show", "add", "amend", "plan", "shop", "export"].includes(command)) return false;
  const association = await readAssociation(config);
  let name: string;
  let args: Record<string, unknown>;
  const operationId = options.get("--operation-id") ?? randomUUID();
  if (command === "call") {
    if (rest.length < 1 || rest.length > 2) throw new Error("Use mep call <operation> [JSON-file|-].");
    name = rest[0];
    const value: unknown = JSON.parse(await inputText(rest[1] ?? "-"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Operation arguments must be a JSON object.");
    args = value as Record<string, unknown>;
  } else if (command === "add") {
    if (rest.length !== 1) throw new Error("add needs one <file|->");
    name = "recipe.create"; args = { operationId, markdown: await inputText(rest[0]) };
  } else if (command === "amend") {
    if (rest.length !== 2 || !options.has("--base")) throw new Error("Use mep amend <recipe-path> <draft-file|-> --base <read-base-file>.");
    name = "recipe.update"; args = { operationId, path: rest[0], markdown: await inputText(rest[1]), base: await readFile(options.get("--base")!, "utf8") };
  } else if (command === "show") {
    if (rest.length !== 1) throw new Error("show needs one recipe path.");
    name = "recipe.get"; args = { path: rest[0] };
  } else {
    if (command !== "export" && rest.length) throw new Error(`Use mep call for ${command} operations; mep tools lists their schemas.`);
    name = command === "list" ? "recipe.list" : command === "plan" ? "plan.read" : options.has("--week") ? "shopping.build" : "shopping.read";
    args = {};
  }
  const session = await openCookingSession(association);
  try {
    if (command === "export") {
      if (rest.length !== 1 || !rest[0].endsWith(".zip")) throw new Error("export needs one destination.zip.");
      const { zipSync } = await import("fflate");
      const files = Object.fromEntries((await session.cookbook.adapter.walkFiles()).map(({ path, bytes }) => [path, bytes]));
      await writeFile(rest[0], zipSync(files), { flag: "wx", mode: 0o600 });
      process.stdout.write("Cookbook exported.\n");
    } else {
      if (name === "shopping.build") {
        const plan = await session.execute("plan.read", {}) as { revision: string };
        const shopping = await session.execute("shopping.read", {}) as { revision: string };
        args = { operationId, week: options.get("--week"), expectedRevision: shopping.revision, planRevision: plan.revision };
      }
      const result = await session.execute(name, args);
      if (command === "show" && !options.has("--json") && result && typeof result === "object" && "markdown" in result) process.stdout.write(String(result.markdown));
      else process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    }
  } finally { await session.close(); }
  return true;
}
