import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { COOKING_OPERATIONS, validateCookingOperationArguments, type CookingOperationDefinition } from "../src/agent/operations";
import { openCookingSession } from "../src/agent/session";
import { readAssociation } from "./association";
import { cookingToolName } from "./mcp-tools";

/** Receipts contain only code-owned enums; cookbook text never returns to the unrestricted caller. */
async function recordReceipt(mutates: boolean): Promise<void> {
  const path = process.env.MEP_AGENT_RECEIPT_FILE;
  if (!path) return;
  const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error("Invalid receipt channel.");
    await handle.writeFile(JSON.stringify({ kind: mutates ? "write" : "read" }) + "\n");
  } finally { await handle.close(); }
}

export async function serveCookingMcp(configPath?: string): Promise<void> {
  const association = await readAssociation(configPath);
  const abort = new AbortController();
  let session: ReturnType<typeof openCookingSession> | undefined;
  const getSession = () => {
    if (!session) {
      const opening = openCookingSession({ ...association, signal: abort.signal });
      session = opening;
      void opening.catch(() => { if (session === opening) session = undefined; });
    }
    return session;
  };
  const operations = COOKING_OPERATIONS.map((operation) => ({ ...operation, toolName: cookingToolName(operation.name) }));
  const server = new Server({ name: "enplace", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: operations.map(({ toolName, description, inputSchema, mutates }) => ({
      name: toolName, description, inputSchema,
      annotations: { readOnlyHint: !mutates, destructiveHint: mutates, openWorldHint: false },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    let operation: CookingOperationDefinition;
    try {
      const tool = operations.find(({ toolName }) => toolName === params.name);
      operation = validateCookingOperationArguments(tool?.name ?? "", params.arguments ?? {});
    } catch {
      return { isError: true, content: [{ type: "text", text: "Invalid cooking operation or arguments. Use the advertised tool schema." }] };
    }
    try {
      const result = await (await getSession()).execute(operation.name, params.arguments ?? {}, { signal: extra.signal });
      await recordReceipt(operation.mutates);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Cooking operation failed.";
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  });
  const transport = new StdioServerTransport();
  await new Promise<void>((resolve, reject) => {
    let closing = false;
    const finish = async (): Promise<void> => {
      if (closing) return;
      closing = true;
      abort.abort(new Error("Cooking session ended."));
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      if (session) await session.then((value) => value.close()).catch(() => {});
      await server.close();
      resolve();
    };
    const onSignal = (): void => { void finish(); };
    server.onclose = () => { void finish(); };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    server.connect(transport).catch(reject);
  });
}
