#!/usr/bin/env node

import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { WebSocket, WebSocketServer } from "ws";
import * as Y from "yjs";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const KEEPALIVE_INTERVAL_MS = 30_000;
const ROOM_ID_PATTERN = /^(?:[a-z2-7]{26}|e1-[a-f0-9]{64})$/;

export const RELAY_DEFAULTS = Object.freeze({
  maxMessageBytes: 32 * 1024 * 1024,
  maxDocumentBytes: 16 * 1024 * 1024,
  maxAwarenessBytes: 64 * 1024,
  maxRooms: 1_000,
  maxConnections: 2_000,
});

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(message);
}

function syncMessage(write) {
  const output = encoding.createEncoder();
  encoding.writeVarUint(output, MESSAGE_SYNC);
  write(output);
  return encoding.toUint8Array(output);
}

function awarenessMessage(update) {
  const output = encoding.createEncoder();
  encoding.writeVarUint(output, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(output, update);
  return encoding.toUint8Array(output);
}

function bytes(raw) {
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (Array.isArray(raw)) {
    const length = raw.reduce((total, part) => total + part.byteLength, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    for (const part of raw) {
      output.set(part, offset);
      offset += part.byteLength;
    }
    return output;
  }
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
}

function roomName(requestUrl) {
  const pathname = new URL(requestUrl ?? "/", "ws://relay.local").pathname.slice(1);
  const name = decodeURIComponent(pathname);
  if (!ROOM_ID_PATTERN.test(name)) throw new Error("invalid cookbook room");
  return name;
}

function rejectUpgrade(socket, status, reason) {
  const body = `${reason}\n`;
  socket.on("error", () => {});
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n`
    + "Connection: close\r\n"
    + "Content-Type: text/plain\r\n"
    + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`
    + body,
  );
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function policyViolation(message) {
  return Object.assign(new Error(message), { closeCode: 1008 });
}

function persistedRoomPath(directory, name) {
  return resolve(directory, `${encodeURIComponent(name)}.yjs`);
}

function validateAwarenessUpdate(room, socket, update, maxAwarenessBytes) {
  if (update.byteLength > maxAwarenessBytes) {
    throw Object.assign(new Error("awareness update too large"), { closeCode: 1009 });
  }
  const input = decoding.createDecoder(update);
  const states = new Set(room.controlledIds.get(socket));
  const records = [];
  const length = decoding.readVarUint(input);
  for (let index = 0; index < length; index += 1) {
    const id = decoding.readVarUint(input);
    decoding.readVarUint(input);
    const state = JSON.parse(decoding.readVarString(input));
    const owner = [...room.controlledIds].find(([, ids]) => ids.has(id))?.[0];
    if (state === null) {
      if (owner && owner !== socket) throw policyViolation("cannot remove another connection's awareness");
      states.delete(id);
    } else {
      if (owner && owner !== socket) throw policyViolation("cannot replace another connection's awareness");
      states.add(id);
      if (states.size > 1) throw policyViolation("one awareness client is allowed per connection");
    }
    records.push({ id, removed: state === null });
  }
  return records;
}

function applyRoomUpdate(room, update, socket, maxDocumentBytes) {
  const candidate = new Y.Doc();
  try {
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(room.doc));
    Y.applyUpdate(candidate, update);
    if (Y.encodeStateAsUpdate(candidate).byteLength > maxDocumentBytes) {
      socket.close(1009, "cookbook document too large");
      return false;
    }
    Y.applyUpdate(room.doc, update, socket);
    return true;
  } finally {
    candidate.destroy();
  }
}

export async function startRelay({
  port = 0,
  host = "127.0.0.1",
  persist = null,
  maxMessageBytes = RELAY_DEFAULTS.maxMessageBytes,
  maxDocumentBytes = RELAY_DEFAULTS.maxDocumentBytes,
  maxAwarenessBytes = RELAY_DEFAULTS.maxAwarenessBytes,
  maxRooms = RELAY_DEFAULTS.maxRooms,
  maxConnections = RELAY_DEFAULTS.maxConnections,
} = {}) {
  positiveInteger(maxMessageBytes, "maxMessageBytes");
  positiveInteger(maxDocumentBytes, "maxDocumentBytes");
  positiveInteger(maxAwarenessBytes, "maxAwarenessBytes");
  if (maxAwarenessBytes >= maxMessageBytes) {
    throw new Error("maxAwarenessBytes must be less than maxMessageBytes");
  }
  if (maxMessageBytes < maxDocumentBytes + 64) {
    throw new Error("maxMessageBytes must be at least 64 bytes greater than maxDocumentBytes for full-room sync");
  }
  positiveInteger(maxRooms, "maxRooms");
  positiveInteger(maxConnections, "maxConnections");
  const persistDirectory = persist ? resolve(persist) : null;
  if (persistDirectory) await mkdir(persistDirectory, { recursive: true });

  const rooms = new Map();
  const httpServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("okay");
  });
  const socketServer = new WebSocketServer({ noServer: true, maxPayload: maxMessageBytes });
  const liveSockets = new WeakSet();

  const getRoom = (name) => {
    const existing = rooms.get(name);
    if (existing) return existing;

    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState(null);
    const room = {
      name,
      doc,
      awareness,
      sockets: new Set(),
      controlledIds: new Map(),
      writeChain: Promise.resolve(),
      writeRequested: false,
      writeRunning: false,
      ready: Promise.resolve(),
    };
    rooms.set(name, room);
    room.ready = (async () => {
      if (persistDirectory) {
        try {
          Y.applyUpdate(doc, await readFile(persistedRoomPath(persistDirectory, name)));
          if (Y.encodeStateAsUpdate(doc).byteLength > maxDocumentBytes) {
            throw new Error(`persisted room ${name} exceeds maxDocumentBytes`);
          }
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
      doc.on("update", (update) => {
        const message = syncMessage((output) => syncProtocol.writeUpdate(output, update));
        for (const socket of room.sockets) send(socket, message);
        if (persistDirectory) {
          room.writeRequested = true;
          if (!room.writeRunning) {
            room.writeRunning = true;
            room.writeChain = (async () => {
              try {
                while (room.writeRequested) {
                  room.writeRequested = false;
                  await writeFile(persistedRoomPath(persistDirectory, name), Y.encodeStateAsUpdate(doc));
                }
              } catch (error) {
                console.error(`could not persist room ${name}:`, error);
              } finally {
                room.writeRunning = false;
              }
            })();
          }
        }
      });
      awareness.on("update", ({ added, updated, removed }, origin) => {
        if (room.controlledIds.has(origin)) {
          const controlled = room.controlledIds.get(origin);
          for (const id of added) controlled.add(id);
          for (const id of removed) controlled.delete(id);
        }
        const changed = added.concat(updated, removed);
        const message = awarenessMessage(awarenessProtocol.encodeAwarenessUpdate(awareness, changed));
        for (const socket of room.sockets) send(socket, message);
      });
    })();
    return room;
  };

  const evictRoom = (room) => {
    void (async () => {
      await room.ready.catch(() => undefined);
      while (room.sockets.size === 0 && rooms.get(room.name) === room) {
        const write = room.writeChain;
        await write;
        if (write !== room.writeChain) continue;
        if (room.sockets.size === 0 && rooms.get(room.name) === room) {
          rooms.delete(room.name);
          room.awareness.destroy();
          room.doc.destroy();
        }
        return;
      }
    })();
  };

  socketServer.on("connection", (socket, request, name) => {
    const room = getRoom(name);
    room.sockets.add(socket);
    room.controlledIds.set(socket, new Set());
    liveSockets.add(socket);

    socket.on("error", (error) => {
      if (error?.code !== "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") {
        console.error(`room ${room.name} socket error:`, error);
      }
    });
    socket.on("pong", () => liveSockets.add(socket));
    socket.on("message", (raw) => {
      void room.ready.then(() => {
        if (!room.sockets.has(socket)) return;
        try {
          const input = decoding.createDecoder(bytes(raw));
          const messageType = decoding.readVarUint(input);
          if (messageType === MESSAGE_SYNC) {
            const reply = encoding.createEncoder();
            encoding.writeVarUint(reply, MESSAGE_SYNC);
            const syncType = decoding.readVarUint(input);
            if (syncType === syncProtocol.messageYjsSyncStep1) {
              syncProtocol.readSyncStep1(input, reply, room.doc);
            } else if (
              syncType === syncProtocol.messageYjsSyncStep2
              || syncType === syncProtocol.messageYjsUpdate
            ) {
              const update = decoding.readVarUint8Array(input);
              if (!applyRoomUpdate(room, update, socket, maxDocumentBytes)) return;
            } else throw new Error("unknown Yjs sync message type");
            if (encoding.length(reply) > 1) send(socket, encoding.toUint8Array(reply));
          } else if (messageType === MESSAGE_AWARENESS) {
            const update = decoding.readVarUint8Array(input);
            const records = validateAwarenessUpdate(room, socket, update, maxAwarenessBytes);
            awarenessProtocol.applyAwarenessUpdate(room.awareness, update, socket);
            for (const record of records) {
              if (record.removed && !room.awareness.states.has(record.id)) {
                room.awareness.meta.delete(record.id);
              }
            }
          }
        } catch (error) {
          const closeCode = error?.closeCode ?? 1011;
          if (closeCode === 1011) console.error(`could not handle room ${room.name} message:`, error);
          const reason = closeCode === 1008 ? "awareness policy violation"
            : closeCode === 1009 ? "awareness update too large" : "invalid y-websocket message";
          socket.close(closeCode, reason);
        }
      });
    });
    socket.on("close", () => {
      const controlled = room.controlledIds.get(socket);
      room.controlledIds.delete(socket);
      if (controlled?.size) {
        const ids = [...controlled];
        awarenessProtocol.removeAwarenessStates(room.awareness, ids, socket);
        for (const id of ids) room.awareness.meta.delete(id);
      }
      room.sockets.delete(socket);
      if (room.sockets.size === 0 && rooms.get(room.name) === room) evictRoom(room);
    });

    void room.ready.then(() => {
      send(socket, syncMessage((output) => syncProtocol.writeSyncStep1(output, room.doc)));
      const clients = [...room.awareness.getStates().keys()];
      if (clients.length) {
        send(socket, awarenessMessage(awarenessProtocol.encodeAwarenessUpdate(room.awareness, clients)));
      }
    }).catch((error) => {
      console.error(`could not open room ${room.name}:`, error);
      socket.close(1011, "could not open room");
    });
  });

  httpServer.on("upgrade", (request, socket, head) => {
    let name;
    try { name = roomName(request.url); }
    catch {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    if (socketServer.clients.size >= maxConnections) {
      rejectUpgrade(socket, 503, "Connection Limit Reached");
      return;
    }
    if (!rooms.has(name) && rooms.size >= maxRooms) {
      rejectUpgrade(socket, 503, "Room Limit Reached");
      return;
    }
    socketServer.handleUpgrade(request, socket, head, (websocket) => {
      socketServer.emit("connection", websocket, request, name);
    });
  });

  const keepalive = setInterval(() => {
    for (const socket of socketServer.clients) {
      if (!liveSockets.has(socket)) socket.terminate();
      else {
        liveSockets.delete(socket);
        socket.ping();
      }
    }
  }, KEEPALIVE_INTERVAL_MS);

  await new Promise((resolveReady, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, resolveReady);
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("relay did not bind a TCP port");
  const url = `ws://${host}:${address.port}`;
  let closed = false;

  return {
    url,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(keepalive);
      for (const socket of socketServer.clients) socket.terminate();
      await new Promise((resolveClosed) => socketServer.close(resolveClosed));
      await new Promise((resolveClosed, reject) => {
        httpServer.close((error) => error ? reject(error) : resolveClosed());
      });
      await Promise.all([...rooms.values()].map(async (room) => {
        await room.ready.catch(() => undefined);
        await room.writeChain;
      }));
      for (const room of rooms.values()) {
        room.awareness.destroy();
        room.doc.destroy();
      }
      rooms.clear();
    },
  };
}

function parseArguments(arguments_) {
  const options = { port: 1234, host: "127.0.0.1", persist: null, ...RELAY_DEFAULTS };
  const numericOptions = {
    "--max-message-bytes": "maxMessageBytes",
    "--max-document-bytes": "maxDocumentBytes",
    "--max-awareness-bytes": "maxAwarenessBytes",
    "--max-rooms": "maxRooms",
    "--max-connections": "maxConnections",
  };
  const allowed = ["--port", "--host", "--persist", ...Object.keys(numericOptions)];
  const usage = "Usage: node scripts/cookbook-relay.mjs [--port N] [--host 127.0.0.1] [--persist <dir>] "
    + "[--max-message-bytes N] [--max-document-bytes N] [--max-awareness-bytes N] "
    + "[--max-rooms N] [--max-connections N]";
  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    const value = arguments_[index + 1];
    if (!allowed.includes(option) || value === undefined) throw new Error(usage);
    index += 1;
    if (option === "--port") {
      options.port = Number(value);
      if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
        throw new Error(`Invalid port: ${value}`);
      }
    } else if (option === "--host") options.host = value;
    else if (option === "--persist") options.persist = value;
    else {
      const key = numericOptions[option];
      options[key] = positiveInteger(Number(value), option);
    }
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const relay = await startRelay(parseArguments(process.argv.slice(2)));
    console.log(`listening ${relay.url}`);
    const stop = async () => {
      await relay.close();
      process.exit(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
