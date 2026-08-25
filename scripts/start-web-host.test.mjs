import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { EventEmitter, once } from "node:events";
import { chmod, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildRecipeDatabaseView,
  cacheControlForDistFile,
  contentTypeFor,
  createRequestHandler,
  createRecipeDatabaseIndex,
  createVirtualMapper,
  createVaultWatchRuntime,
  DEFAULT_SETTINGS,
  handleInvoke,
  injectRemoteHostConfig,
  readBody,
  recipeDatabaseStreamEvents,
  resolveDefaultThumbnailCacheRoot,
  resolveHostVaultRoot,
  RustCookingHelperClient,
  VaultWatchSseHub,
  thumbnailCookie,
  thumbnailCacheRootForAppData,
  thumbnailPathForVersion,
  requestUsesSecureTransport,
  thumbnailSize,
  thumbnailUrlForVersion
} from "./start-web-host.mjs";
import settingsDefaults from "../src/settings.defaults.json";

const vaultRoot = "/tmp/mep-vault";

describe("web-host startup log security", () => {
  it("does not print the bearer token", async () => {
    const source = await readFile(new URL("./start-web-host.mjs", import.meta.url), "utf8");
    expect(source).not.toContain("Host token:");
  });
});

async function findFreePort() {
  const probe = http.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  probe.close();
  await once(probe, "close");
  return port;
}

