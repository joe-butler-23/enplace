#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, readdir, realpath } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const routes = ["/", "/index.html", "/shopping", "/planner", "/settings"];
const security = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' wss://enplace-relay.joesdownloads.workers.dev; form-action 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
const json = async (file) => JSON.parse(await readFile(file, "utf8"));

export async function resolveInstalledWrangler(root = process.cwd()) {
  const [pkg, lock, installed] = await Promise.all([
    json(path.join(root, "package.json")), json(path.join(root, "package-lock.json")),
    json(path.join(root, "node_modules/wrangler/package.json")),
  ]);
  const version = pkg.devDependencies?.wrangler;
  assert.equal(lock.packages?.[""]?.devDependencies?.wrangler, version);
  assert.equal(lock.packages?.["node_modules/wrangler"]?.version, version);
  assert.equal(installed.version, version);
  const target = await realpath(path.join(root, "node_modules/wrangler", installed.bin.wrangler));
  assert.equal(await realpath(path.join(root, "node_modules/.bin/wrangler")), target, "Wrangler shim does not resolve to installed bin.wrangler");
  return { bin: target, version };
}

export function assertBoundaryHeaders(response, expectedLink, expectedCsp = security["content-security-policy"]) {
  for (const [name, value] of Object.entries(security)) assert.equal(response.headers.get(name), name === "content-security-policy" ? expectedCsp : value);
  if (expectedLink !== undefined) assert.equal(response.headers.get("link"), expectedLink);
}

export function assertGeneratedLink(html, line) {
  const groups = { module: [], style: [], font: [] };
  for (const [tag] of html.matchAll(/<link\b[^>]+>/gi)) {
    const href = tag.match(/\shref=["']([^"']+)["']/i)?.[1];
    const rel = tag.match(/\srel=["']([^"']+)["']/i)?.[1];
    const as = tag.match(/\sas=["']([^"']+)["']/i)?.[1];
    if (href?.endsWith(".js")) {
      assert.equal(rel, "modulepreload", `${href} must be a modulepreload`);
      groups.module.push(`<${href}>; rel=modulepreload; crossorigin`);
    }
    if (href?.endsWith(".css")) {
      assert.equal(rel, "stylesheet", `${href} must be a stylesheet`);
      groups.style.push(`<${href}>; rel=preload; as=style; crossorigin`);
    }
    if (href?.endsWith(".woff2")) {
      assert.equal(`${rel}/${as}`, "preload/font", `${href} must preload as a font`);
      const type = tag.match(/\stype=["']([^"']+)["']/i)?.[1];
      assert.equal(type, "font/woff2", `${href} must declare font/woff2`);
      groups.font.push(`<${href}>; rel=preload; as=font; type="${type}"; crossorigin`);
    }
    if (href?.endsWith(".pack")) assert.fail(`${href} must not be preloaded`);
  }
  const expected = [...groups.module, ...groups.style, ...groups.font].join(", ");
  assert.equal(line, `  Link: ${expected}`);
  return expected;
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer().once("error", reject).listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

export async function withWranglerProcess({ bin, directory, version, readinessMs = 20_000 }, ready) {
  const port = await reservePort();
  let child;
  let output = "";
  try {
    child = spawn(bin, ["pages", "dev", directory, "--ip", "127.0.0.1", "--port", String(port)], {
      stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1", NO_COLOR: "1" },
    });
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`Wrangler readiness deadline exceeded:\n${output}`)), readinessMs);
      const consume = (chunk) => {
        output += chunk;
        if (output.toLowerCase().includes(`wrangler ${version}`) && /Ready on http:\/\/127\.0\.0\.1:\d+/.test(output)) {
          clearTimeout(deadline);
          resolve();
        }
      };
      child.stdout.on("data", consume);
      child.stderr.on("data", consume);
      child.once("error", (error) => { clearTimeout(deadline); reject(error); });
      child.once("exit", (code) => { clearTimeout(deadline); reject(new Error(`Wrangler exited ${code}:\n${output}`)); });
    });
    return await ready(`http://127.0.0.1:${port}`);
  } finally {
    if (child?.pid && child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      const deadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
      await exited;
      clearTimeout(deadline);
    }
  }
}

