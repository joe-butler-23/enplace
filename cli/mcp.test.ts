import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { newCookbookId } from "../src/cookbook/doc";
import { openCookingSession } from "../src/agent/session";
// @ts-expect-error The reference relay is a JavaScript executable.
import { startRelay } from "../scripts/cookbook-relay.mjs";

let fixture: string;
beforeAll(async () => {
  fixture = await mkdtemp(path.join(tmpdir(), "enplace-mcp-contract-"));
  await symlink(path.resolve("node_modules"), path.join(fixture, "node_modules"), "dir");
  await build({
    stdin: { contents: 'import { serveCookingMcp } from "./cli/mcp"; await serveCookingMcp(process.argv[2]);', resolveDir: process.cwd() },
    outfile: path.join(fixture, "mcp.mjs"), bundle: true, packages: "external", platform: "node", target: "node24", format: "esm",
  });
});
afterAll(async () => { if (fixture) await rm(fixture, { recursive: true, force: true }); });

async function connectClient(directory: string, id: string, relayUrl: string, receipts?: string) {
  const config = path.join(directory, "cookbook.json");
  await writeFile(config, JSON.stringify({ id, relayUrl }), { mode: 0o600 });
  const client = new Client({ name: "mcp-contract-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(fixture, "mcp.mjs"), config], stderr: "pipe", env: receipts ? { MEP_AGENT_RECEIPT_FILE: receipts } : undefined });
  try { await client.connect(transport, { timeout: 5000 }); }
  catch (error) { await client.close(); throw error; }
  return client;
}

it("rejects unknown tools and invalid arguments before opening a cookbook connection", async () => {
  const directory = await mkdtemp(path.join(fixture, "invalid-"));
  const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(relay, "listening");
  const address = relay.address();
  if (!address || typeof address === "string") throw new Error("Missing test relay address.");
  let connections = 0;
  relay.on("connection", socket => { connections++; socket.close(1008); });
  let client: Client | undefined;
  try {
    client = await connectClient(directory, newCookbookId(), `ws://127.0.0.1:${address.port}`);
    for (const call of [
      { name: "host_execute", arguments: {} },
      { name: "recipe_list", arguments: { arbitrary: true } },
      { name: "recipe_get", arguments: {} },
      { name: "shopping_add", arguments: { operationId: "valid-token", content: 42 } },
      { name: "recipe_search", arguments: { query: "soup", limit: 1001 } },
      { name: "shopping_check", arguments: { operationId: "valid-token", expectedRevision: "a".repeat(64), itemIds: ["line:1", "line:1"] } },
    ]) {
      const result = await client.callTool(call, undefined, { timeout: 1000 });
      expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: "Invalid cooking operation or arguments. Use the advertised tool schema." }] });
      expect(connections).toBe(0);
    }
  } finally {
    await client?.close();
    for (const socket of relay.clients) socket.terminate();
    await new Promise<void>(resolve => relay.close(() => resolve()));
  }
});

