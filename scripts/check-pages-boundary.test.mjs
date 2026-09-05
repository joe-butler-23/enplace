import { afterAll, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertBoundaryHeaders, assertGeneratedLink, resolveInstalledWrangler, withWranglerProcess } from "./check-pages-boundary.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "enplace-pages-process-"));
afterAll(() => rm(root, { recursive: true, force: true }));
async function fake(name, contents) {
  const bin = path.join(root, name);
  await writeFile(bin, `#!/usr/bin/env node\n${contents}`);
  await chmod(bin, 0o755);
  return bin;
}

it("rejects a fake ready server without the Wrangler banner and kills it", async () => {
  const bin = await fake("ready.mjs", `
    import { writeFileSync } from "node:fs";
    import net from "node:net";
    process.on("SIGTERM", () => { writeFileSync(process.env.MARKER, "killed"); process.exit(0); });
    net.createServer().listen(0, "127.0.0.1", () => console.log("Ready on http://127.0.0.1:9999"));
  `);
  const marker = path.join(root, "marker");
  process.env.MARKER = marker;
  await expect(withWranglerProcess({ bin, directory: ".", version: "1.2.3", readinessMs: 1_000 }, () => {}))
    .rejects.toThrow("readiness deadline");
  expect(await readFile(marker, "utf8")).toBe("killed");
});

it("reports an early exit and leaves no process behind", async () => {
  const bin = await fake("exit.mjs", `
    import { writeFileSync } from "node:fs";
    writeFileSync(process.env.PID_FILE, String(process.pid));
    process.exit(19);
  `);
  const pidFile = path.join(root, "pid");
  process.env.PID_FILE = pidFile;
  await expect(withWranglerProcess({ bin, directory: ".", version: "1.2.3", readinessMs: 1_000 }, () => {}))
    .rejects.toThrow("exited 19");
  const pid = Number(await readFile(pidFile, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
});

it("rejects an impostor shim even when it prints a matching banner and readiness", async () => {
  const fixture = path.join(root, "installation");
  await mkdir(path.join(fixture, "node_modules/wrangler/bin"), { recursive: true });
  await mkdir(path.join(fixture, "node_modules/.bin"), { recursive: true });
  await writeFile(path.join(fixture, "package.json"), JSON.stringify({ devDependencies: { wrangler: "1.2.3" } }));
  await writeFile(path.join(fixture, "package-lock.json"), JSON.stringify({ packages: {
    "": { devDependencies: { wrangler: "1.2.3" } }, "node_modules/wrangler": { version: "1.2.3" },
  } }));
  await writeFile(path.join(fixture, "node_modules/wrangler/package.json"), JSON.stringify({
    version: "1.2.3", bin: { wrangler: "bin/wrangler.js" },
  }));
  await writeFile(path.join(fixture, "node_modules/wrangler/bin/wrangler.js"), "canonical");
  const impostor = path.join(fixture, "impostor");
  await writeFile(impostor, '#!/usr/bin/env node\nimport net from "node:net"; console.log("wrangler 1.2.3"); net.createServer().listen(0, "127.0.0.1", () => console.log("Ready on http://127.0.0.1:9999"));');
  await chmod(impostor, 0o755);
  await symlink(impostor, path.join(fixture, "node_modules/.bin/wrangler"));
  await expect(resolveInstalledWrangler(fixture)).rejects.toThrow("does not resolve to installed bin.wrangler");
});

it("rejects generator relation and live Link mutations", () => {
  const html = '<link rel="prefetch" crossorigin href="/app.js">';
  expect(() => assertGeneratedLink(html, "  Link: </app.js>; rel=prefetch; crossorigin")).toThrow("must be a modulepreload");
  expect(() => assertGeneratedLink(
    '<link rel="preload" href="/sample-pack.pack" as="fetch">',
    "  Link: </sample-pack.pack>; rel=preload; as=fetch; crossorigin",
  )).toThrow("must not be preloaded");
  const headers = new Headers({
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' wss://enplace-relay.joesdownloads.workers.dev; form-action 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", link: "</wrong.js>; rel=modulepreload",
  });
  expect(() => assertBoundaryHeaders(new Response(null, { headers }), "</expected.js>; rel=modulepreload")).toThrow();
});
