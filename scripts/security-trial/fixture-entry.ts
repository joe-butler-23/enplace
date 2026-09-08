/** Offline test adapter, not a production CLI or an authorization boundary.
 * Uses the production operation engine; deliberately omits relay transport.
 */
import * as Y from "yjs";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { COOKING_OPERATIONS, executeCookingOperation } from "../../src/agent/operations";
import { listCookbookPaths, readCookbookText, writeCookbookText } from "../../src/cookbook/doc";

const doc = new Y.Doc();
const state = ".fixture/book.yjs";
if (existsSync(state)) Y.applyUpdate(doc, new Uint8Array(readFileSync(state)));
const [verb, ...args] = process.argv.slice(2);
const context = { doc, async mutate<T>(operation: () => T): Promise<T> {
  let result!: T; doc.transact(() => { result = operation(); }); return result;
} };
try {
  if (verb === "seed") {
    for (const [path, text] of Object.entries(JSON.parse(readFileSync(args[0], "utf8")))) writeCookbookText(doc, path, text as string);
  } else if (verb === "dump") {
    console.log(JSON.stringify(Object.fromEntries(listCookbookPaths(doc).map(path => [path, readCookbookText(doc, path)]))));
  } else if (verb === "tools") {
    console.log(JSON.stringify(COOKING_OPERATIONS.filter(op => !args.length || args.includes(op.name))));
  } else {
    const name = verb === "show" ? "recipe.get" : verb === "list" ? "recipe.list" : verb === "plan" ? "plan.read" : verb === "shop" ? "shopping.read" : args[0];
    const input = verb === "call" ? JSON.parse(readFileSync(0, "utf8")) : verb === "show" ? { path: args[0] } : {};
    appendFileSync(".fixture/operations.jsonl", JSON.stringify({ name, args: input }) + "\n");
    const result = await executeCookingOperation(context, name, input);
    console.log(verb === "show" ? result.markdown : JSON.stringify(result));
  }
  if (verb !== "dump" && verb !== "tools") writeFileSync(state, Y.encodeStateAsUpdate(doc));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
} finally { doc.destroy(); }
