import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const REMOTE_ORIGIN = 'relay-test-remote';
// Sent by the test-only Kitchen subclass once the production onMessage override (which now
// awaits a storage flush before returning) has resolved, so tests can wait for a genuine
// durability signal instead of a timer.
const FLUSHED_SIGNAL = '__flushed__';

let runtime;
const openSockets = new Set();

beforeAll(async () => {
  const bundle = await build({
    stdin: { contents: `
      import relay, { Kitchen as ProductionKitchen } from './relay/src/index.ts';
      export class Kitchen extends ProductionKitchen {
        async onMessage(connection, message) {
          await super.onMessage(connection, message);
          connection.send('${FLUSHED_SIGNAL}');
        }
        async fetch(request) {
          const path = new URL(request.url).pathname;
          if (path === '/seed') {
            const entries = await request.json();
            for (const [key, value] of Object.entries(entries)) {
              await this.ctx.storage.put(key, Array.isArray(value) ? new Uint8Array(value) : value);
            }
            return new Response('seeded');
          }
          if (path === '/stored') {
            return Response.json(Object.fromEntries(await this.ctx.storage.list()));
          }
          if (path === '/run-alarm') {
            await this.alarm();
            return new Response('alarmed');
          }
          return super.fetch(request);
        }
      }
      export default {
        fetch(request, env) {
          const url = new URL(request.url);
          if (url.pathname === '/seed' || url.pathname === '/stored' || url.pathname === '/run-alarm') {
            return env.Kitchen.get(env.Kitchen.idFromName(url.searchParams.get('id'))).fetch(request);
          }
          return relay.fetch(request, env);
        }
      };`, resolveDir: process.cwd() },
    bundle: true, write: false, format: 'esm', platform: 'neutral',
    mainFields: ['module', 'main'], external: ['cloudflare:workers'], conditions: ['workerd', 'browser'],
  });
  runtime = new Miniflare({
    workers: [{ config: {
      type: 'worker', name: 'relay-test', compatibilityDate: '2026-08-01',
      manifest: { mainModule: 'relay.mjs', modules: { 'relay.mjs': { type: 'esm', contents: bundle.outputFiles[0].text } } },
      env: {
        Kitchen: { type: 'durable-object', worker: 'relay-test', exportName: 'Kitchen' },
        // Stubs the Workers Rate Limiting binding with Miniflare's own rate-limit plugin, which
        // implements the same `limit({ key })` interface as the deployed binding.
        NEW_ROOM_LIMITER: { type: 'rate-limit', namespace: 'test-new-room-limiter', simple: { limit: 20, period: 60 } },
      },
      exports: { Kitchen: { type: 'durable-object', storage: 'sqlite' } },
    } }],
  });
  await runtime.ready;
}, 30_000);
afterAll(async () => { await runtime?.dispose(); });
afterEach(() => {
  for (const socket of openSockets) {
    try { socket.close(1000, "test cleanup"); } catch { /* already closed */ }
  }
  openSockets.clear();
});

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

let roomCounter = 0;
function freshRoomId() {
  roomCounter += 1;
  return `e1-${roomCounter.toString(16).padStart(4, '0')}${'0'.repeat(60)}`;
}

async function openRaw(id, headers = {}) {
  return runtime.dispatchFetch(`http://relay/parties/kitchen/${id}`, {
    headers: { Upgrade: 'websocket', ...headers },
  });
}

async function connectRaw(id, headers = {}) {
  const response = await openRaw(id, headers);
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  socket.accept();
  openSockets.add(socket);
  return socket;
}

function frame(write) {
  const encoder = encoding.createEncoder();
  write(encoder);
  return encoding.toUint8Array(encoder);
}

function syncStep1Frame(doc) {
  return frame((encoder) => {
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, doc);
  });
}

function updateFrame(update) {
  return frame((encoder) => {
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
  });
}

function awarenessFrame(id, state) {
  return frame((encoder) => {
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    const body = encoding.createEncoder();
    encoding.writeVarUint(body, 1);
    encoding.writeVarUint(body, id);
    encoding.writeVarUint(body, 1);
    encoding.writeVarString(body, JSON.stringify(state));
    encoding.writeVarUint8Array(encoder, encoding.toUint8Array(body));
  });
}