async function runPagesBoundary() {
  const dist = path.resolve("dist-static");
  const [{ bin, version }, headers, sourceHeaders, html, files] = await Promise.all([
    resolveInstalledWrangler(), readFile(path.join(dist, "_headers"), "utf8"), readFile("public/_headers", "utf8"),
    readFile(path.join(dist, "index.html"), "utf8"), readdir(dist, { recursive: true }),
  ]);
  const relay = process.env.VITE_ENPLACE_RELAY_URL ?? (await readFile(".env.static", "utf8")).match(/^VITE_ENPLACE_RELAY_URL=(.*)$/m)?.[1];
  const relayOrigin = relay ? new URL(relay).origin : "";
  const expectedHeaders = sourceHeaders.trimEnd().replace("__ENPLACE_RELAY_ORIGIN__", relayOrigin);
  assert(headers.startsWith(`${expectedHeaders}\n\n`));
  const expectedCsp = expectedHeaders.match(/Content-Security-Policy: (.*)/)?.[1];
  assert(expectedCsp && !expectedCsp.includes("__ENPLACE") && !/connect-src[^;]*(?:\*| wss:;)/.test(expectedCsp));

  const existing = new Set(files.map((file) => `/${file}`));
  const generated = headers.split("# Generated from this build's navigation-shell assets.\n");
  assert.equal(generated.length, 2);
  const blocks = generated[1].trimEnd().split(/\n\n/);
  assert.equal(blocks.length, routes.length);
  for (const [index, block] of blocks.entries()) {
    const [route, cache, link, ...extra] = block.split("\n");
    assert.equal(route, routes[index]);
    assert.equal(cache, "  Cache-Control: no-store");
    assert.equal(extra.length, 0);
    assert(link?.startsWith("  Link: ") && link.length <= 2_000);
    const expectedLink = assertGeneratedLink(html, link);
    [...expectedLink.matchAll(/<([^>]+)>;/g)]
      .forEach(([, target]) => assert(existing.has(target), `missing Link target ${target}`));
  }
  const expectedLink = assertGeneratedLink(html, blocks[0].split("\n")[2]);

  await withWranglerProcess({ bin, directory: dist, version }, async (base) => {
    async function check(url, { status = 200, type, body, cache, link }) {
      const response = await fetch(`${base}${url}`, { redirect: "manual" });
      assertBoundaryHeaders(response, link, expectedCsp);
      for (const name of ["cross-origin-opener-policy", "cross-origin-embedder-policy", "cross-origin-resource-policy"])
        assert.equal(response.headers.get(name), null);
      assert.equal(response.status, status);
      if (type) assert.match(response.headers.get("content-type"), type);
      if (body) assert.equal(await response.text(), body);
      if (cache) assert.equal(response.headers.get("cache-control"), cache);
      return response;
    }
    for (const route of routes.filter((route) => route !== "/index.html"))
      await check(route, { type: /^text\/html/, body: html, cache: "no-store", link: expectedLink });
    const index = await check("/index.html", { status: 308, cache: "no-store", link: expectedLink });
    assert.equal(index.headers.get("location"), "/");
    await check("/shopping?oracle=1", { body: html });
    await check("/unknown-extensionless-route", { body: html });
    const asset = (extension) => `/${files.find((file) => new RegExp(`^assets/.+-[^/]+\\.${extension}$`).test(file))}`;
    for (const [url, type, cache] of [
      [asset("js"), /javascript/, "public, max-age=31536000, immutable"],
      [asset("css"), /^text\/css/, "public, max-age=31536000, immutable"],
      ["/icons/icon-192.png", /^image\/png/, "public, max-age=31536000, immutable"],
      ["/fonts/fraunces-latin-opsz-normal.woff2", /^font\/woff2/, "public, max-age=31536000, immutable"],
    ]) await check(url, { type, cache });
    await check("/sw.js", { type: /javascript/, cache: "no-cache" });
  });
  console.log(`Pages boundary passed through installed Wrangler ${version}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runPagesBoundary();
