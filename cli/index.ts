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
import { mirrorKitchen } from "./mirror.js";

export type ExecuteOptions = {
  cwd?: string;
  stdin?: string;
  now?: Date;
  log?: (line: string) => void;
  signal?: AbortSignal;
};

type Arguments = {
  command: string;
  positional: string[];
  folder: string;
  json: boolean;
  week?: string;
  kitchen?: string;
  relay?: string;
  once: boolean;
};

function argumentsFor(argv: string[], cwd: string): Arguments {
  const positional: string[] = [];
  let folder = cwd;
  let folderProvided = false;
  let json = false;
  let once = false;
  let week: string | undefined;
  let kitchen: string | undefined;
  let relay: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--json") json = true;
    else if (value === "--once") once = true;
    else if (["--folder", "--week", "--kitchen", "--relay"].includes(value)) {
      const next = argv[++index];
      if (!next || next.startsWith("--")) throw new Error(`${value} needs a value`);
      if (value === "--folder") {
        folder = path.resolve(cwd, next);
        folderProvided = true;
      } else if (value === "--week") week = next;
      else if (value === "--kitchen") kitchen = next;
      else relay = next;
    } else if (value.startsWith("--")) throw new Error(`unknown option: ${value}`);
    else positional.push(value);
  }
  const [command = "", ...rest] = positional;
  if (!command || !["check", "add", "list", "shop", "mirror"].includes(command)) {
    throw new Error(
      "usage: mep <check|add|list|shop|mirror> [options]\n"
      + "       mep mirror --folder <dir> --kitchen <link-or-id> [--relay <wss-url>] [--once]",
    );
  }
  if ((command === "check" || command === "add") && rest.length !== 1) throw new Error(`${command} needs one <file|->`);
  if (["list", "shop", "mirror"].includes(command) && rest.length) throw new Error(`${command} takes no file argument`);
  if (week && command !== "shop") throw new Error("--week is only valid with shop");
  if ((kitchen || relay || once) && command !== "mirror") throw new Error("--kitchen, --relay, and --once are only valid with mirror");
  if (command === "mirror") {
    if (!folderProvided) throw new Error("mirror needs --folder <dir>");
    if (!kitchen) throw new Error("mirror needs --kitchen <link-or-id>");
    if (json) throw new Error("--json is not valid with mirror");
  }
  return { command, positional: rest, folder, json, week, kitchen, relay, once };
}

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
      else if (entry.isFile() && entry.name.toLocaleLowerCase().endsWith(".md")) {
        files.push({ path: relative, text: await readFile(absolute, "utf8") });
      }
    }
  }
  await walk(folder, "");
  return files;
}

const slugify = (title: string): string => title.toLocaleLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "recipe";

async function destination(folder: string, title: string): Promise<string> {
  const recipes = path.join(folder, "recipes");
  return `${await exists(recipes) && (await stat(recipes)).isDirectory() ? "recipes/" : ""}${slugify(title)}.md`;
}

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
  return { recipe, markdown: input.markdown, destination: await destination(folder, recipe.title) };
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

function conflictPath(file: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return file.replace(/\.md$/i, "") + `.conflict-${stamp}.md`;
}

async function saveShopping(file: string, initial: Buffer | null, markdown: string, now: Date): Promise<void> {
  if (hash(await readOptional(file)) !== hash(initial)) {
    const conflict = conflictPath(file, now);
    await writeFile(conflict, markdown, { flag: "wx" });
    throw new Error(`Shopping.md changed while rebuilding; new list saved as ${path.basename(conflict)}`);
  }
  await writeFile(file, markdown);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function execute(argv: string[], options: ExecuteOptions = {}): Promise<string> {
  const args = argumentsFor(argv, options.cwd ?? process.cwd());
  if (!(await stat(args.folder).catch(() => null))?.isDirectory()) throw new Error(`folder not found: ${args.folder}`);

  if (args.command === "mirror") {
    const relay = args.relay ?? process.env.ENPLACE_RELAY_URL;
    if (!relay) throw new Error("mirror needs --relay <wss-url> or ENPLACE_RELAY_URL");
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

  if (args.command === "check" || args.command === "add") {
    const checked = await checkedRecipe(args.folder, args.positional[0], options.stdin);
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

  const monday = mondayFor(args.week, options.now ?? new Date());
  const selected = parsePlan(await readFile(path.join(args.folder, "Plan.md"), "utf8"));
  const planned = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const date = new Date(monday); date.setDate(monday.getDate() + offset);
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