/** A minimal y-websocket-protocol client wired directly to a Miniflare-issued WebSocket. */
async function connectDoc(id, headers = {}) {
  const socket = await connectRaw(id, headers);
  const doc = new Y.Doc();
  socket.addEventListener('message', (event) => {
    if (typeof event.data === 'string') return;
    const decoder = decoding.createDecoder(new Uint8Array(event.data));
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.readSyncMessage(decoder, encoder, doc, REMOTE_ORIGIN);
    if (encoding.length(encoder) > 1) socket.send(encoding.toUint8Array(encoder));
  });
  doc.on('update', (update, origin) => {
    if (origin === REMOTE_ORIGIN) return;
    socket.send(updateFrame(update));
  });
  socket.send(syncStep1Frame(doc));
  return { socket, doc };
}

async function closeSocket(socket) {
  if (!openSockets.delete(socket)) return;
  if (socket.readyState === 3) return;
  const closed = within(new Promise((resolve) => socket.addEventListener('close', resolve, { once: true })), 'socket to close');
  // An explicit code is required: workerd reports a bare close() as code 1005 (no status
  // received), and partyserver deliberately does not reciprocate that reserved code (it
  // assumes no peer is left to receive it), which leaves this in-process client socket stuck
  // in CLOSING forever. A real browser tears its transport down regardless, but this harness
  // has no such fallback, so always close cleanly with an explicit code.
  socket.close(1000, "test cleanup");
  await closed;
}