/** Hold hydration on protocol events, so cancellation is tested before any mutation can execute. */
async function holdRelayHydration(relayUrl: string) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("Missing test relay address.");
  const sockets = new Set<WebSocket>();
  let held = true;
  const pending: Array<() => void> = [];
  let seen!: () => void;
  let fail!: (error: Error) => void;
  const hydrationSeen = new Promise<void>((resolve, reject) => { seen = resolve; fail = reject; });
  const deadline = setTimeout(() => fail(new Error("MCP peer did not reach hydration.")), 5000);
  server.on("connection", (incoming, request) => {
    const upstream = new WebSocket(relayUrl + request.url);
    sockets.add(incoming); sockets.add(upstream);
    const beforeOpen: RawData[] = [];
    incoming.on("message", data => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
      else beforeOpen.push(data);
    });
    upstream.on("open", () => { for (const data of beforeOpen) upstream.send(data); });
    upstream.on("message", data => {
      const send = () => { if (incoming.readyState === WebSocket.OPEN) incoming.send(data); };
      if (held) { pending.push(send); clearTimeout(deadline); seen(); }
      else send();
    });
    incoming.on("error", fail); upstream.on("error", fail);
    incoming.on("close", () => upstream.terminate());
    upstream.on("close", () => incoming.terminate());
  });
  return {
    url: `ws://127.0.0.1:${address.port}`,
    hydrationSeen,
    release() { held = false; for (const send of pending.splice(0)) send(); },
    async close() { clearTimeout(deadline); for (const socket of sockets) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

it("retries session opening after an initially unhydrated cookbook becomes available", async () => {
  const directory = await mkdtemp(path.join(fixture, "retry-"));
  const receipts = path.join(directory, "receipts.jsonl");
  await writeFile(receipts, "", { mode: 0o600, flag: "wx" });
  const relay = await startRelay({ port: 0, persist: path.join(directory, "relay") });
  const id = newCookbookId();
  let client: Client | undefined;
  let owner: Awaited<ReturnType<typeof openCookingSession>> | undefined;
  try {
    client = await connectClient(directory, id, relay.url, receipts);
    const first = await client.callTool({ name: "recipe_list", arguments: {} }, undefined, { timeout: 5000 });
    expect(first.isError).toBe(true);
    expect(await readFile(receipts, "utf8")).toBe("");
    owner = await openCookingSession({ id, relayUrl: relay.url, create: true, timeoutMs: 2000 });
    await owner.cookbook.commit({ timeoutMs: 2000 });
    const second = await client.callTool({ name: "recipe_list", arguments: {} }, undefined, { timeout: 5000 });
    expect(second.isError, JSON.stringify(second.content)).not.toBe(true);
    expect(await readFile(receipts, "utf8")).toBe('{"kind":"read"}\n');
    const added = await client.callTool({ name: "shopping_add", arguments: { operationId: "mcp-receipt-add", content: "Chickpeas" } });
    expect(added.isError, JSON.stringify(added.content)).not.toBe(true);
    expect(await readFile(receipts, "utf8")).toBe('{"kind":"read"}\n{"kind":"write"}\n');
  } finally { await client?.close(); await owner?.close(); await relay.close(); }
}, 15000);

it("does not execute a mutation cancelled while its initial hydration is pending", async () => {
  const directory = await mkdtemp(path.join(fixture, "cancel-"));
  const relay = await startRelay({ port: 0, persist: path.join(directory, "relay") });
  const id = newCookbookId();
  let owner: Awaited<ReturnType<typeof openCookingSession>> | undefined;
  let proxy: Awaited<ReturnType<typeof holdRelayHydration>> | undefined;
  let client: Client | undefined;
  try {
    owner = await openCookingSession({ id, relayUrl: relay.url, create: true, timeoutMs: 2000 });
    await owner.cookbook.commit({ timeoutMs: 2000 });
    proxy = await holdRelayHydration(relay.url);
    client = await connectClient(directory, id, proxy.url);
    const abort = new AbortController();
    const mutation = client.callTool({ name: "shopping_add", arguments: { operationId: "cancel-before-hydration", content: "Cancelled chickpeas" } }, undefined, { signal: abort.signal, timeout: 5000 });
    const rejected = expect(mutation).rejects.toThrow("Cancelled by test");
    await proxy.hydrationSeen;
    abort.abort(new Error("Cancelled by test"));
    await rejected;
    // The stdout response to this later request acknowledges that the server received
    // the preceding cancellation notification, while cookbook hydration remains held.
    await client.listTools({}, { timeout: 5000 });
    const current = client.callTool({ name: "shopping_read", arguments: {} }, undefined, { timeout: 5000 });
    proxy.release();
    const result = await current;
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(JSON.stringify(result.content)).not.toContain("Cancelled chickpeas");
    expect(JSON.stringify(await owner.execute("shopping.read", {}))).not.toContain("Cancelled chickpeas");
  } finally { await client?.close(); await proxy?.close(); await owner?.close(); await relay.close(); }
}, 15000);