async function createTestServer({ withWatch = false, handlerHost = "127.0.0.1" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mep-web-host-api-"));
  const appDataRoot = path.join(root, "appdata");
  const hostVaultRoot = path.join(root, "vault");
  const mapper = createVirtualMapper({
    appDataRoot,
    vaultRoot: hostVaultRoot
  });
  const watchHub = withWatch ? new VaultWatchSseHub(mapper) : null;
  const watchRuntime = withWatch ? {
    starts: 0,
    async ensureStarted(generation) {
      this.starts += 1;
      if (!watchHub.alive) watchHub.setStatus({ generation: watchHub.generation, alive: true });
      return watchHub.statusSince(generation);
    }
  } : null;
  const port = await findFreePort();
  const server = http.createServer();
  server.on(
    "request",
    createRequestHandler({
      appDataRoot,
      vaultRoot: hostVaultRoot,
      mapper,
      token: "test-host-token",
      host: handlerHost,
      port,
      watchHub,
      watchRuntime
    })
  );
  server.listen(port, "127.0.0.1");
  await once(server, "listening");

  return {
    root,
    port,
    appDataRoot,
    watchHub,
    watchRuntime,
    server,
    async close() {
      server.close();
      await once(server, "close");
      await rm(root, { recursive: true, force: true });
    }
  };
}

function openSse(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/api/watch",
      headers,
      method: "GET"
    });
    req.on("response", (res) => {
      res.setEncoding("utf8");
      const chunks = [];
      res.on("data", (chunk) => {
        chunks.push(chunk);
        if (chunks.length === 1) resolve({ req, res, chunk, chunks });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function request(port, requestPath, { headers = {}, method = "GET", body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method,
        headers
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers,
            status: res.statusCode
          });
        });
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("web-host static serving", () => {
  async function createStaticTestServer(distDir) {
    const root = await mkdtemp(path.join(os.tmpdir(), "mep-web-host-static-"));
    const appDataRoot = path.join(root, "appdata");
    const port = await findFreePort();
    const server = http.createServer();
    server.on(
      "request",
      createRequestHandler({
        appDataRoot,
        vaultRoot: path.join(root, "vault"),
        mapper: createVirtualMapper({ appDataRoot, vaultRoot: path.join(root, "vault") }),
        token: "static-token",
        host: "127.0.0.1",
        port,
        recipeDatabaseIndex: null,
        distDir
      })
    );
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    return {
      port,
      async close() {
        server.close();
        await once(server, "close");
        await rm(root, { recursive: true, force: true });
      }
    };
  }

  async function withStaticDist(run) {
    const root = await mkdtemp(path.join(os.tmpdir(), "mep-web-host-dist-"));
    try {
      const distDir = path.join(root, "dist-web");
      const assetsDir = path.join(distDir, "assets");
      await mkdir(assetsDir, { recursive: true });
      const assetName = "index-a1b2c3d4.js";
      const assetBody = `${"console.log('x');".repeat(200)}\n`;
      await writeFile(path.join(assetsDir, assetName), assetBody);
      await writeFile(
        path.join(distDir, "index.html"),
        `<!doctype html><html><head><script src="/assets/${assetName}"></script></head><body></body></html>\n`
      );
      const server = await createStaticTestServer(distDir);
      try {
        await run({ port: server.port, assetName, assetBody });
      } finally {
        await server.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("answers missing /assets/* requests with 404 instead of the SPA shell", async () => {
    await withStaticDist(async ({ port }) => {
      const response = await request(port, "/assets/missing-abcdef.js");
      expect(response.status).toBe(404);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.body).not.toContain("<!doctype html");
    });
  });

  it("keeps the SPA catch-all for non-asset routes", async () => {
    await withStaticDist(async ({ port }) => {
      const response = await request(port, "/shopping");
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.body).toContain("<!doctype html");
    });
  });

  it("allowlists the injected runtime bootstrap under script-src without unsafe-inline", async () => {
    await withStaticDist(async ({ port }) => {
      const { createHash } = await import("node:crypto");
      const response = await request(port, "/");
      const csp = response.headers["content-security-policy"];
      const scriptSrcDirective = csp.split(";").find((d) => d.trim().startsWith("script-src"));
      expect(scriptSrcDirective).toContain("'self'");
      expect(scriptSrcDirective).not.toContain("unsafe-inline");

      // Recompute the exact bootstrap body the host injects for this token.
      const tokenMatch = response.body.match(/window\.__MEP_REMOTE_HOST__=([\s\S]*?)<\/script>/);
      expect(tokenMatch).toBeTruthy();
      const body = `window.__MEP_REMOTE_HOST__=${tokenMatch[1]}`;
      const expected = `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`;
      expect(csp).toContain(expected);

      const asset = await request(port, "/api/health");
      expect(asset.headers["content-security-policy"]).toContain("script-src 'self'");
    });
  });

  it("sends security headers on static and API responses", async () => {
    await withStaticDist(async ({ port }) => {
      for (const requestPath of ["/", "/api/health"]) {
        const response = await request(port, requestPath);
        expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
        expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
        expect(response.headers["x-content-type-options"]).toBe("nosniff");
        expect(response.headers["referrer-policy"]).toBe("no-referrer");
        expect(response.headers["x-frame-options"]).toBe("DENY");
      }
    });
  });

  it("gzips large compressible responses when the client accepts gzip", async () => {
    await withStaticDist(async ({ port, assetName }) => {
      const compressed = await request(port, `/assets/${assetName}`, {
        headers: { "Accept-Encoding": "gzip" }
      });
      expect(compressed.status).toBe(200);
      expect(compressed.headers["content-encoding"]).toBe("gzip");
      expect(compressed.headers.vary).toContain("Accept-Encoding");

      const identity = await request(port, `/assets/${assetName}`);
      expect(identity.headers["content-encoding"]).toBeUndefined();
      expect(identity.body.length).toBeGreaterThan(1024);
    });
  });

  it("keeps immutable caching for hashed assets and no-store for the shell", async () => {
    await withStaticDist(async ({ port, assetName }) => {
      const asset = await request(port, `/assets/${assetName}`);
      expect(asset.status).toBe(200);
      expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

      const shell = await request(port, "/");
      expect(shell.headers["cache-control"]).toBe("no-store");
    });
  });
});

describe("web-host settings defaults sync", () => {
  it("host DEFAULT_SETTINGS keys match the shared JSON defaults plus vaultPath", () => {
    const jsonKeys = Object.keys(settingsDefaults).sort();
    const hostKeys = Object.keys(DEFAULT_SETTINGS).filter((k) => k !== "vaultPath").sort();
    expect(hostKeys).toEqual(jsonKeys);
  });

  it("uses root-relative cooking paths while retaining shared non-path defaults", () => {
    expect(DEFAULT_SETTINGS.recipesFolder).toBe("cooking/recipes");
    expect(DEFAULT_SETTINGS.imagesFolder).toBe("cooking/recipes/images");
    for (const key of Object.keys(settingsDefaults).filter(
      (entry) => entry !== "recipesFolder" && entry !== "imagesFolder"
    )) {
      expect(DEFAULT_SETTINGS[key]).toEqual(settingsDefaults[key]);
    }
  });

  it("uses one root-level vault default for plain and managed web hosts", () => {
    expect(resolveHostVaultRoot({}, {}, "/home/student")).toBe("/home/student/Enplace");
    expect(
      resolveHostVaultRoot(
        { vault: "/srv/explicit-vault" },
        { MEP_HOST_VAULT_PATH: "/srv/environment-vault" },
        "/home/student"
      )
    ).toBe("/srv/explicit-vault");
    expect(
      resolveHostVaultRoot(
        {},
        { MEP_HOST_VAULT_PATH: "/srv/environment-vault" },
        "/home/student"
      )
    ).toBe("/srv/environment-vault");
  });
});

describe("web-host static cache policy", () => {
  it("treats the dist assets directory as immutable without inspecting filenames", () => {
    expect(cacheControlForDistFile("/tmp/dist/assets/plain-name.js", "/tmp/dist")).toBe("public, max-age=31536000, immutable");
    expect(cacheControlForDistFile("/tmp/dist/index.html", "/tmp/dist")).toBe("no-store");
    expect(cacheControlForDistFile("/tmp/dist/api/data.json", "/tmp/dist")).toBe("no-store");
  });

  it("serves the install manifest with its standard content type", () => {
    expect(contentTypeFor("/tmp/dist/manifest.webmanifest")).toBe(
      "application/manifest+json; charset=utf-8"
    );
  });
});

describe("web-host API authentication", () => {
  it("keeps health available but requires auth for other API routes", async () => {
    const host = await createTestServer();
    try {
      const health = await request(host.port, "/api/health", {
        headers: { Host: `127.0.0.1:${host.port}` }
      });
      const unauthorized = await request(host.port, "/api/fs/exists", {
        method: "POST",
        headers: {
          Host: `127.0.0.1:${host.port}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ path: "/home/vault" })
      });
      const authorized = await request(host.port, "/api/fs/exists", {
        method: "POST",
        headers: {
          Host: `127.0.0.1:${host.port}`,
          Authorization: "Bearer test-host-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ path: "/home/vault" })
      });

      expect(health.status).toBe(200);
      expect(unauthorized.status).toBe(401);
      expect(authorized).toMatchObject({ status: 200, body: '{"exists":false}' });
    } finally {
      await host.close();
    }
  });

  it("returns direct-stat-equivalent metadata with directory inventory", async () => {
    const host = await createTestServer();
    try {
      const vaultRoot = path.join(host.root, "vault");
      await mkdir(vaultRoot, { recursive: true });
      const filePath = path.join(vaultRoot, "recipe.md");
      await writeFile(filePath, "# Recipe\n", "utf8");
      const direct = await import("node:fs/promises").then(({ stat }) => stat(filePath));

      const response = await request(host.port, "/api/fs/read-dir", {
        method: "POST",
        headers: {
          Host: `127.0.0.1:${host.port}`,
          Authorization: "Bearer test-host-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ path: "/home/vault" })
      });

      expect(response.status).toBe(200);
      const payload = JSON.parse(response.body);
      expect(payload.entries).toEqual([
        expect.objectContaining({
          path: "/home/vault/recipe.md",
          name: "recipe.md",
          isFile: true,
          isDirectory: false,
          size: direct.size,
          mtime: direct.mtime.toISOString()
        })
      ]);
    } finally {
      await host.close();
    }
  });

  it("returns ordered text batches from contained vault paths", async () => {
    const host = await createTestServer();
    try {
      const vaultRoot = path.join(host.root, "vault");
      await mkdir(path.join(vaultRoot, "recipes"), { recursive: true });
      await writeFile(path.join(vaultRoot, "recipes", "a.md"), "# A\n", "utf8");
      await writeFile(path.join(vaultRoot, "recipes", "b.md"), "# B\n", "utf8");

      const response = await request(host.port, "/api/fs/read-text-batch", {
        method: "POST",
        headers: {
          Host: `127.0.0.1:${host.port}`,
          Authorization: "Bearer test-host-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          paths: [
            "/home/vault/recipes/b.md",
            "/home/vault/recipes/a.md"
          ]
        })
      });

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        files: [
          { path: "/home/vault/recipes/b.md", content: "# B\n" },
          { path: "/home/vault/recipes/a.md", content: "# A\n" }
        ]
      });
    } finally {
      await host.close();
    }
  });

  it("does not descend hidden directories during recursive inventory except .machine", async () => {
    const host = await createTestServer();
    const hiddenGit = path.join(host.root, "vault", ".git");
    try {
      await mkdir(path.join(hiddenGit, "objects"), { recursive: true });
      await mkdir(path.join(host.root, "vault", ".machine"), { recursive: true });
      await writeFile(path.join(hiddenGit, "objects", "secret"), "secret", "utf8");
      await writeFile(path.join(host.root, "vault", ".machine", "state.json"), "{}", "utf8");
      await chmod(hiddenGit, 0o000);

      const response = await request(host.port, "/api/fs/read-dir", {
        method: "POST",
        headers: {
          Host: `127.0.0.1:${host.port}`,
          Authorization: "Bearer test-host-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ path: "/home/vault", options: { recursive: true } })
      });

      expect(response.status).toBe(200);
      const paths = JSON.stringify(JSON.parse(response.body).entries);
      expect(paths).not.toContain(".git");
      expect(paths).toContain(".machine");
      expect(paths).toContain("state.json");
    } finally {
      await chmod(hiddenGit, 0o700);
      await host.close();
    }
  });

  it("rejects text batch paths outside the configured vault root", async () => {
    const host = await createTestServer();
    try {
      const response = await request(host.port, "/api/fs/read-text-batch", {
        method: "POST",
        headers: {
          Host: `127.0.0.1:${host.port}`,
          Authorization: "Bearer test-host-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          paths: ["/home/vault/../outside.md"]
        })
      });

      expect(response.status).toBe(500);
      expect(response.body).toContain("Path escapes configured root");
    } finally {
      await host.close();
    }
  });

  it("rejects unapproved Host headers before serving health", async () => {
    const host = await createTestServer();
    try {
      const response = await request(host.port, "/api/health", {
        headers: { Host: `attacker.example:${host.port}` }
      });

      expect(response.status).toBe(403);
    } finally {
      await host.close();
    }
  });

  it("accepts a Tailscale Serve host only with proxy identity on a loopback-bound host", async () => {
    const host = await createTestServer();
    try {
      const served = await request(host.port, "/api/health", {
        headers: {
          Host: "mep.example.ts.net",
          "Tailscale-User-Login": "maintainer@example.com"
        }
      });
      const missingIdentity = await request(host.port, "/api/health", {
        headers: { Host: "mep.example.ts.net" }
      });
      const unrelatedHost = await request(host.port, "/api/health", {
        headers: {
          Host: "attacker.example",
          "Tailscale-User-Login": "maintainer@example.com"
        }
      });

      expect(served.status).toBe(200);
      expect(missingIdentity.status).toBe(403);
      expect(unrelatedHost.status).toBe(403);
    } finally {
      await host.close();
    }
  });

  it("rejects Tailscale proxy identity when the host is not loopback-bound", async () => {
    const host = await createTestServer({ handlerHost: "0.0.0.0" });
    try {
      const response = await request(host.port, "/api/health", {
        headers: {
          Host: "mep.example.ts.net",
          "Tailscale-User-Login": "maintainer@example.com"
        }
      });

      expect(response.status).toBe(403);
    } finally {
      await host.close();
    }
  });

  it("injects the host token into the remote-host configuration", () => {
    expect(injectRemoteHostConfig("<html><head></head></html>", "test-host-token")).toContain(
      'token":"test-host-token"'
    );
  });

  it("routes shopping mutations through the single Rust host authority", async () => {
    const calls = [];
    const runtime = {
      shoppingList: async () => ({ revision: 4, items: [] }),
      shoppingPreview: async (...args) => (calls.push(["preview", ...args]), { baseRevision: 4 }),
      shoppingApply: async (...args) => (calls.push(["apply", ...args]), { revision: 5 }),
      shoppingCheck: async (...args) => (calls.push(["check", ...args]), { revision: 6 }),
      shoppingRollback: async (...args) => (calls.push(["rollback", ...args]), { revision: 7 })
    };
    const desiredItems = [{ content: "milk", labels: ["dairy"] }];

    await handleInvoke("/appdata", "/vault", {
      cmd: "mep_shopping_preview",
      args: { weekLabel: "This week", desiredItems }
    }, runtime);
    await handleInvoke("/appdata", "/vault", {
      cmd: "mep_shopping_apply",
      args: { expectedRevision: 4, weekLabel: "This week", desiredItems }
    }, runtime);
    await handleInvoke("/appdata", "/vault", {
      cmd: "mep_shopping_check",
      args: { expectedRevision: 5, itemId: "item-1", checked: true }
    }, runtime);
    await handleInvoke("/appdata", "/vault", {
      cmd: "mep_shopping_rollback",
      args: { expectedRevision: 6 }
    }, runtime);

    expect(calls).toEqual([
      ["preview", "This week", desiredItems],
      ["apply", 4, "This week", desiredItems],
      ["check", 5, "item-1", true],
      ["rollback", 6]
    ]);
  });

  it("rejects request bodies over 64 MiB", async () => {
    async function* oversizedBody() {
      yield Buffer.alloc(64 * 1024 * 1024 + 1);
    }

    await expect(readBody(oversizedBody())).rejects.toMatchObject({
      message: "Request body too large.",
      statusCode: 413
    });
  });
});

describe("web-host vault watcher SSE", () => {
  it("invalidates the recipe index from raw helper events before publishing SSE", () => {
    const mapper = createVirtualMapper({ appDataRoot: "/tmp/mep-appdata", vaultRoot });
    const hub = new VaultWatchSseHub(mapper);
    const batches = [];
    const helper = {
      onWatch(listener) {
        this.listener = listener;
      },
      onWatchFailure() {}
    };
    const recipeDatabaseIndex = {
      invalidate(batch) {
        batches.push(batch);
      }
    };
    createVaultWatchRuntime({ vaultRoot, helper, watchHub: hub, recipeDatabaseIndex });
    const batch = {
      generation: 1,
      alive: true,
      events: [{ kind: "modify", path: path.join(vaultRoot, "recipes", "dish.md") }]
    };

    helper.listener(batch);

    expect(batches).toEqual([batch]);
    expect(hub.generation).toBe(1);
  });

  it("requires bearer authentication and reports generation resume state", async () => {
    const host = await createTestServer({ withWatch: true });
    try {
      host.watchHub.setStatus({ generation: 7, alive: true });
      const unauthorized = await request(host.port, "/api/watch");
      expect(unauthorized.status).toBe(401);

      const stream = await openSse(host.port, {
        Authorization: "Bearer test-host-token",
        "Last-Event-ID": "5"
      });
      expect(stream.res.statusCode).toBe(200);
      expect(stream.res.headers["content-type"]).toContain("text/event-stream");
      expect(stream.chunk).toContain("id: 7");
      expect(stream.chunk).toContain('"generation":7');
      expect(stream.chunk).toContain('"alive":true');
      expect(stream.chunk).toContain('"changed":true');
      stream.req.destroy();
    } finally {
      host.watchHub.close();
      await host.close();
    }
  });

  it("maps helper paths, delivers batches, and exposes explicit failure state", async () => {
    const host = await createTestServer({ withWatch: true });
    try {
      host.watchHub.setStatus({ generation: 2, alive: true });
      const stream = await openSse(host.port, {
        Authorization: "Bearer test-host-token",
        "Last-Event-ID": "2"
      });
      const delivered = new Promise((resolve) => stream.res.once("data", resolve));
      host.watchHub.publish({
        generation: 3,
        alive: true,
        events: [{
          kind: "create",
          path: path.join(host.root, "vault", "inbox", "job.json"),
          oldPath: null,
          subscriptions: ["vault", "inbox"]
        }]
      });
      host.watchHub.fail();
      await delivered;

      const payload = stream.chunks.join("");
      expect(payload).toContain('"generation":3');
      expect(payload).toContain('"path":"/home/vault/inbox/job.json"');
      expect(payload).toContain('"subscriptions":["vault","inbox"]');
      expect(payload).toContain('"alive":false');
      expect(host.watchHub.statusSince(2)).toEqual({
        generation: 3,
        alive: false,
        changed: true
      });
      stream.req.destroy();
    } finally {
      host.watchHub.close();
      await host.close();
    }
  });

  it("destroys and evicts a client as soon as an SSE write backpressures", () => {
    class Response extends EventEmitter {
      writable = true;
      destroyed = false;
      writeHead() {}
      write() {
        return this.writable;
      }
      destroy() {
        this.destroyed = true;
        this.emit("close");
      }
      end() {}
    }

    const mapper = createVirtualMapper({
      appDataRoot: "/tmp/mep-appdata",
      vaultRoot
    });
    const hub = new VaultWatchSseHub(mapper);
    hub.setStatus({ generation: 0, alive: true });
    const response = new Response();
    hub.attach(new EventEmitter(), response, 0);
    expect(hub.clients.size).toBe(1);

    response.writable = false;
    hub.publish({
      generation: 1,
      alive: true,
      events: [{
        kind: "create",
        path: path.join(vaultRoot, "inbox", "job.json"),
        oldPath: null,
        subscriptions: ["vault", "inbox"]
      }]
    });

    expect(response.destroyed).toBe(true);
    expect(hub.clients.size).toBe(0);
  });
});

describe("remote Rust cooking helper", () => {
  async function createHelper(source) {
    const root = await mkdtemp(path.join(os.tmpdir(), "mep-helper-client-"));
    const command = path.join(root, "helper.mjs");
    await writeFile(command, `#!/usr/bin/env node\n${source}\n`, "utf8");
    await chmod(command, 0o755);
    return { root, command };
  }

  it("keeps the authenticated command on a long-lived stdio child", async () => {
    const helper = await createHelper(`
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        for (const line of chunk.split("\\n").filter(Boolean)) {
          const request = JSON.parse(line);
          const response = request.type === "hello"
            ? { type: "hello", ok: true }
            : { id: request.id, ok: true, result: [{ content: "onion", labels: [] }] };
          process.stdout.write(JSON.stringify(response) + "\\n");
        }
      });
    `);
    const client = new RustCookingHelperClient({ command: helper.command, configDir: "/fixed/.mep", token: "secret" });
    try {
      await expect(client.buildDesiredItems([])).resolves.toEqual([{ content: "onion", labels: [] }]);
    } finally {
      client.stop();
      await rm(helper.root, { recursive: true, force: true });
    }
  });

  it("restarts a failed helper watcher with a monotonic host generation", async () => {
    const helper = await createHelper(`
      const fs = await import("node:fs");
      const path = await import("node:path");
      const actualCounterPath = path.join(path.dirname(process.argv[1]), "runs");
      const run = fs.existsSync(actualCounterPath)
        ? Number(fs.readFileSync(actualCounterPath, "utf8")) + 1
        : 1;
      fs.writeFileSync(actualCounterPath, String(run));
      let buffer = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const request = JSON.parse(line);
          if (request.type === "hello") {
            process.stdout.write(JSON.stringify({ type: "hello", ok: true }) + "\\n");
            continue;
          }
          if (request.command === "watch_start") {
            process.stdout.write(JSON.stringify({
              id: request.id,
              ok: true,
              result: { generation: 0, alive: true, changed: false }
            }) + "\\n");
            process.stdout.write(JSON.stringify({
              type: "watch",
              batch: {
                generation: 1,
                alive: true,
                events: [{
                  kind: "create",
                  path: request.payload.root + "/inbox/job-" + run + ".json",
                  oldPath: null,
                  subscriptions: ["vault", "inbox"]
                }]
              }
            }) + "\\n");
          }
        }
      });
    `);
    const hostRoot = path.join(helper.root, "vault");
    await mkdir(hostRoot, { recursive: true });
    const mapper = createVirtualMapper({
      appDataRoot: path.join(helper.root, "appdata"),
      vaultRoot: hostRoot
    });
    const client = new RustCookingHelperClient({
      command: helper.command,
      configDir: path.join(helper.root, "config"),
      token: "secret"
    });
    const hub = new VaultWatchSseHub(mapper);
    const runtime = createVaultWatchRuntime({
      vaultRoot: hostRoot,
      mapper,
      helper: client,
      watchHub: hub,
      hostSettings: {
        inboxFolder: "inbox",
        archiveFolder: "inbox/archive"
      }
    });
    const nextBatch = () => new Promise((resolve) => {
      const off = client.onWatch((batch) => {
        off();
        resolve(batch);
      });
    });

    try {
      const firstBatch = nextBatch();
      await runtime.ensureStarted(0, "inbox", "inbox/archive");
      await firstBatch;
      expect(hub.statusSince(0)).toEqual({
        generation: 1,
        alive: true,
        changed: true
      });

      const failed = new Promise((resolve) => {
        const off = client.onWatchFailure((error) => {
          off();
          resolve(error);
        });
      });
      client.child.kill();
      await failed;
      expect(hub.statusSince(1)).toEqual({
        generation: 1,
        alive: false,
        changed: false
      });

      const secondBatch = nextBatch();
      await runtime.ensureStarted(1, "inbox", "inbox/archive");
      await secondBatch;
      expect(await readFile(path.join(helper.root, "runs"), "utf8")).toBe("2");
      expect(hub.statusSince(1)).toEqual({
        generation: 2,
        alive: true,
        changed: true
      });
    } finally {
      client.stop();
      hub.close();
      await rm(helper.root, { recursive: true, force: true });
    }
  });

  it("validates versioned thumbnail responses from the Rust helper", async () => {
    const helper = await createHelper(`
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        for (const line of chunk.split("\\n").filter(Boolean)) {
          const request = JSON.parse(line);
          const response = request.type === "hello"
            ? { type: "hello", ok: true }
            : { id: request.id, ok: true, result: { version: "v4-320-${"a".repeat(64)}" } };
          process.stdout.write(JSON.stringify(response) + "\\n");
        }
      });
    `);
    const client = new RustCookingHelperClient({ command: helper.command, configDir: "/fixed/.mep", token: "secret" });
    try {
      await expect(client.createThumbnail("/home/vault/recipes/cover.png", 320)).resolves.toEqual({
        version: `v4-320-${"a".repeat(64)}`,
        extension: "jpg"
      });
    } finally {
      client.stop();
      await rm(helper.root, { recursive: true, force: true });
    }
  });

  it("validates ordered thumbnail batches while preserving individual failures", async () => {
    const helper = await createHelper(`
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        for (const line of chunk.split("\\n").filter(Boolean)) {
          const request = JSON.parse(line);
          const response = request.type === "hello"
            ? { type: "hello", ok: true }
            : { id: request.id, ok: true, result: [
              { thumbnail: { version: "v4-320-${"a".repeat(64)}" }, error: null },
              { thumbnail: null, error: "missing" }
            ] };
          process.stdout.write(JSON.stringify(response) + "\\n");
        }
      });
    `);
    const client = new RustCookingHelperClient({ command: helper.command, configDir: "/fixed/.mep", token: "secret" });
    try {
      await expect(client.createThumbnails(["/home/vault/one.png", "/home/vault/missing.png"], 320)).resolves.toEqual([
        { version: `v4-320-${"a".repeat(64)}`, extension: "jpg" },
        null
      ]);
    } finally {
      client.stop();
      await rm(helper.root, { recursive: true, force: true });
    }
  });

  it("validates database thumbnail preparation through the helper contract", async () => {
    const helper = await createHelper(`
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        for (const line of chunk.split("\\n").filter(Boolean)) {
          const request = JSON.parse(line);
          const response = request.type === "hello"
            ? { type: "hello", ok: true }
            : { id: request.id, ok: true, result: [{ thumbnail: { version: "v4-320-${"a".repeat(64)}" }, error: null }] };
          process.stdout.write(JSON.stringify(response) + "\\n");
        }
      });
    `);
    const client = new RustCookingHelperClient({ command: helper.command, configDir: "/fixed/.mep", token: "secret" });
    try {
      await expect(client.prepareDatabaseThumbnails(["/home/vault/one.png"])).resolves.toEqual([
        { version: `v4-320-${"a".repeat(64)}`, extension: "jpg" }
      ]);
    } finally {
      client.stop();
      await rm(helper.root, { recursive: true, force: true });
    }
  });

  it("rejects malformed helper output and clears the failed child", async () => {
    const helper = await createHelper(`
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", () => process.stdout.write("not-json\\n"));
    `);
    const client = new RustCookingHelperClient({ command: helper.command, configDir: "/fixed/.mep" });
    try {
      await expect(client.buildDesiredItems([])).rejects.toThrow("Malformed Rust cooking helper response");
      expect(client.child).toBeNull();
    } finally {
      client.stop();
      await rm(helper.root, { recursive: true, force: true });
    }
  });

  it("rejects oversized frames before writing to the child", async () => {
    const helper = await createHelper(`process.stdin.resume();`);
    const client = new RustCookingHelperClient({ command: helper.command, configDir: "/fixed/.mep" });
    try {
      await expect(client.buildDesiredItems([{ path: "x", title: "x", markdown: "x".repeat(2 * 1024 * 1024) }]))
        .rejects.toThrow("Cooking helper request too large");
    } finally {
      client.stop();
      await rm(helper.root, { recursive: true, force: true });
    }
  });
});

describe("web-host recipe database invoke support", () => {
  it("reflects same-host write, rename, and remove before each mutation response returns", async () => {
    const host = await createTestServer();
    const headers = {
      Host: `127.0.0.1:${host.port}`,
      Authorization: "Bearer test-host-token",
      "Content-Type": "application/json"
    };
    const invoke = (query) => request(host.port, "/api/invoke", {
      method: "POST",
      headers,
      body: JSON.stringify({ cmd: "mep_recipe_database_stream", args: { query } })
    });
    const fsMutation = (operation, payload) => request(host.port, `/api/fs/${operation}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });
    try {
      const oldPath = "/home/vault/recipes/dish.md";
      const newPath = "/home/vault/recipes/renamed-dish.md";
      const alpha = "---\ntype: recipe\ntitle: Alpha\n---\n";
      const beta = "---\ntype: recipe\ntitle: Beta\n---\n";
      expect((await fsMutation("write-text", { path: oldPath, content: alpha })).status).toBe(200);
      expect((await invoke({ recipesFolder: "recipes", search: "Alpha" })).body).toContain("Alpha");

      expect((await fsMutation("write-text", { path: oldPath, content: beta })).status).toBe(200);
      expect((await invoke({ recipesFolder: "recipes", search: "Beta" })).body).toContain("Beta");

      expect((await fsMutation("rename", { oldPath, newPath })).status).toBe(200);
      const renamed = JSON.parse((await invoke({ recipesFolder: "recipes" })).body);
      expect(renamed.events[1].data.items[0].path).toBe("recipes/renamed-dish.md");

      expect((await fsMutation("remove", { path: newPath })).status).toBe(200);
      const removed = JSON.parse((await invoke({ recipesFolder: "recipes" })).body);
      expect(removed.events[0].data.total).toBe(0);
    } finally {
      await host.close();
    }
  });

  it("invalidates cached descendants for same-host directory mutations but not image writes", async () => {
    const host = await createTestServer();
    const headers = {
      Host: `127.0.0.1:${host.port}`,
      Authorization: "Bearer test-host-token",
      "Content-Type": "application/json"
    };
    const invoke = () => request(host.port, "/api/invoke", {
      method: "POST",
      headers,
      body: JSON.stringify({
        cmd: "mep_recipe_database_stream",
        args: { query: { recipesFolder: "recipes" } }
      })
    });
    const fsMutation = (operation, payload) => request(host.port, `/api/fs/${operation}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });
    try {
      const oldFolder = "/home/vault/recipes/old";
      const newFolder = "/home/vault/recipes/new";
      const recipePath = `${oldFolder}/dish.md`;
      await fsMutation("write-text", {
        path: recipePath,
        content: "---\ntype: recipe\ntitle: Dish\ncover: recipes/images/dish.jpg\n---\n"
      });
      expect(JSON.parse((await invoke()).body).events[1].data.items[0].path).toBe("recipes/old/dish.md");

      expect((await fsMutation("write-file", {
        path: "/home/vault/recipes/images/dish.jpg",
        dataBase64: Buffer.from("image").toString("base64")
      })).status).toBe(200);
      expect(JSON.parse((await invoke()).body).events[1].data.items[0].path).toBe("recipes/old/dish.md");

      expect((await fsMutation("rename", { oldPath: oldFolder, newPath: newFolder })).status).toBe(200);
      expect(JSON.parse((await invoke()).body).events[1].data.items[0].path).toBe("recipes/new/dish.md");

      expect((await fsMutation("remove", { path: newFolder, options: { recursive: true } })).status).toBe(200);
      expect(JSON.parse((await invoke()).body).events[0].data.total).toBe(0);
    } finally {
      await host.close();
    }
  });

  it("reuses the parsed recipe index across searches and invalidates only for recipe events", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mep-web-host-index-"));
    const recipesRoot = path.join(root, "recipes");
    try {
      await mkdir(path.join(recipesRoot, "images"), { recursive: true });
      const recipePath = path.join(recipesRoot, "dish.md");
      const unrelatedPath = path.join(root, "notes.md");
      await writeFile(recipePath, "---\ntype: recipe\ntitle: Alpha\n---\n", "utf8");
      await writeFile(unrelatedPath, "---\ntype: note\ntitle: Note\n---\n", "utf8");

      const index = createRecipeDatabaseIndex(root);
      expect((await index.view({ recipesFolder: "recipes", search: "Alpha" })).total).toBe(1);

      await writeFile(recipePath, "---\ntype: recipe\ntitle: Beta\n---\n", "utf8");
      expect((await index.view({ recipesFolder: "recipes", search: "Alpha" })).total).toBe(1);
      expect((await index.view({ recipesFolder: "recipes", search: "Beta" })).total).toBe(0);

      expect(index.invalidate({ events: [{ kind: "modify", path: unrelatedPath }] })).toBe(false);
      expect((await index.view({ recipesFolder: "recipes", search: "Alpha" })).total).toBe(1);

      expect(index.invalidate({ events: [{ kind: "modify", path: recipePath }] })).toBe(true);
      expect((await index.view({ recipesFolder: "recipes", search: "Beta" })).total).toBe(1);
      expect((await index.view({ recipesFolder: "recipes", search: "Alpha" })).total).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("invalidates a renamed recipe using both sides of the watch event", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mep-web-host-index-"));
    const recipesRoot = path.join(root, "recipes");
    try {
      await mkdir(recipesRoot, { recursive: true });
      const oldPath = path.join(recipesRoot, "alpha.md");
      const newPath = path.join(recipesRoot, "beta.md");
      await writeFile(oldPath, "---\ntype: recipe\ntitle: Alpha\n---\n", "utf8");
      const index = createRecipeDatabaseIndex(root);
      expect((await index.view({ recipesFolder: "recipes" })).items[0].title).toBe("Alpha");
      await rename(oldPath, newPath);
      expect(index.invalidate({ events: [{ kind: "rename", oldPath, path: newPath }] })).toBe(true);
      expect((await index.view({ recipesFolder: "recipes" })).items[0].path).toBe("recipes/beta.md");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("invalidates directory descendants from raw watcher events without invalidating images", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mep-web-host-index-"));
    const recipesRoot = path.join(root, "recipes");
    try {
      const oldFolder = path.join(recipesRoot, "old");
      const newFolder = path.join(recipesRoot, "new");
      const recipePath = path.join(oldFolder, "dish.md");
      await mkdir(oldFolder, { recursive: true });
      await writeFile(recipePath, "---\ntype: recipe\ntitle: Dish\n---\n", "utf8");
      const index = createRecipeDatabaseIndex(root);
      expect((await index.view({ recipesFolder: "recipes" })).total).toBe(1);

      expect(index.invalidate({
        events: [{ kind: "modify", path: path.join(recipesRoot, "images", "dish.jpg") }]
      })).toBe(false);
      expect((await index.view({ recipesFolder: "recipes" })).total).toBe(1);

      await rename(oldFolder, newFolder);
      expect(index.invalidate({
        events: [{ kind: "rename", oldPath: oldFolder, path: newFolder }]
      })).toBe(true);
      expect((await index.view({ recipesFolder: "recipes" })).items[0].path).toBe("recipes/new/dish.md");

      await rm(newFolder, { recursive: true });
      expect(index.invalidate({
        events: [{ kind: "remove", path: newFolder }]
      })).toBe(true);
      expect((await index.view({ recipesFolder: "recipes" })).total).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not publish an in-flight build after a recipe event invalidates it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mep-web-host-index-"));
    const recipesRoot = path.join(root, "recipes");
    try {
      await mkdir(recipesRoot, { recursive: true });
      for (let index = 0; index < 200; index += 1) {
        await writeFile(
          path.join(recipesRoot, `recipe-${index}.md`),
          `---\ntype: recipe\ntitle: Recipe ${index}\n---\n`,
          "utf8"
        );
      }
      const changedPath = path.join(recipesRoot, "recipe-0.md");
      const database = createRecipeDatabaseIndex(root);
      const pending = database.view({ recipesFolder: "recipes", search: "Updated" });
      await Promise.resolve();
      await writeFile(changedPath, "---\ntype: recipe\ntitle: Updated\n---\n", "utf8");
      expect(database.invalidate({ events: [{ kind: "modify", path: "recipes/recipe-0.md" }] })).toBe(true);
      await pending;
      expect((await database.view({ recipesFolder: "recipes", search: "Updated" })).total).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps concurrent folder queries finite and retries a failed initial build", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mep-web-host-index-"));
    try {
      await mkdir(path.join(root, "first"), { recursive: true });
      await mkdir(path.join(root, "second"), { recursive: true });
      await writeFile(path.join(root, "first", "dish.md"), "---\ntype: recipe\ntitle: First\n---\n", "utf8");
      await writeFile(path.join(root, "second", "dish.md"), "---\ntype: recipe\ntitle: Second\n---\n", "utf8");
      const index = createRecipeDatabaseIndex(root);
      const first = index.view({ recipesFolder: "first" });
      const second = await index.view({ recipesFolder: "second" });
      expect((await first).items[0].title).toBe("First");
      expect(second.items[0].title).toBe("Second");

      const missing = createRecipeDatabaseIndex(root);
      await expect(missing.view({ recipesFolder: "later" })).rejects.toThrow();
      await mkdir(path.join(root, "later"), { recursive: true });
      await writeFile(path.join(root, "later", "dish.md"), "---\ntype: recipe\ntitle: Later\n---\n", "utf8");
      expect((await missing.view({ recipesFolder: "later" })).items[0].title).toBe("Later");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a missing configured recipe source instead of returning an empty collection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mep-web-host-"));
    try {
      await expect(
        buildRecipeDatabaseView(root, { recipesFolder: "cooking/recipes" })
      ).rejects.toThrow(
        "Configured recipe source 'cooking/recipes' does not exist under the current vault root."
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports an invalid configured recipe source contextually", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mep-web-host-"));
    try {
      await mkdir(path.join(root, "cooking"), { recursive: true });
      await writeFile(path.join(root, "cooking", "recipes"), "not a directory", "utf8");
      await expect(
        buildRecipeDatabaseView(root, { recipesFolder: "cooking/recipes" })
      ).rejects.toThrow(
        "Configured recipe source 'cooking/recipes' is not a directory."
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports an unreadable configured recipe source contextually", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mep-web-host-"));
    const recipesRoot = path.join(root, "cooking", "recipes");
    try {
      await mkdir(recipesRoot, { recursive: true });
      await chmod(recipesRoot, 0o000);
      await expect(
        buildRecipeDatabaseView(root, { recipesFolder: "cooking/recipes" })
      ).rejects.toThrow("Failed to read configured recipe source 'cooking/recipes'");
    } finally {
      await chmod(recipesRoot, 0o700);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains an existing empty recipe source as a legitimate empty collection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mep-web-host-"));
    try {
      await mkdir(path.join(root, "cooking", "recipes"), { recursive: true });
      await expect(
        buildRecipeDatabaseView(root, { recipesFolder: "cooking/recipes" })
      ).resolves.toEqual({
        items: [],
        total: 0,
        availableTags: [],
        markedCount: 0,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("builds recipe database cards from markdown frontmatter without reading cover files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mep-web-host-"));
    await mkdir(path.join(root, "recipes", "images"), { recursive: true });
    await writeFile(
      path.join(root, "recipes", "alpha.md"),
      [
        "---",
        "type: recipe",
        "title: Alpha Soup",
        "cover: recipes/images/alpha.jpg",
        "marked: true",
        "added: 2026-01-02",
        "scheduledDates:",
        "  - 2026-01-05",
        "tags: [soup, quick]",
        "---",
        "",
        "Body"
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(root, "recipes", "note.md"),
      "---\ntype: note\ntitle: Ignore me\n---\n",
      "utf8"
    );

    const view = await buildRecipeDatabaseView(root, {
      recipesFolder: "recipes",
      filter: { marked: true },
      sortBy: "title-asc"
    });

    expect(view.items).toHaveLength(1);
    expect(view.items[0]).toMatchObject({
      path: "recipes/alpha.md",
      title: "Alpha Soup",
      coverPath: "recipes/images/alpha.jpg",
      marked: true,
      scheduled: "2026-01-05",
      tags: ["soup", "quick"]
    });
    expect(view.markedCount).toBe(1);
    expect(view.availableTags).toEqual(["quick", "soup"]);
  });

  it("serializes recipe database stream events for the remote shim channel", () => {
    const events = recipeDatabaseStreamEvents({
      items: [{ path: "recipes/a.md", title: "A" }],
      total: 1,
      markedCount: 0,
      availableTags: ["dinner"]
    });

    expect(events).toEqual([
      { event: "started", data: { total: 1 } },
      { event: "batch", data: { items: [{ path: "recipes/a.md", title: "A" }], offset: 0 } },
      {
        event: "done",
        data: { totalCount: 1, markedCount: 0, availableTags: ["dinner"] }
      }
    ]);
  });

  it("keeps stream totals independent from limited streamed items", () => {
    const events = recipeDatabaseStreamEvents({
      items: [{ path: "recipes/a.md", title: "A" }],
      total: 125,
      markedCount: 4,
      availableTags: ["dinner"]
    });

    expect(events[0]).toEqual({ event: "started", data: { total: 125 } });
    expect(events.at(-1)).toEqual({
      event: "done",
      data: { totalCount: 125, markedCount: 4, availableTags: ["dinner"] }
    });
  });

  it("serializes empty recipe database streams without stale batches", () => {
    const events = recipeDatabaseStreamEvents({
      items: [],
      total: 0,
      markedCount: 0,
      availableTags: []
    });

    expect(events).toEqual([
      { event: "started", data: { total: 0 } },
      { event: "done", data: { totalCount: 0, markedCount: 0, availableTags: [] } }
    ]);
  });
});

describe("web-host shared thumbnail cache root", () => {
  const originalXdgDataHome = process.env.XDG_DATA_HOME;

  afterEach(() => {
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
  });

  it("defaults to the native app identifier under XDG_DATA_HOME when set", () => {
    process.env.XDG_DATA_HOME = "/tmp/xdg-data-home";
    expect(resolveDefaultThumbnailCacheRoot()).toBe(
      path.join("/tmp/xdg-data-home", "com.mise.en.place")
    );
  });

  it("falls back to ~/.local/share when XDG_DATA_HOME is unset", () => {
    delete process.env.XDG_DATA_HOME;
    expect(resolveDefaultThumbnailCacheRoot()).toBe(
      path.join(os.homedir(), ".local", "share", "com.mise.en.place")
    );
  });

  it("serves thumbnails from an explicit cache root distinct from app-data settings storage", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mep-web-host-shared-cache-"));
    const appDataRoot = path.join(root, "appdata");
    const thumbnailCacheRoot = path.join(root, "native-appdata");
    const vaultRoot = path.join(root, "vault");
    const version = `v4-320-${"b".repeat(64)}`;
    try {
      await mkdir(path.join(thumbnailCacheRoot, "thumbnails", "v4"), { recursive: true });
      await writeFile(
        path.join(thumbnailCacheRoot, "thumbnails", "v4", `${version}.jpg`),
        "shared-thumbnail-bytes"
      );

      const port = await findFreePort();
      const server = http.createServer();
      server.on(
        "request",
        createRequestHandler({
          appDataRoot,
          vaultRoot,
          mapper: createVirtualMapper({ appDataRoot, vaultRoot }),
          token: "shared-cache-token",
          host: "127.0.0.1",
          port,
          thumbnailCacheRoot
        })
      );
      server.listen(port, "127.0.0.1");
      await once(server, "listening");

      try {
        const response = await request(port, `/api/thumbnail/${version}.jpg`, {
          headers: { Authorization: "Bearer shared-cache-token" }
        });
        expect(response.status).toBe(200);
        expect(response.body).toBe("shared-thumbnail-bytes");

        // Nothing should have been written into appDataRoot's own thumbnail path.
        await expect(
          readFile(path.join(appDataRoot, "thumbnails", "v4", `${version}.jpg`), "utf8")
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        server.close();
        await once(server, "close");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("web-host thumbnail invoke support", () => {
  const version = `v4-320-${"a".repeat(64)}`;

  it("returns opaque immutable URLs and accepts only the supported variants", () => {
    expect(thumbnailUrlForVersion(version)).toBe(`/api/thumbnail/${version}.jpg`);
    expect(thumbnailSize("card")).toBe(320);
    expect(thumbnailSize("detail")).toBe(640);
    expect(() => thumbnailUrlForVersion("../../source.jpg")).toThrow("Invalid thumbnail version");
    expect(() => thumbnailSize("original")).toThrow("Thumbnail size must be card or detail");
    expect(thumbnailCacheRootForAppData("/tmp/mep-appdata")).toBe("/tmp/mep-appdata");
    expect(thumbnailPathForVersion("/tmp/mep-appdata", version)).toBe(
      `/tmp/mep-appdata/thumbnails/v4/${version}.jpg`
    );
    expect(thumbnailCookie("token", true)).toContain("; Secure");
    expect(requestUsesSecureTransport({ headers: { "x-forwarded-proto": "https" }, socket: {} })).toBe(true);
  });

  it("creates an opaque URL through the helper without exposing the source path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mep-thumbnail-source-"));
    try {
      await mkdir(path.join(root, "recipes", "images"), { recursive: true });
      await writeFile(path.join(root, "recipes", "images", "alpha.jpg"), "image");
      const result = await handleInvoke("/tmp/appdata", root, {
        cmd: "mep_get_thumbnail",
        args: { path: "recipes/images/alpha.jpg", size: "card" }
      }, {
        createThumbnail: async () => ({ version })
      });
      expect(result).toBe(`/api/thumbnail/${version}.jpg`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps an ordered helper thumbnail batch to opaque URLs without failing successful siblings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mep-thumbnail-source-"));
    try {
      await mkdir(path.join(root, "recipes", "images"), { recursive: true });
      await writeFile(path.join(root, "recipes", "images", "alpha.jpg"), "image");
      await writeFile(path.join(root, "recipes", "images", "missing.jpg"), "image");
      const result = await handleInvoke("/tmp/appdata", root, {
        cmd: "mep_get_thumbnails",
        args: { paths: ["recipes/images/alpha.jpg", "recipes/images/missing.jpg"], size: "card" }
      }, {
        createThumbnails: async () => [{ version }, null]
      });
      expect(result).toEqual([`/api/thumbnail/${version}.jpg`, null]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps database thumbnail preparation to ordered opaque card URLs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mep-thumbnail-source-"));
    try {
      await mkdir(path.join(root, "recipes", "images"), { recursive: true });
      await writeFile(path.join(root, "recipes", "images", "alpha.jpg"), "image");
      const result = await handleInvoke("/tmp/appdata", root, {
        cmd: "mep_prepare_database_thumbnails",
        args: { paths: ["recipes/images/alpha.jpg"] }
      }, {
        prepareDatabaseThumbnails: async () => [{ version }]
      });
      expect(result).toEqual([`/api/thumbnail/${version}.jpg`]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serves only generated JPEGs to direct images with cookie or bearer authentication", async () => {
    const host = await createTestServer();
    const thumbnailPath = path.join(host.appDataRoot, "thumbnails", "v4", `${version}.jpg`);
    try {
      await mkdir(path.dirname(thumbnailPath), { recursive: true });
      await writeFile(thumbnailPath, "thumbnail-bytes");
      const endpoint = `/api/thumbnail/${version}.jpg`;
      expect((await request(host.port, endpoint)).status).toBe(401);

      const bearer = await request(host.port, endpoint, {
        headers: { Authorization: "Bearer test-host-token" }
      });
      expect(bearer.status).toBe(200);
      expect(bearer.body).toBe("thumbnail-bytes");
      expect(bearer.headers["content-type"]).toBe("image/jpeg");
      expect(bearer.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
      expect(bearer.headers.vary).toBe("Cookie");

      const cookie = await request(host.port, endpoint, {
        headers: { Cookie: thumbnailCookie("test-host-token").split(";")[0] }
      });
      expect(cookie.status).toBe(200);
      expect(cookie.body).toBe("thumbnail-bytes");
    } finally {
      await host.close();
    }
  });
});
