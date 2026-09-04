import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import * as encoding from "lib0/encoding";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { startRelay } from "./cookbook-relay.mjs";

const clients = new Set();
const relays = new Set();
const children = new Set();
const temporaryDirectories = new Set();

async function within(promise, label, milliseconds = 5_000) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function openClient(url, room) {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(url, room, doc, {
    WebSocketPolyfill: WebSocket,
    disableBc: true,
  });
  const client = { doc, provider };
  clients.add(client);
  if (!provider.synced) {
    await within(new Promise((resolve) => {
      const synced = (state) => {
        if (!state) return;
        provider.off("sync", synced);
        resolve();
      };
      provider.on("sync", synced);
    }), `room ${room} to sync`);
  }
  return client;
}

async function closeClient(client) {
  if (!clients.delete(client)) return;
  const socket = client.provider.ws;
  const closed = socket && socket.readyState !== WebSocket.CLOSED
    ? within(once(socket, "close"), "client socket to close")
    : Promise.resolve();
  client.provider.destroy();
  await closed;
  client.doc.destroy();
}

function writeText(doc, file, value) {
  doc.transact(() => {
    const files = doc.getMap("files");
    let text = files.get(file);
    if (!(text instanceof Y.Text)) {
      text = new Y.Text();
      files.set(file, text);
    }
    const current = text.toString();
    if (current) text.delete(0, current.length);
    text.insert(0, value);
  });
}

function readText(doc, file) {
  const value = doc.getMap("files").get(file);
  return value instanceof Y.Text ? value.toString() : null;
}

async function waitForText(doc, file, expected) {
  if (readText(doc, file) === expected) return;
  await within(new Promise((resolve) => {
    const changed = () => {
      if (readText(doc, file) !== expected) return;
      doc.off("update", changed);
      resolve();
    };
    doc.on("update", changed);
  }), `${file} to contain expected text`);
}

async function startDirectRelay(options = {}) {
  const relay = await startRelay(options);
  relays.add(relay);
  return relay;
}

async function stopChild(child) {
  if (!children.delete(child) || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await within(once(child, "exit"), "relay child to exit");
}

async function startRelayChild(arguments_ = []) {
  const child = spawn(process.execPath, ["scripts/cookbook-relay.mjs", "--port", "0", ...arguments_], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const line = await within(new Promise((resolve, reject) => {
    let stdout = "";
    const exited = (code, signal) => reject(new Error(`relay exited before ready (${code ?? signal}): ${stderr}`));
    child.once("exit", exited);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      child.off("exit", exited);
      resolve(stdout.slice(0, newline));
    });
  }), "relay child readiness");
  return { child, url: line.replace(/^listening /, ""), stderr: () => stderr };
}

async function malformedUpgrade(baseUrl, requestPath) {
  const url = new URL(baseUrl);
  return await within(new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: url.hostname, port: Number(url.port) });
    let response = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(
        `GET ${requestPath} HTTP/1.1\r\n`
        + `Host: ${url.host}\r\n`
        + "Upgrade: websocket\r\n"
        + "Connection: Upgrade\r\n"
        + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
        + "Sec-WebSocket-Version: 13\r\n\r\n",
      );
    });
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("error", reject);
    socket.on("close", () => resolve(response));
  }), `malformed upgrade ${requestPath}`);
}

async function openRaw(url) {
  const socket = new WebSocket(url);
  await within(once(socket, "open"), "raw websocket to open");
  return socket;
}

function awarenessFrame(id, state) {
  const update = encoding.createEncoder();
  encoding.writeVarUint(update, 1);
  encoding.writeVarUint(update, id);
  encoding.writeVarUint(update, 1);
  encoding.writeVarString(update, JSON.stringify(state));
  const message = encoding.createEncoder();
  encoding.writeVarUint(message, 1);
  encoding.writeVarUint8Array(message, encoding.toUint8Array(update));
  return encoding.toUint8Array(message);
}

afterEach(async () => {
  await Promise.all([...clients].map(closeClient));
  await Promise.all([...relays].map(async (relay) => {
    relays.delete(relay);
    await relay.close();
  }));
  await Promise.all([...children].map(stopChild));
  await Promise.all([...temporaryDirectories].map(async (directory) => {
    temporaryDirectories.delete(directory);
    await rm(directory, { recursive: true, force: true });
  }));
});

