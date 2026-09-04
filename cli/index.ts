#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildShoppingMarkdown,
  parsePlan,
  parseRecipe,
  resolveRecipeReference,
  scanRecipes,
} from "../src/core.js";

export type ExecuteOptions = {
  cwd?: string;
  stdin?: string;
  now?: Date;
  log?: (line: string) => void;
  signal?: AbortSignal;
};

const valueOptions = new Set(["--folder", "--week", "--kitchen", "--relay"]);
const recipeCommands = new Set(["check", "add"]);

function validateArguments(command: string, positional: string[], options: ReadonlyMap<string, string>): void {
  if (!command || !["check", "add", "list", "shop", "mirror"].includes(command)) {
    throw new Error("usage: mep <check|add|list|shop|mirror> [options]\n"
      + "       mep mirror --folder <dir> --kitchen <link-or-id> [--relay <wss-url>] [--once]");
  }
  if (recipeCommands.has(command) && positional.length !== 1) throw new Error(`${command} needs one <file|->`);
  if (["list", "shop", "mirror"].includes(command) && positional.length) throw new Error(`${command} takes no file argument`);
  if (options.has("--week") && command !== "shop") throw new Error("--week is only valid with shop");
  if ((options.has("--kitchen") || options.has("--relay") || options.has("--once")) && command !== "mirror") {
    throw new Error("--kitchen, --relay, and --once are only valid with mirror");
  }
  if (command === "mirror") {
    if (!options.has("--folder")) throw new Error("mirror needs --folder <dir>");
    if (!options.has("--kitchen")) throw new Error("mirror needs --kitchen <link-or-id>");
    if (options.has("--json")) throw new Error("--json is not valid with mirror");
  }
}

function argumentsFor(argv: string[], cwd: string) {
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--json" || value === "--once") {
      options.set(value, "");
      continue;
    }
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    if (!valueOptions.has(value)) throw new Error(`unknown option: ${value}`);
    const next = argv[++index];
    if (!next || next.startsWith("--")) throw new Error(`${value} needs a value`);
    options.set(value, next);
  }
  const [command = "", ...rest] = positional;
  validateArguments(command, rest, options);
  const folder = options.get("--folder");
  return {
    command,
    positional: rest,
    folder: folder === undefined ? cwd : path.resolve(cwd, folder),
    json: options.has("--json"),
    week: options.get("--week"),
    kitchen: options.get("--kitchen"),
    relay: options.get("--relay"),
    once: options.has("--once"),
  };
}

type Arguments = ReturnType<typeof argumentsFor>;

async function exists(candidate: string): Promise<boolean> {
  try { await access(candidate, constants.F_OK); return true; } catch { return false; }
}

async function recipeFiles(folder: string): Promise<Array<{ path: string; text: string }>> {
  const files: Array<{ path: string; text: string }> = [];
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute, relative);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push({ path: relative, text: await readFile(absolute, "utf8") });
      }
    }
  }
  await walk(folder, "");
  return files;
}

const slugify = (title: string): string => title.toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "recipe";

async function recipeInput(file: string, stdin: string | undefined): Promise<{ sourcePath: string; markdown: string }> {
  if (file === "-") {
    const markdown = stdin ?? await new Promise<string>((resolve, reject) => {
      let value = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk: string) => { value += chunk; });
      process.stdin.on("end", () => resolve(value));
      process.stdin.on("error", reject);
    });
    return { sourcePath: "-", markdown };
  }
  return { sourcePath: file, markdown: await readFile(file, "utf8") };
}

async function checkedRecipe(folder: string, file: string, stdin: string | undefined) {
  const input = await recipeInput(file, stdin);
  const recipe = parseRecipe(input.sourcePath, input.markdown);
  if (!recipe) throw new Error("recipe needs an ## Ingredients heading");
  if (file === "-" && recipe.title === "-") throw new Error("recipe needs a frontmatter title or # heading");
  const recipes = path.join(folder, "recipes");
  const prefix = await exists(recipes) && (await stat(recipes)).isDirectory() ? "recipes/" : "";
  return { recipe, markdown: input.markdown, destination: `${prefix}${slugify(recipe.title)}.md` };
}

function localIso(date: Date): string {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((value, index) => index === 0 ? String(value) : String(value).padStart(2, "0")).join("-");
}