function writeText(doc, file, value) {
  doc.transact(() => {
    const files = doc.getMap('files');
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
  const value = doc.getMap('files').get(file);
  return value instanceof Y.Text ? value.toString() : null;
}

async function waitForText(doc, file, expected, label) {
  if (readText(doc, file) === expected) return;
  await within(new Promise((resolve) => {
    const changed = () => {
      if (readText(doc, file) !== expected) return;
      doc.off('update', changed);
      resolve();
    };
    doc.on('update', changed);
  }), label ?? `${file} to contain expected text`);
}

async function waitForFlushSignal(socket) {
  await within(new Promise((resolve) => {
    const handler = (event) => {
      if (event.data !== FLUSHED_SIGNAL) return;
      socket.removeEventListener('message', handler);
      resolve();
    };
    socket.addEventListener('message', handler);
  }), 'flush acknowledgement');
}

function bytesFromJsonObject(value) {
  const length = Object.keys(value).length;
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = value[index];
  return bytes;
}

/** Reconstructs a Yjs document the way Kitchen.onLoad does: the chunked snapshot, then every
 *  update appended since it, in order. */
function docFromStoredChunks(stored) {
  const doc = new Y.Doc();
  const count = stored.chunks ?? 0;
  if (count) {
    const parts = Array.from({ length: count }, (_, index) => bytesFromJsonObject(stored[`chunk:${index}`]));
    const update = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) { update.set(part, offset); offset += part.byteLength; }
    Y.applyUpdate(doc, update);
  }
  for (const key of Object.keys(stored).filter((name) => name.startsWith('update:')).sort()) {
    Y.applyUpdate(doc, bytesFromJsonObject(stored[key]));
  }
  return doc;
}

/** Rows holding cookbook content: snapshot chunks plus updates appended since the snapshot. */
function storedRows(stored) {
  return (stored.chunks ?? 0) + Object.keys(stored).filter((name) => name.startsWith('update:')).length;
}

async function fetchStored(id) {
  return (await runtime.dispatchFetch(`http://relay/stored?id=${id}`)).json();
}

it('rejects incomplete stored snapshots before a websocket can receive false-empty sync', async () => {
  const id = 'e1-' + 'a'.repeat(64);
  await runtime.dispatchFetch(`http://relay/seed?id=${id}`, {
    method: 'POST', body: JSON.stringify({ chunks: 2, 'chunk:0': [0] }),
  });
  const response = await runtime.dispatchFetch(`http://relay/parties/kitchen/${id}`, {
    headers: { Upgrade: 'websocket' },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  const messages = [];
  const closed = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Relay did not reject the incomplete snapshot')), 2_000);
    socket.addEventListener('message', (event) => {
      messages.push(event.data);
      if (typeof event.data !== 'string') {
        clearTimeout(deadline);
        socket.close();
        reject(new Error('Relay sent binary sync for an incomplete snapshot'));
      }
    });
    socket.addEventListener('close', (event) => { clearTimeout(deadline); resolve(event.code); });
  });
  socket.accept();
  expect(await closed).toBe(1011);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain('Incomplete cookbook snapshot');
  const stored = await fetchStored(id);
  expect(stored.chunks).toBe(2);
  expect(stored['chunk:0']).toEqual({ '0': 0 });
  expect(stored['chunk:1']).toBeUndefined();
});

it('accepts a complete deliberately empty snapshot', async () => {
  const id = 'e1-' + 'b'.repeat(64);
  const doc = new Y.Doc();
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  await runtime.dispatchFetch(`http://relay/seed?id=${id}`, {
    method: 'POST', body: JSON.stringify({ chunks: 1, 'chunk:0': [...update] }),
  });
  const response = await runtime.dispatchFetch(`http://relay/parties/kitchen/${id}`, {
    headers: { Upgrade: 'websocket' },
  });
  expect(response.status).toBe(101);
  response.webSocket.accept();
  response.webSocket.close();
});

it('converges two sockets and round-trips a payload spanning several 100 KB chunks after reload', async () => {
  const id = freshRoomId();
  const large = 'x'.repeat(250_000);
  const writer = await connectDoc(id);
  writeText(writer.doc, 'Shopping.md', large);

  const reader = await connectDoc(id);
  await waitForText(reader.doc, 'Shopping.md', large, 'reader to converge on the large payload');

  await closeSocket(writer.socket);
  await closeSocket(reader.socket);

  const reloaded = await connectDoc(id);
  await waitForText(reloaded.doc, 'Shopping.md', large, 'reloaded room to recover the large payload');
  const stored = await fetchStored(id);
  expect(stored.chunks).toBeGreaterThan(2); // 250_000 bytes / 100_000-byte chunks
});

it('flushes a document update to storage before acknowledging the message, without any disconnect', async () => {
  const id = freshRoomId();
  const client = await connectDoc(id);
  const flushed = waitForFlushSignal(client.socket);
  writeText(client.doc, 'Shopping.md', 'urgent milk\n');
  await flushed;

  const persisted = docFromStoredChunks(await fetchStored(id));
  expect(readText(persisted, 'Shopping.md')).toBe('urgent milk\n');
  persisted.destroy();
  // The socket never closed, so this proves durability does not depend on the disconnect path
  // or a debounce timer settling — the scenario hibernation eviction would otherwise threaten.
});

it('recovers the last update after every socket closes and the room is reopened fresh', async () => {
  const id = freshRoomId();
  const client = await connectDoc(id);
  writeText(client.doc, 'Shopping.md', 'closed-room milk\n');
  await waitForFlushSignal(client.socket);
  await closeSocket(client.socket);

  const reopened = await connectDoc(id);
  await waitForText(reopened.doc, 'Shopping.md', 'closed-room milk\n', 'reopened room to recover its last update');
  await closeSocket(reopened.socket);
});

it('closes only the socket whose message exceeds the configured byte cap', async () => {
  const oversizedId = freshRoomId();
  const oversized = await connectRaw(oversizedId);
  const closed = within(new Promise((resolve) => oversized.addEventListener('close', (event) => resolve(event.code), { once: true })), 'oversized socket to close');
  // Comfortably above the relay's 20 MiB cap but safely below workerd's own ~32 MiB transport
  // frame ceiling, so this exercises the relay's own graceful 1009 close rather than the
  // runtime's uncaught protocol error for frames it refuses to deliver at all.
  oversized.send(new Uint8Array(21 * 1024 * 1024));
  expect(await closed).toBe(1009);

  const otherId = freshRoomId();
  await expect(openRaw(otherId).then((response) => response.status)).resolves.toBe(101);
});

it('refuses a document update over the cap without corrupting the room or another room', async () => {
  const id = freshRoomId();
  const oversizedDoc = new Y.Doc();
  oversizedDoc.getMap('files').set('cover.webp', new Uint8Array(17 * 1024 * 1024));
  const update = Y.encodeStateAsUpdate(oversizedDoc);
  oversizedDoc.destroy();

  const socket = await connectRaw(id);
  const closed = within(new Promise((resolve) => socket.addEventListener('close', (event) => resolve(event.code), { once: true })), 'oversized document socket to close');
  socket.send(updateFrame(update));
  expect(await closed).toBe(1009);

  // The room's own close (triggered by the policy violation, since it was the only connection)
  // legitimately flushes whatever the document actually holds — proving the *content* was
  // never merged matters here, not whether a save happened at all.
  const persisted = docFromStoredChunks(await fetchStored(id));
  expect(persisted.getMap('files').has('cover.webp')).toBe(false);
  persisted.destroy();

  const otherId = freshRoomId();
  const witness = await connectDoc(otherId);
  writeText(witness.doc, 'Shopping.md', 'still works\n');
  await waitForFlushSignal(witness.socket);
  await closeSocket(witness.socket);
});

it('closes a connection that introduces a second awareness identity', async () => {
  const id = freshRoomId();
  const socket = await connectRaw(id);
  const closed = within(new Promise((resolve) => socket.addEventListener('close', (event) => resolve(event.code), { once: true })), 'awareness policy socket to close');
  socket.send(awarenessFrame(101, { user: 'first' }));
  socket.send(awarenessFrame(202, { user: 'second' }));
  expect(await closed).toBe(1008);

  const otherId = freshRoomId();
  await expect(openRaw(otherId).then((response) => response.status)).resolves.toBe(101);
});

it('caps awareness update bytes independently of the message cap', async () => {
  const id = freshRoomId();
  const socket = await connectRaw(id);
  const closed = within(new Promise((resolve) => socket.addEventListener('close', (event) => resolve(event.code), { once: true })), 'oversized awareness socket to close');
  socket.send(awarenessFrame(303, { value: 'x'.repeat(64 * 1024) }));
  expect(await closed).toBe(1009);
});

it('enforces the per-room connection cap without disturbing accepted sockets or other rooms', async () => {
  const id = freshRoomId();
  const accepted = [];
  for (let index = 0; index < 64; index += 1) {
    accepted.push(await connectRaw(id));
  }
  const rejected = await openRaw(id);
  expect(rejected.status).toBe(503);

  for (const socket of accepted) expect(socket.readyState).toBe(1);
  const otherId = freshRoomId();
  await expect(openRaw(otherId).then((response) => response.status)).resolves.toBe(101);
});

it('throttles new-room creation per client address without throttling reconnects to an existing room', async () => {
  const clientIp = '203.0.113.7';
  let lastStatus = 101;
  for (let index = 0; index < 21; index += 1) {
    const response = await openRaw(freshRoomId(), { 'cf-connecting-ip': clientIp });
    lastStatus = response.status;
    if (response.status === 101) {
      response.webSocket.accept();
      openSockets.add(response.webSocket);
    }
  }
  expect(lastStatus).toBe(429);

  const existingId = freshRoomId();
  const first = await connectRaw(existingId, { 'cf-connecting-ip': '198.51.100.9' });
  await closeSocket(first);
  for (let index = 0; index < 25; index += 1) {
    const response = await openRaw(existingId, { 'cf-connecting-ip': '198.51.100.9' });
    expect(response.status).toBe(101);
    response.webSocket.accept();
    response.webSocket.close(1000, "reconnect test");
  }
});

it('expires an idle room via the retention alarm but spares a room with an open connection', async () => {
  const idleId = freshRoomId();
  const idleClient = await connectDoc(idleId);
  writeText(idleClient.doc, 'Shopping.md', 'going stale\n');
  await waitForFlushSignal(idleClient.socket);
  await closeSocket(idleClient.socket);
  expect(storedRows(await fetchStored(idleId))).toBeGreaterThan(0);
  await runtime.dispatchFetch(`http://relay/run-alarm?id=${idleId}`);
  expect(storedRows(await fetchStored(idleId))).toBe(0);

  const activeId = freshRoomId();
  const activeClient = await connectDoc(activeId);
  writeText(activeClient.doc, 'Shopping.md', 'still cooking\n');
  await waitForFlushSignal(activeClient.socket);
  await runtime.dispatchFetch(`http://relay/run-alarm?id=${activeId}`);
  expect(storedRows(await fetchStored(activeId))).toBeGreaterThan(0);
  await closeSocket(activeClient.socket);
});