describe("cookbook relay hardening", () => {
  it("rejects malformed room upgrades without killing a child relay or an existing room", async () => {
    const relay = await startRelayChild([
      "--max-message-bytes", "16384",
      "--max-document-bytes", "8192",
      "--max-awareness-bytes", "1024",
      "--max-rooms", "5",
      "--max-connections", "5",
    ]);
    const room = "a".repeat(26);
    const first = await openClient(relay.url, room);

    for (const requestPath of ["/%E0%A4%A", "/%", "/short", `/${"A".repeat(26)}`]) {
      expect(await malformedUpgrade(relay.url, requestPath)).toMatch(/^HTTP\/1\.1 400 Bad Request/);
      expect(relay.child.exitCode).toBeNull();
    }

    const second = await openClient(relay.url, room);
    writeText(second.doc, "Shopping.md", "# Shopping\n");
    await waitForText(first.doc, "Shopping.md", "# Shopping\n");
    expect(relay.child.exitCode).toBeNull();
    expect(relay.stderr()).not.toMatch(/URIError|uncaught|could not handle/i);
  });

  it("evicts persistent rooms after disconnect and reloads their content", async () => {
    const persist = await mkdtemp(path.join(os.tmpdir(), "mep-relay-persist-"));
    temporaryDirectories.add(persist);
    const relay = await startDirectRelay({ persist, maxRooms: 1 });
    const firstRoom = "b".repeat(26);
    const otherRoom = "c".repeat(26);
    const writer = await openClient(relay.url, firstRoom);
    writeText(writer.doc, "Shopping.md", "persisted shopping\n");
    const witness = await openClient(relay.url, firstRoom);
    await waitForText(witness.doc, "Shopping.md", "persisted shopping\n");
    await closeClient(witness);
    await closeClient(writer);

    const reconnecting = await openClient(relay.url, firstRoom);
    writeText(reconnecting.doc, "Shopping.md", "newest persisted shopping\n");
    const churnWitness = await openClient(relay.url, firstRoom);
    await waitForText(churnWitness.doc, "Shopping.md", "newest persisted shopping\n");
    await closeClient(churnWitness);
    await closeClient(reconnecting);

    const other = await openClient(relay.url, otherRoom);
    await closeClient(other);
    const reloaded = await openClient(relay.url, firstRoom);
    expect(readText(reloaded.doc, "Shopping.md")).toBe("newest persisted shopping\n");
  });

  it("closes only the socket whose message exceeds the configured limit", async () => {
    const relay = await startDirectRelay({ maxMessageBytes: 128, maxDocumentBytes: 32, maxAwarenessBytes: 24 });
    const oversized = await openRaw(`${relay.url}/${"d".repeat(26)}`);
    const closed = once(oversized, "close");
    oversized.send(Buffer.alloc(129));
    const [code] = await within(closed, "oversized socket to close");
    expect(code).toBe(1009);

    await expect(openClient(relay.url, "e".repeat(26))).resolves.toBeDefined();
  });

  it("rejects a document update over the room limit without affecting another room", async () => {
    const relay = await startDirectRelay({ maxMessageBytes: 4_096, maxDocumentBytes: 256, maxAwarenessBytes: 1_024 });
    const oversized = await openClient(relay.url, "f".repeat(26));
    const closed = once(oversized.provider.ws, "close");
    oversized.doc.getMap("files").set("cover.webp", new Uint8Array(512));
    const [code] = await within(closed, "oversized document socket to close");
    expect(code).toBe(1009);

    await expect(openClient(relay.url, "g".repeat(26))).resolves.toBeDefined();
  });

  it("limits one awareness identity per connection and keeps the relay available", async () => {
    const relay = await startDirectRelay();
    const socket = await openRaw(`${relay.url}/${"j".repeat(26)}`);
    const closed = once(socket, "close");
    socket.send(awarenessFrame(101, { user: "first" }));
    socket.send(awarenessFrame(202, { user: "second" }));
    const [code] = await within(closed, "awareness policy socket to close");
    expect(code).toBe(1008);

    await expect(openClient(relay.url, "k".repeat(26))).resolves.toBeDefined();
  });

  it("caps awareness update bytes without affecting another room", async () => {
    const relay = await startDirectRelay({ maxAwarenessBytes: 64 });
    const socket = await openRaw(`${relay.url}/${"l".repeat(26)}`);
    const closed = once(socket, "close");
    socket.send(awarenessFrame(303, { value: "x".repeat(128) }));
    const [code] = await within(closed, "oversized awareness socket to close");
    expect(code).toBe(1009);

    await expect(openClient(relay.url, "m".repeat(26))).resolves.toBeDefined();
  });

  it("enforces the concurrent connection limit without disturbing accepted sockets", async () => {
    const relay = await startDirectRelay({ maxConnections: 1 });
    const accepted = await openClient(relay.url, "h".repeat(26));
    const rejected = new WebSocket(`${relay.url}/${"i".repeat(26)}`);
    rejected.on("error", () => {});
    const [request, response] = await within(once(rejected, "unexpected-response"), "connection rejection");
    request.destroy();
    expect(response.statusCode).toBe(503);

    expect(accepted.provider.wsconnected).toBe(true);
  });
});