function mondayFor(value: string | undefined, now: Date): Date {
  const input = value ?? localIso(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) throw new Error("--week needs YYYY-MM-DD");
  const date = new Date(`${input}T12:00:00`);
  if (Number.isNaN(date.valueOf()) || localIso(date) !== input) throw new Error("--week needs a valid date");
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return date;
}

const hash = (value: Buffer | null): string | null => value === null ? null : createHash("sha256").update(value).digest("hex");

async function readOptional(file: string): Promise<Buffer | null> {
  try { return await readFile(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function saveShopping(file: string, initial: Buffer | null, markdown: string, now: Date): Promise<void> {
  if (hash(await readOptional(file)) !== hash(initial)) {
    const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const conflict = file.replace(/\.md$/i, "") + `.conflict-${stamp}.md`;
    await writeFile(conflict, markdown, { flag: "wx" });
    throw new Error(`Shopping.md changed while rebuilding; new list saved as ${path.basename(conflict)}`);
  }
  await writeFile(file, markdown);
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

async function runRecipeCommand(args: Arguments, stdin: string | undefined): Promise<string> {
  const checked = await checkedRecipe(args.folder, args.positional[0], stdin);
  if (args.command === "add") {
    const output = path.join(args.folder, checked.destination);
    await mkdir(path.dirname(output), { recursive: true });
    try { await writeFile(output, checked.markdown, { flag: "wx" }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`refusing to overwrite ${checked.destination}`);
      throw error;
    }
    return args.json ? json({ path: checked.destination }) : `${checked.destination}\n`;
  }
  return args.json
    ? json({ title: checked.recipe.title, path: checked.destination })
    : `OK: ${checked.recipe.title} -> ${checked.destination}\n`;
}

async function runShop(args: Arguments, options: ExecuteOptions, recipes: ReturnType<typeof scanRecipes>): Promise<string> {
  const monday = mondayFor(args.week, options.now ?? new Date());
  const selected = parsePlan(await readFile(path.join(args.folder, "Plan.md"), "utf8"));
  const planned = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const date = new Date(monday);
    date.setDate(monday.getDate() + offset);
    for (const reference of selected.days.get(localIso(date)) ?? []) {
      const recipe = resolveRecipeReference(recipes, reference);
      if (recipe) planned.push(recipe);
    }
  }
  const shoppingPath = path.join(args.folder, "Shopping.md");
  const initial = await readOptional(shoppingPath);
  const markdown = buildShoppingMarkdown(initial?.toString("utf8") ?? "", planned, recipes);
  await saveShopping(shoppingPath, initial, markdown, options.now ?? new Date());
  return args.json
    ? json({ week: localIso(monday), path: "Shopping.md", markdown })
    : markdown;
}

export async function execute(argv: string[], options: ExecuteOptions = {}): Promise<string> {
  const args = argumentsFor(argv, options.cwd ?? process.cwd());
  if (!(await stat(args.folder).catch(() => null))?.isDirectory()) throw new Error(`folder not found: ${args.folder}`);

  if (args.command === "mirror") {
    const relay = args.relay ?? process.env.ENPLACE_RELAY_URL;
    if (!relay) throw new Error("mirror needs --relay <wss-url> or ENPLACE_RELAY_URL");
    const { mirrorKitchen } = await import("./mirror.js");
    await mirrorKitchen({
      folder: args.folder,
      kitchen: args.kitchen!,
      relay,
      once: args.once,
      log: options.log,
      signal: options.signal,
      now: options.now ? () => options.now! : undefined,
    });
    return "";
  }

  if (recipeCommands.has(args.command)) return runRecipeCommand(args, options.stdin);
  const recipes = scanRecipes(await recipeFiles(args.folder));
  if (args.command === "list") {
    const rows = recipes.map((recipe) => ({
      path: recipe.path,
      title: recipe.title,
      tags: recipe.tags,
      cover: recipe.cover !== null,
    }));
    if (args.json) return json(rows);
    return rows.length
      ? `${rows.map((row) => `${row.path}\t${row.title}\t${row.tags.join(",")}\t${row.cover ? "cover" : "no cover"}`).join("\n")}\n`
      : "No recipes found.\n";
  }
  return runShop(args, options, recipes);
}

async function main(): Promise<void> {
  try {
    process.stdout.write(await execute(process.argv.slice(2), { log: (line) => process.stdout.write(line) }));
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`mep: ${message.replace(/\s+/g, " ").trim()}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
