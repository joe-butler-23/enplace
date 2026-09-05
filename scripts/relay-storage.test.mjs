import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import * as Y from 'yjs';

let runtime;
beforeAll(async () => {
  const bundle = await build({
    stdin: { contents: `
      import relay, { Kitchen as ProductionKitchen } from './relay/src/index.ts';
      export class Kitchen extends ProductionKitchen {
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
          return super.fetch(request);
        }
      }
      export default {
        fetch(request, env) {
          const url = new URL(request.url);
          if (url.pathname === '/seed' || url.pathname === '/stored') {
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
      env: { Kitchen: { type: 'durable-object', worker: 'relay-test', exportName: 'Kitchen' } },
      exports: { Kitchen: { type: 'durable-object', storage: 'sqlite' } },
    } }],
  });
  await runtime.ready;
}, 30_000);
afterAll(async () => { await runtime?.dispose(); });

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
  const stored = await (await runtime.dispatchFetch(`http://relay/stored?id=${id}`)).json();
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
