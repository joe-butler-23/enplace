#!/usr/bin/env node
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const [nodeVersion, pkg, lock, core, browsers] = await Promise.all([
  readFile(".nvmrc", "utf8").then((value) => value.trim()),
  json("package.json"),
  json("package-lock.json"),
  json("node_modules/playwright-core/package.json"),
  json("node_modules/playwright-core/browsers.json"),
]);
const npmVersion = pkg.devDependencies?.["@playwright/test"];
assert.match(nodeVersion, /^\d+\.\d+\.\d+$/, ".nvmrc must pin an exact Node release");
assert.equal(process.versions.node, nodeVersion, `expected Node ${nodeVersion}, found ${process.versions.node}`);
assert.equal(lock.packages?.[""]?.devDependencies?.["@playwright/test"], npmVersion, "npm lock root mismatch");
assert.equal(lock.packages?.["node_modules/playwright-core"]?.version, npmVersion, "npm Playwright packages mismatch");
assert.equal(core.version, npmVersion, "installed playwright-core mismatch");
assert.equal(process.env.ENPLACE_NIX_PLAYWRIGHT_VERSION, npmVersion, "Nix playwright-driver mismatch");
assert.equal(process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, "1", "Nix must forbid npm browser downloads");
const browserPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
assert.match(browserPath ?? "", /^\/nix\/store\//, "browsers must come from the Nix store");
for (const name of ["chromium", "chromium-headless-shell", "firefox", "webkit", "ffmpeg"]) {
  const entry = browsers.browsers.find((browser) => browser.name === name);
  assert(entry, `playwright-core does not declare ${name}`);
  await access(path.join(browserPath, `${name.replaceAll("-", "_")}-${entry.revision}`));
}
console.log(`launch contract: Node ${nodeVersion}, npm/Nix Playwright ${npmVersion}, ${browserPath}`);
