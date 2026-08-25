#!/usr/bin/env node

import http from "node:http";
import crypto from "node:crypto";
import { gzipSync } from "node:zlib";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  access,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";

const require = createRequire(import.meta.url);
const settingsDefaults = require("../src/settings.defaults.json");

const DIST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist-web");
const INDEX_FILE = path.join(DIST_DIR, "index.html");
const DEFAULT_PORT = 4173;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_VIRTUAL_VAULT = "/home/vault";
const DEFAULT_APPDATA_NAME = ".mep-web-host";
const NATIVE_APP_IDENTIFIER = "com.mise.en.place";
const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;
const MAX_FS_BATCH_FILES = 4096;
const MAX_FS_BATCH_RESPONSE_BYTES = 64 * 1024 * 1024;
const FS_BATCH_READ_CONCURRENCY = 16;
const MAX_HELPER_FRAME_BYTES = 1 * 1024 * 1024;
const MAX_HELPER_OUTPUT_BYTES = 1 * 1024 * 1024;
const HELPER_TIMEOUT_MS = 10_000;
const HELPER_BATCH_TIMEOUT_MS = 30_000;
const HELPER_BINARY_NAME = "mep-remote-host-helper";
const DEFAULT_SETTINGS = {
  ...settingsDefaults,
  recipesFolder: "cooking/recipes",
  imagesFolder: "cooking/recipes/images",
  vaultPath: DEFAULT_VIRTUAL_VAULT
};

function cloneDefaultSettings() {
  return {
    ...DEFAULT_SETTINGS,
    dayNotes: { ...DEFAULT_SETTINGS.dayNotes }
  };
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      result[key] = "true";
      continue;
    }
    result[key] = next;
    i += 1;
  }
  return result;
}

function expandTilde(value, homeDir = os.homedir()) {
  if (!value) return value;
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) {
    return path.join(homeDir, value.slice(2));
  }
  return value;
}

// First-run vault default. Deliberately NOT a generic name like ~/vault: a
// stranger may already own an Obsidian or other vault at that path, and
// silently mounting someone else's folder would coerce it into app ownership.
// The web host creates ~/Enplace on first run instead; interactive starts get
// an explained chance to pick another directory (selectVaultRoot).
const DEFAULT_VAULT_DIRNAME = "Enplace";

function defaultVaultRoot(homeDir = os.homedir()) {
  return path.join(homeDir, DEFAULT_VAULT_DIRNAME);
}

function resolveHostVaultRoot(args = {}, env = process.env, homeDir = os.homedir()) {
  return path.resolve(
    expandTilde(args.vault || env.MEP_HOST_VAULT_PATH || defaultVaultRoot(homeDir), homeDir)
  );
}

async function selectVaultRoot({ args, env = process.env, input = process.stdin, output = process.stdout } = {}) {
  const explicit = expandTilde(args.vault || env.MEP_HOST_VAULT_PATH || "", os.homedir());
  if (explicit) return path.resolve(explicit);

  const fallback = defaultVaultRoot();
  output.write(
    [
      "",
      "Enplace stores your recipes as plain Markdown files in a vault directory.",
      "On first run it creates that directory; you can also point Enplace at an",
      "existing Obsidian-compatible folder and your files stay exactly where they are.",
      `Default location: ${fallback}`,
      ""
    ].join("\n")
  );

  if (!input.isTTY) {
    output.write(`No terminal attached and no --vault given; using ${fallback}.\n`);
    return fallback;
  }

  const readline = createInterface({ input, output });
  try {
    for (;;) {
      const answer = await readline.question(`Vault directory [press Enter for ${fallback}]: `);
      const trimmed = answer.trim();
      if (!trimmed) return fallback;
      const candidate = path.resolve(expandTilde(trimmed));
      if (!path.isAbsolute(candidate)) {
        output.write("Please enter an absolute path (a leading ~ is allowed).\n");
        continue;
      }
      return candidate;
    }
  } finally {
    readline.close();
  }
}

// Mirrors Tauri's Linux app_data_dir resolution (`dirs::data_dir()`): honour
// XDG_DATA_HOME when set, else ~/.local/share, joined with the app
// identifier. Thumbnails are content-addressed (mep_core::thumbnails, v4
// cache keyed by source hash) so pointing the web host's thumbnail cache at
// the same directory the native app already writes to lets both runtimes
// reuse one set of generated files instead of paying a cold-start cost twice.
function resolveDefaultThumbnailCacheRoot() {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, NATIVE_APP_IDENTIFIER);
}

async function fileExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function json(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function text(res, status, payload, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  res.end(payload);
}

export function cacheControlForDistFile(filePath, distDir = DIST_DIR) {
  return filePath.startsWith(`${path.join(distDir, "assets")}${path.sep}`)
    ? "public, max-age=31536000, immutable"
    : "no-store";
}

// Security baseline for every served response (see docs/security-baseline.md).
// Mirrors the former native CSP, re-expressed for the web host origin.
function contentSecurityPolicy(extraScriptSources = []) {
  const scriptSrc = ["'self'", ...extraScriptSources].join(" ");
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "connect-src 'self'",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join("; ");
}

const SECURITY_HEADERS = {
  "Content-Security-Policy": contentSecurityPolicy(),
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer"
};

/** Quoted CSP source expression allowing exactly one inline script body. */
function inlineScriptSource(body) {
  const digest = crypto.createHash("sha256").update(body, "utf8").digest("base64");
  return `'sha256-${digest}'`;
}

function applySecurityHeaders(res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(name, value);
  }
}

const GZIP_MIN_BYTES = 1024;
const COMPRESSIBLE_CONTENT_TYPES = new Set([
  "text/html",
  "text/css",
  "text/plain",
  "text/javascript",
  "application/javascript",
  "application/json",
  "application/manifest+json",
  "image/svg+xml"
]);

function acceptsGzip(req) {
  return /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""));
}

/**
 * Sends a static/index payload with Accept-Encoding-gated gzip. Hashed
 * assets keep their immutable Cache-Control; compression happens per
 * request because nothing on disk is pre-compressed.
 */
function sendStatic(res, req, status, payload, contentType, extraHeaders = {}) {
  const headers = { ...extraHeaders, "Content-Type": contentType };
  const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (COMPRESSIBLE_CONTENT_TYPES.has(String(contentType).split(";")[0].trim())) {
    headers.Vary = "Accept-Encoding";
  }
  if (
    req.method !== "HEAD" &&
    buffer.byteLength > GZIP_MIN_BYTES &&
    Object.prototype.hasOwnProperty.call(headers, "Vary") &&
    acceptsGzip(req)
  ) {
    headers["Content-Encoding"] = "gzip";
    res.writeHead(status, headers);
    res.end(gzipSync(buffer, { level: 6 }));
    return;
  }
  res.writeHead(status, headers);
  res.end(req.method === "HEAD" ? undefined : buffer);
}

async function readBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    length += buffer.byteLength;
    if (length > MAX_REQUEST_BODY_BYTES) {
      const error = new Error("Request body too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function normalizeVirtualPath(value) {
  const normalized = String(value || "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/");
  if (!normalized.startsWith("/")) {
    throw new Error("Virtual path must be absolute.");
  }
  return normalized === "/" ? "/" : normalized.replace(/\/+$/, "");
}

function ensureWithin(base, candidate) {
  const resolvedBase = path.resolve(base);
  const resolvedCandidate = path.resolve(candidate);
  if (
    resolvedCandidate !== resolvedBase &&
    !resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`)
  ) {
    throw new Error("Path escapes configured root.");
  }
  return resolvedCandidate;
}

function createVirtualMapper({ vaultRoot, appDataRoot }) {
  const resolvedVaultRoot = path.resolve(vaultRoot);
  const resolvedAppDataRoot = path.resolve(appDataRoot);

  const virtualRootEntries = [
    { name: "home", path: "/home", isDirectory: true },
    { name: "appdata", path: "/appdata", isDirectory: true }
  ];
  const homeEntries = [{ name: "vault", path: DEFAULT_VIRTUAL_VAULT, isDirectory: true }];

  function resolveReal(virtualPath) {
    const normalized = normalizeVirtualPath(virtualPath);

    if (normalized === "/") {
      return { kind: "virtual-root", realPath: null };
    }
    if (normalized === "/home") {
      return { kind: "virtual-home", realPath: null };
    }
    if (normalized === DEFAULT_VIRTUAL_VAULT) {
      return { kind: "vault-root", realPath: resolvedVaultRoot };
    }
    if (normalized.startsWith(`${DEFAULT_VIRTUAL_VAULT}/`)) {
      const suffix = normalized.slice(DEFAULT_VIRTUAL_VAULT.length + 1);
      return {
        kind: "vault",
        realPath: ensureWithin(resolvedVaultRoot, path.join(resolvedVaultRoot, suffix))
      };
    }
    if (normalized === "/appdata") {
      return { kind: "appdata-root", realPath: resolvedAppDataRoot };
    }
    if (normalized.startsWith("/appdata/")) {
      const suffix = normalized.slice("/appdata/".length);
      return {
        kind: "appdata",
        realPath: ensureWithin(resolvedAppDataRoot, path.join(resolvedAppDataRoot, suffix))
      };
    }

    throw new Error(`Unsupported virtual path: ${normalized}`);
  }

  function virtualEntriesFor(kind) {
    if (kind === "virtual-root") return virtualRootEntries;
    if (kind === "virtual-home") return homeEntries;
    return [];
  }

  function toVirtualPath(realPath, family) {
    const root = family === "vault" ? resolvedVaultRoot : resolvedAppDataRoot;
    const virtualRoot = family === "vault" ? DEFAULT_VIRTUAL_VAULT : "/appdata";
    const relative = path.relative(root, realPath).split(path.sep).filter(Boolean).join("/");
    return relative ? `${virtualRoot}/${relative}` : virtualRoot;
  }

  return {
    resolveReal,
    toVirtualPath,
    virtualEntriesFor
  };
}

async function ensureServerFiles({ vaultRoot, appDataRoot }) {
  await mkdir(vaultRoot, { recursive: true });
  await mkdir(appDataRoot, { recursive: true });

  const settingsPath = path.join(appDataRoot, "settings.json");
  if (!(await fileExists(settingsPath))) {
    await writeFile(settingsPath, `${JSON.stringify(cloneDefaultSettings(), null, 2)}\n`, "utf8");
  }

  const ledgerPath = path.join(appDataRoot, "ledger.json");
  if (!(await fileExists(ledgerPath))) {
    await writeFile(ledgerPath, "[]\n", "utf8");
  }
}

async function listDirectoryEntries(mapper, virtualPath) {
  const resolved = mapper.resolveReal(virtualPath);
  const synthetic = mapper.virtualEntriesFor(resolved.kind);
  if (synthetic.length > 0) {
    return synthetic.map((entry) => ({
      path: entry.path,
      name: entry.name,
      isFile: false,
      isDirectory: true,
      isSymlink: false
    }));
  }

  const target = resolved.realPath;
  const entries = await readdir(target, { withFileTypes: true });
  return Promise.all(entries.map(async (entry) => {
    const realPath = path.join(target, entry.name);
    const family = resolved.kind.startsWith("vault") ? "vault" : "appdata";
    const inventoryEntry = {
      path: mapper.toVirtualPath(realPath, family),
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
      isSymlink: entry.isSymbolicLink()
    };
    if (entry.isDirectory()) return inventoryEntry;
    try {
      const info = await stat(realPath);
      return {
        ...inventoryEntry,
        size: info.size,
        mtime: info.mtime.toISOString()
      };
    } catch {
      return inventoryEntry;
    }
  }));
}

async function listDirectoryRecursive(mapper, virtualPath) {
  const entries = await listDirectoryEntries(mapper, virtualPath);
  const results = [];
  for (const entry of entries) {
    if (entry.isDirectory) {
      if (entry.name.startsWith(".") && entry.name !== ".machine") continue;
      results.push({
        ...entry,
        children: await listDirectoryRecursive(mapper, entry.path)
      });
    } else {
      results.push(entry);
    }
  }
  return results;
}

async function readTextBatch(mapper, virtualPaths) {
  if (!Array.isArray(virtualPaths) || virtualPaths.length > MAX_FS_BATCH_FILES) {
    throw new Error(`Text batch must contain at most ${MAX_FS_BATCH_FILES} paths.`);
  }
  if (!virtualPaths.every((entry) => typeof entry === "string")) {
    throw new Error("Text batch paths must be strings.");
  }

  const files = new Array(virtualPaths.length);
  let nextIndex = 0;
  let totalBytes = 0;
  const workers = Array.from(
    { length: Math.min(FS_BATCH_READ_CONCURRENCY, virtualPaths.length) },
    async () => {
      while (nextIndex < virtualPaths.length) {
        const index = nextIndex;
        nextIndex += 1;
        const virtualPath = virtualPaths[index];
        const resolved = mapper.resolveReal(virtualPath);
        const content = await readFile(resolved.realPath, "utf8");
        totalBytes += Buffer.byteLength(content, "utf8");
        if (totalBytes > MAX_FS_BATCH_RESPONSE_BYTES) {
          throw new Error(
            `Text batch response too large (${totalBytes} bytes > ${MAX_FS_BATCH_RESPONSE_BYTES} bytes)`
          );
        }
        files[index] = { path: virtualPath, content };
      }
    }
  );
  await Promise.all(workers);
  return files;
}

function remoteHostConfigScript(token) {
  const config = JSON.stringify({
    mode: "remote-host",
    apiBase: "/api",
    token,
    canSelectVault: false
  }).replace(/</g, "\\u003c");
  return `window.__MEP_REMOTE_HOST__=${config};`;
}

function injectRemoteHostConfig(indexHtml, token) {
  if (indexHtml.includes("__MEP_REMOTE_HOST__")) {
    return indexHtml;
  }
  return indexHtml.replace("</head>", `<script>${remoteHostConfigScript(token)}</script></head>`);
}

function thumbnailCookie(token, secure = false) {
  return `mep_thumbnail_auth=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/api/thumbnail; Max-Age=3600${secure ? "; Secure" : ""}`;
}

function requestUsesSecureTransport(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  return req.socket.encrypted === true || forwardedProto === "https";
}

function hasThumbnailAuthorization(req, token) {
  if (req.headers.authorization === `Bearer ${token}`) return true;
  const cookies = String(req.headers.cookie || "").split(";");
  const value = cookies
    .map((entry) => entry.trim().split("="))
    .find(([name]) => name === "mep_thumbnail_auth")?.slice(1).join("=");
  if (!value) return false;
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return false;
  }
  const actual = Buffer.from(decoded);
  const expected = Buffer.from(token);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function resolveRustHelperBinary(explicitPath) {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (await fileExists(resolved)) return resolved;
    throw new Error(
      `Rust cooking helper not found. Build ${HELPER_BINARY_NAME} and pass --rust-helper PATH or set MEP_REMOTE_HOST_HELPER.`
    );
  }

  const envOverride = process.env.MEP_REMOTE_HOST_HELPER;
  if (envOverride) {
    const resolved = path.resolve(envOverride);
    if (await fileExists(resolved)) return resolved;
    throw new Error(
      `Rust cooking helper not found. Build ${HELPER_BINARY_NAME} and pass --rust-helper PATH or set MEP_REMOTE_HOST_HELPER.`
    );
  }

  const releasePath = path.resolve(process.cwd(), "target/release", HELPER_BINARY_NAME);
  if (await fileExists(releasePath)) return releasePath;

  const debugPath = path.resolve(process.cwd(), "target/debug", HELPER_BINARY_NAME);
  if (await fileExists(debugPath)) {
    console.warn(
      `Rust cooking helper release build not found at ${releasePath}; falling back to debug build at ${debugPath}. Run \`npm run build:remote-helper\` for a release build.`
    );
    return debugPath;
  }

  throw new Error(
    `Rust cooking helper not found. Build ${HELPER_BINARY_NAME} and pass --rust-helper PATH or set MEP_REMOTE_HOST_HELPER.`
  );
}

class RustCookingHelperClient {
  constructor({
    command,
    configDir,
    shoppingDataDir = configDir,
    thumbnailCacheDir = path.join(configDir, "thumbnails"),
    token = crypto.randomBytes(32).toString("hex")
  }) {
    this.command = command;
    this.configDir = configDir;
    this.shoppingDataDir = shoppingDataDir;
    this.thumbnailCacheDir = thumbnailCacheDir;
    this.token = token;
    this.child = null;
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
    this.authenticated = false;
    this.startPromise = null;
    this.watchListeners = new Set();
    this.watchFailureListeners = new Set();
  }

  start() {
    if (this.authenticated) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    const child = spawn(
      this.command,
      [
        "--config-dir", this.configDir,
        "--shopping-data-dir", this.shoppingDataDir,
        "--thumbnail-cache-dir", this.thumbnailCacheDir
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#onOutput(chunk));
    child.stderr.on("data", () => {});
    child.once("error", (error) => this.#fail(error));
    child.once("close", (code, signal) => {
      this.child = null;
      this.authenticated = false;
      this.#fail(new Error(`Rust cooking helper exited (${code ?? signal ?? "unknown"})`));
    });
    this.startPromise = new Promise((resolve, reject) => {
      this.handshake = { resolve, reject };
      try {
        child.stdin.write(`${JSON.stringify({ type: "hello", auth: this.token })}\n`);
      } catch (error) {
        this.#fail(error);
      }
    });
    return this.startPromise;
  }

  stop() {
    if (this.child) this.child.kill();
    this.child = null;
    this.authenticated = false;
    this.startPromise = null;
    this.#fail(new Error("Rust cooking helper stopped"));
  }

  onWatch(listener) {
    this.watchListeners.add(listener);
    return () => this.watchListeners.delete(listener);
  }

  onWatchFailure(listener) {
    this.watchFailureListeners.add(listener);
    return () => this.watchFailureListeners.delete(listener);
  }

  async startWatch(root, subscriptions) {
    if (typeof root !== "string" || !root || !Array.isArray(subscriptions) || subscriptions.length === 0) {
      throw new Error("watch_start requires a root and path-filtered subscriptions");
    }
    return this.#request("watch_start", { root, subscriptions }, "Rust vault watcher start timed out");
  }

  async watchStatus(generation) {
    return this.#request(
      "watch_status",
      { generation },
      "Rust vault watcher status timed out"
    );
  }

  async stopWatch() {
    return this.#request("watch_stop", {}, "Rust vault watcher stop timed out");
  }

  async shoppingList() {
    return this.#request("shopping_list", {}, "Rust shopping list read timed out");
  }

  async shoppingPreview(weekLabel, desiredItems) {
    return this.#request(
      "shopping_preview",
      { weekLabel, desiredItems },
      "Rust shopping list preview timed out"
    );
  }

  async shoppingApply(expectedRevision, weekLabel, desiredItems) {
    return this.#request(
      "shopping_apply",
      { expectedRevision, weekLabel, desiredItems },
      "Rust shopping list apply timed out"
    );
  }

  async shoppingCheck(expectedRevision, itemId, checked) {
    return this.#request(
      "shopping_check",
      { expectedRevision, itemId, checked },
      "Rust shopping list check timed out"
    );
  }

  async shoppingAdd(expectedRevision, content, labels) {
    return this.#request(
      "shopping_add",
      { expectedRevision, content, labels },
      "Rust shopping list add timed out"
    );
  }

  async shoppingRemove(expectedRevision, itemId) {
    return this.#request(
      "shopping_remove",
      { expectedRevision, itemId },
      "Rust shopping list remove timed out"
    );
  }

  async shoppingRollback(expectedRevision) {
    return this.#request(
      "shopping_rollback",
      { expectedRevision },
      "Rust shopping list rollback timed out"
    );
  }

  async #request(command, payload, timeoutMessage) {
    const id = String(this.nextId++);
    const frame = JSON.stringify({ id, auth: this.token, command, payload });
    if (Buffer.byteLength(frame, "utf8") > MAX_HELPER_FRAME_BYTES) {
      throw new Error("Cooking helper request too large");
    }
    await this.start();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail(new Error(timeoutMessage)), HELPER_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${frame}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        this.#fail(error);
        reject(error);
      }
    });
  }

  async buildDesiredItems(recipes) {
    if (!Array.isArray(recipes)) throw new Error("recipes must be an array");
    const id = String(this.nextId++);
    const frame = JSON.stringify({
      id,
      auth: this.token,
      command: "build_desired_items",
      payload: { recipes }
    });
    if (Buffer.byteLength(frame, "utf8") > MAX_HELPER_FRAME_BYTES) {
      throw new Error("Cooking helper request too large");
    }
    await this.start();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#fail(new Error("Rust cooking helper timed out"));
      }, HELPER_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${frame}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        this.#fail(error);
        reject(error);
      }
    });
  }

  async createThumbnail(sourcePath, maxSizePx) {
    if (typeof sourcePath !== "string" || !sourcePath) {
      throw new Error("thumbnail source path is required");
    }
    if (maxSizePx !== 320 && maxSizePx !== 640) {
      throw new Error("thumbnail size must be 320 or 640 pixels");
    }
    const id = String(this.nextId++);
    const frame = JSON.stringify({
      id,
      auth: this.token,
      command: "create_thumbnail",
      payload: { sourcePath, maxSizePx }
    });
    if (Buffer.byteLength(frame, "utf8") > MAX_HELPER_FRAME_BYTES) {
      throw new Error("Cooking helper request too large");
    }
    await this.start();
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail(new Error("Rust cooking helper timed out")), HELPER_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${frame}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        this.#fail(error);
        reject(error);
      }
    });
    if (
      !result ||
      typeof result !== "object" ||
      typeof result.version !== "string" ||
      !/^v4-(320|640)-[a-f0-9]{64}$/.test(result.version) ||
      !["jpg", "png", "webp", "avif"].includes(result.extension ?? "jpg")
    ) {
      throw new Error("Malformed Rust cooking helper thumbnail response");
    }
    return { ...result, extension: result.extension ?? "jpg" };
  }

  async createThumbnails(sourcePaths, maxSizePx) {
    if (!Array.isArray(sourcePaths) || sourcePaths.length > 500 || sourcePaths.some((path) => typeof path !== "string" || !path)) {
      throw new Error("thumbnail source paths must be an array of at most 500 paths");
    }
    if (maxSizePx !== 320 && maxSizePx !== 640) {
      throw new Error("thumbnail size must be 320 or 640 pixels");
    }
    const id = String(this.nextId++);
    const frame = JSON.stringify({
      id,
      auth: this.token,
      command: "create_thumbnails",
      payload: { sourcePaths, maxSizePx }
    });
    if (Buffer.byteLength(frame, "utf8") > MAX_HELPER_FRAME_BYTES) {
      throw new Error("Cooking helper request too large");
    }
    await this.start();
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail(new Error("Rust cooking helper thumbnail batch timed out")), HELPER_BATCH_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${frame}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        this.#fail(error);
        reject(error);
      }
    });
    if (!Array.isArray(result) || result.length !== sourcePaths.length) {
      throw new Error("Malformed Rust cooking helper thumbnail batch response");
    }
    return result.map((item) => {
      if (item?.thumbnail === null && typeof item?.error === "string") return null;
      if (
        typeof item?.thumbnail?.version !== "string" ||
        !/^v4-(320|640)-[a-f0-9]{64}$/.test(item.thumbnail.version) ||
        !["jpg", "png", "webp", "avif"].includes(item.thumbnail.extension ?? "jpg")
      ) {
        throw new Error("Malformed Rust cooking helper thumbnail batch response");
      }
      return { ...item.thumbnail, extension: item.thumbnail.extension ?? "jpg" };
    });
  }

  async prepareDatabaseThumbnails(sourcePaths) {
    if (!Array.isArray(sourcePaths) || sourcePaths.length > 500 || sourcePaths.some((path) => typeof path !== "string" || !path)) {
      throw new Error("thumbnail source paths must be an array of at most 500 paths");
    }
    const id = String(this.nextId++);
    const frame = JSON.stringify({
      id,
      auth: this.token,
      command: "prepare_database_thumbnails",
      payload: { sourcePaths }
    });
    if (Buffer.byteLength(frame, "utf8") > MAX_HELPER_FRAME_BYTES) {
      throw new Error("Cooking helper request too large");
    }
    await this.start();
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail(new Error("Rust cooking helper thumbnail batch timed out")), HELPER_BATCH_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${frame}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        this.#fail(error);
        reject(error);
      }
    });
    if (!Array.isArray(result) || result.length !== sourcePaths.length) {
      throw new Error("Malformed Rust cooking helper database thumbnail response");
    }
    return result.map((item) => {
      if (item?.thumbnail === null && typeof item?.error === "string") return null;
      if (
        typeof item?.thumbnail?.version !== "string" ||
        !/^v4-320-[a-f0-9]{64}$/.test(item.thumbnail.version) ||
        !["jpg", "png", "webp", "avif"].includes(item.thumbnail.extension ?? "jpg")
      ) {
        throw new Error("Malformed Rust cooking helper database thumbnail response");
      }
      return { ...item.thumbnail, extension: item.thumbnail.extension ?? "jpg" };
    });
  }

  #onOutput(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_HELPER_OUTPUT_BYTES) {
      this.#fail(new Error("Rust cooking helper output too large"));
      return;
    }
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      let response;
      try {
        response = JSON.parse(line);
      } catch (error) {
        this.#fail(new Error(`Malformed Rust cooking helper response: ${error.message}`));
        return;
      }
      if (!this.authenticated) {
        if (response?.type !== "hello" || response.ok !== true) {
          this.#fail(new Error(String(response?.error || "Rust cooking helper handshake failed")));
          return;
        }
        this.authenticated = true;
        this.startPromise = null;
        this.handshake?.resolve();
        this.handshake = null;
        continue;
      }
      if (response?.type === "watch" && response.batch) {
        for (const listener of this.watchListeners) listener(response.batch);
        continue;
      }
      const pending = this.pending.get(String(response?.id ?? ""));
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(String(response.id));
      if (response.ok === true) pending.resolve(response.result);
      else pending.reject(new Error(String(response.error || "Rust cooking helper failed")));
    }
  }

  #fail(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.handshake?.reject(error);
    this.handshake = null;
    this.startPromise = null;
    this.authenticated = false;
    for (const listener of this.watchFailureListeners) listener(error);
    if (this.child) this.child.kill();
    this.child = null;
    this.buffer = "";
  }
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".js") return "text/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".webmanifest") return "application/manifest+json; charset=utf-8";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  if (extension === ".avif") return "image/avif";
  if (extension === ".ico") return "image/x-icon";
  if (extension === ".woff2") return "font/woff2";
  return "application/octet-stream";
}

function stripQuotes(value) {
  const trimmed = String(value ?? "").trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseScalar(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((entry) => stripQuotes(entry))
      .filter(Boolean);
  }
  return stripQuotes(trimmed);
}

function parseFrontmatter(content) {
  const normalized = String(content || "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return {};
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return {};

  const frontmatter = {};
  const lines = normalized.slice(4, end).split("\n");
  let currentListKey = null;
  for (const line of lines) {
    const listMatch = line.match(/^\s*-\s+(.+)$/);
    if (currentListKey && listMatch) {
      const existing = Array.isArray(frontmatter[currentListKey])
        ? frontmatter[currentListKey]
        : [];
      existing.push(parseScalar(listMatch[1]));
      frontmatter[currentListKey] = existing;
      continue;
    }

    currentListKey = null;
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (!rawValue.trim()) {
      frontmatter[key] = [];
      currentListKey = key;
    } else {
      frontmatter[key] = parseScalar(rawValue);
    }
  }
  return frontmatter;
}

function getString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getStringList(value) {
  if (Array.isArray(value)) {
    return Array.from(
      new Set(value.map((entry) => getString(entry)).filter((entry) => Boolean(entry)))
    );
  }
  const single = getString(value);
  return single ? [single] : [];
}

function parseTags(tags) {
  if (Array.isArray(tags)) {
    return tags.filter((tag) => typeof tag === "string");
  }
  if (typeof tags === "string") {
    return tags
      .split(/[,\s]+/)
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
  return [];
}

function toTimestamp(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function compareNullableDates(left, right, descending) {
  const leftTs = toTimestamp(left);
  const rightTs = toTimestamp(right);
  if (leftTs === null && rightTs === null) return 0;
  if (leftTs === null) return 1;
  if (rightTs === null) return -1;
  return descending ? rightTs - leftTs : leftTs - rightTs;
}

function sortRecipeItems(items, sortBy) {
  const sorted = [...items];
  const comparators = {
    "title-asc": (left, right) => left.title.localeCompare(right.title),
    "title-desc": (left, right) => right.title.localeCompare(left.title),
    "scheduled-asc": (left, right) => compareNullableDates(left.scheduled, right.scheduled, false),
    "scheduled-desc": (left, right) => compareNullableDates(left.scheduled, right.scheduled, true),
    "added-asc": (left, right) => compareNullableDates(left.added, right.added, false),
    "added-desc": (left, right) => compareNullableDates(left.added, right.added, true)
  };
  const comparator = comparators[sortBy] ?? comparators["added-desc"];
  sorted.sort(comparator);
  return sorted;
}

async function collectMarkdownFiles(root, current = root, results = []) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await collectMarkdownFiles(root, target, results);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      results.push(target);
    }
  }
  return results;
}

function toVaultRelative(realPath, vaultRoot) {
  return path.relative(vaultRoot, realPath).split(path.sep).join("/");
}

function recipeSourceRoot(vaultRoot, query = {}) {
  const recipesFolder = String(query.recipesFolder ?? "recipes")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  const sourceLabel = recipesFolder || ".";
  const root = recipesFolder ? ensureWithin(vaultRoot, path.join(vaultRoot, recipesFolder)) : vaultRoot;
  return { recipesFolder, sourceLabel, root };
}

async function loadRecipeDatabaseItems(vaultRoot, query = {}) {
  const { recipesFolder, sourceLabel, root } = recipeSourceRoot(vaultRoot, query);
  let sourceStat;
  try {
    sourceStat = await stat(root);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `Configured recipe source '${sourceLabel}' does not exist under the current vault root.`
      );
    }
    throw new Error(
      `Failed to inspect configured recipe source '${sourceLabel}': ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!sourceStat.isDirectory()) {
    throw new Error(`Configured recipe source '${sourceLabel}' is not a directory.`);
  }
  let markdownFiles;
  try {
    markdownFiles = await collectMarkdownFiles(vaultRoot, root);
  } catch (error) {
    throw new Error(
      `Failed to read configured recipe source '${sourceLabel}': ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const items = [];

  for (const filePath of markdownFiles) {
    let content;
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      throw new Error(
        `Failed to read recipe '${toVaultRelative(filePath, vaultRoot)}' from configured source '${sourceLabel}': ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const frontmatter = parseFrontmatter(content);
    const rawType = String(frontmatter.type ?? "").trim().toLowerCase();
    const isQuickMeal =
      frontmatter.quickMeal === true ||
      String(frontmatter.quickMeal ?? "").trim().toLowerCase() === "true";
    const isRecipeLike = rawType === "recipe" || (rawType === "reminder" && isQuickMeal);
    if (rawType && !isRecipeLike) continue;

    const relativePath = toVaultRelative(filePath, vaultRoot);
    const basename = path.basename(relativePath, path.extname(relativePath));
    const scheduledDates = getStringList(frontmatter.scheduledDates);
    if (scheduledDates.length === 0) scheduledDates.push(...getStringList(frontmatter.scheduled));
    if (scheduledDates.length === 0) {
      const fallbackDate = getString(frontmatter.date);
      if (fallbackDate) scheduledDates.push(fallbackDate);
    }
    const scheduled = scheduledDates[0] ?? null;
    const added = getString(frontmatter.added);

    items.push({
      path: relativePath,
      title: getString(frontmatter.title) ?? basename,
      coverPath: getString(frontmatter.cover),
      marked: frontmatter.marked === true,
      added,
      scheduled,
      scheduledDates,
      addedTimestamp: toTimestamp(added),
      scheduledTimestamp: toTimestamp(scheduled),
      tags: parseTags(frontmatter.tags)
    });
  }

  return items;
}

function selectRecipeDatabaseView(items, query = {}) {
  const filter = query.filter ?? {};
  let filtered = items;
  if (typeof filter.marked === "boolean") {
    filtered = filtered.filter((item) => item.marked === filter.marked);
  }
  if (typeof filter.scheduled === "boolean") {
    filtered = filtered.filter((item) => (item.scheduledDates?.length ?? 0) > 0 === filter.scheduled);
  }
  if (filter.addedAfter) {
    filtered = filtered.filter((item) => (item.addedTimestamp ?? 0) >= filter.addedAfter);
  }
  if (Array.isArray(filter.tags) && filter.tags.length > 0) {
    filtered = filtered.filter((item) => filter.tags.every((tag) => item.tags.includes(tag)));
  }

  const search = typeof query.search === "string" ? query.search.toLowerCase().trim() : "";
  if (search) {
    filtered = filtered.filter(
      (item) =>
        item.title.toLowerCase().includes(search) ||
        item.path.toLowerCase().includes(search)
    );
  }

  const availableTags = Array.from(new Set(items.flatMap((item) => item.tags))).sort();
  const markedCount = items.filter((item) => item.marked).length;
  const sorted = sortRecipeItems(filtered, query.sortBy ?? "added-desc");
  const limited = query.limit ? sorted.slice(0, query.limit) : sorted;

  return {
    items: limited,
    total: filtered.length,
    availableTags,
    markedCount
  };
}

async function buildRecipeDatabaseView(vaultRoot, query = {}) {
  return selectRecipeDatabaseView(await loadRecipeDatabaseItems(vaultRoot, query), query);
}

function pathIsWithin(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

function recipeWatchEventPath(event) {
  const candidates = [event?.path, event?.oldPath, event?.old_path];
  return candidates
    .filter((candidate) => typeof candidate === "string" && candidate.length > 0)
    .map((candidate) => path.normalize(candidate));
}

function normalizeRecipeWatchPath(candidate, vaultRoot) {
  if (path.isAbsolute(candidate)) {
    const virtualPrefix = `${DEFAULT_VIRTUAL_VAULT}${path.sep}`;
    if (candidate === DEFAULT_VIRTUAL_VAULT || candidate.startsWith(virtualPrefix)) {
      return path.join(vaultRoot, candidate.slice(DEFAULT_VIRTUAL_VAULT.length));
    }
    return candidate;
  }
  return path.resolve(vaultRoot, candidate);
}

function recipeWatchEventAffectsSource(event, sourceRoot, vaultRoot) {
  const kind = String(event?.kind ?? "").toLowerCase();
  return recipeWatchEventPath(event).some((candidate) => {
    const resolved = normalizeRecipeWatchPath(candidate, vaultRoot);
    if (!pathIsWithin(sourceRoot, resolved)) return false;
    const extension = path.extname(resolved).toLowerCase();
    return extension === ".md" || kind === "remove" || kind === "rename";
  });
}

function createRecipeDatabaseIndex(vaultRoot) {
  let cache = null;

  const load = async (query) => {
    const { recipesFolder } = recipeSourceRoot(vaultRoot, query);
    if (!cache || cache.recipesFolder !== recipesFolder) {
      cache = { recipesFolder, items: null, build: null, generation: 0 };
    }
    const state = cache;
    while (true) {
      if (cache !== state) return load(query);
      const generation = state.generation;
      if (state.items) return state.items;
      if (!state.build) {
        let build;
        build = loadRecipeDatabaseItems(vaultRoot, query).then((items) => {
          if (cache === state && state.generation === generation) state.items = items;
          return items;
        }, (error) => {
          if (state.build === build) state.build = null;
          throw error;
        });
        state.build = build;
      }
      const items = await state.build;
      if (state.generation === generation) return items;
    }
  };

  return {
    async view(query = {}) {
      return selectRecipeDatabaseView(await load(query), query);
    },
    invalidate(batch) {
      const events = Array.isArray(batch?.events) ? batch.events : [];
      if (events.length === 0) return false;
      if (!cache) return false;
      const sourceRoot = path.resolve(vaultRoot, cache.recipesFolder);
      if (!events.some((event) => recipeWatchEventAffectsSource(event, sourceRoot, vaultRoot))) {
        return false;
      }
      cache.items = null;
      cache.build = null;
      cache.generation += 1;
      return true;
    },
  };
}

function recipeDatabaseStreamEvents(view, batchSize = 50) {
  const events = [{ event: "started", data: { total: view.total } }];
  for (let offset = 0; offset < view.items.length; offset += batchSize) {
    events.push({
      event: "batch",
      data: { items: view.items.slice(offset, offset + batchSize), offset }
    });
  }
  events.push({
    event: "done",
    data: {
      totalCount: view.total,
      markedCount: view.markedCount,
      availableTags: view.availableTags
    }
  });
  return events;
}

function normalizeVaultImagePath(rawPath, vaultRoot) {
  const input = String(rawPath || "").trim();
  if (!input) throw new Error("Missing image path.");
  if (input.startsWith(DEFAULT_VIRTUAL_VAULT)) {
    return ensureWithin(vaultRoot, path.join(vaultRoot, input.slice(DEFAULT_VIRTUAL_VAULT.length)));
  }
  if (path.isAbsolute(input)) {
    return ensureWithin(vaultRoot, input);
  }
  return ensureWithin(vaultRoot, path.join(vaultRoot, input));
}

async function resolveVaultImagePath(rawPath, vaultRoot) {
  const [candidate, resolvedVaultRoot] = await Promise.all([
    realpath(normalizeVaultImagePath(rawPath, vaultRoot)),
    realpath(vaultRoot)
  ]);
  return ensureWithin(resolvedVaultRoot, candidate);
}

function thumbnailUrlForVersion(version, extension = "jpg") {
  if (!/^v4-(320|640)-[a-f0-9]{64}$/.test(version)) {
    throw new Error("Invalid thumbnail version.");
  }
  if (!["jpg", "png", "webp", "avif"].includes(extension)) {
    throw new Error("Invalid thumbnail extension.");
  }
  return `/api/thumbnail/${version}.${extension}`;
}

function thumbnailSize(size) {
  if (size === "card") return 320;
  if (size === "detail" || size === undefined || size === null) return 640;
  throw new Error("Thumbnail size must be card or detail.");
}

function thumbnailPathForVersion(appDataRoot, version, extension = "jpg") {
  if (!/^v4-(320|640)-[a-f0-9]{64}$/.test(version)) {
    throw new Error("Thumbnail not found");
  }
  if (!["jpg", "png", "webp", "avif"].includes(extension)) {
    throw new Error("Thumbnail not found");
  }
  return path.join(appDataRoot, "thumbnails", "v4", `${version}.${extension}`);
}

function thumbnailCacheRootForAppData(appDataRoot) {
  return appDataRoot;
}

async function handleInvoke(
  appDataRoot,
  vaultRoot,
  payload,
  cookingRuntime = null,
  recipeDatabaseIndex = null
) {
  const { cmd, args = {} } = payload;
  switch (cmd) {
    case "mep_cooking_build_desired_items":
      if (!cookingRuntime) throw new Error("Rust cooking helper is unavailable");
      return cookingRuntime.buildDesiredItems(args.recipes);
    case "mep_shopping_list":
      if (!cookingRuntime) throw new Error("Rust shopping helper is unavailable");
      return cookingRuntime.shoppingList();
    case "mep_shopping_preview":
      if (!cookingRuntime) throw new Error("Rust shopping helper is unavailable");
      return cookingRuntime.shoppingPreview(args.weekLabel, args.desiredItems);
    case "mep_shopping_apply":
      if (!cookingRuntime) throw new Error("Rust shopping helper is unavailable");
      return cookingRuntime.shoppingApply(args.expectedRevision, args.weekLabel, args.desiredItems);
    case "mep_shopping_check":
      if (!cookingRuntime) throw new Error("Rust shopping helper is unavailable");
      return cookingRuntime.shoppingCheck(args.expectedRevision, args.itemId, args.checked);
    case "mep_shopping_add":
      if (!cookingRuntime) throw new Error("Rust shopping helper is unavailable");
      return cookingRuntime.shoppingAdd(args.expectedRevision, args.content, args.labels);
    case "mep_shopping_remove":
      if (!cookingRuntime) throw new Error("Rust shopping helper is unavailable");
      return cookingRuntime.shoppingRemove(args.expectedRevision, args.itemId);
    case "mep_shopping_rollback":
      if (!cookingRuntime) throw new Error("Rust shopping helper is unavailable");
      return cookingRuntime.shoppingRollback(args.expectedRevision);
    case "mep_recipe_database_stream": {
      const view = recipeDatabaseIndex
        ? await recipeDatabaseIndex.view(args.query ?? {})
        : await buildRecipeDatabaseView(vaultRoot, args.query ?? {});
      return { events: recipeDatabaseStreamEvents(view) };
    }
    case "mep_get_thumbnail": {
      if (!cookingRuntime) throw new Error("Rust cooking helper is unavailable");
      const sourcePath = await resolveVaultImagePath(args.path, vaultRoot);
      const thumbnail = await cookingRuntime.createThumbnail(sourcePath, thumbnailSize(args.size));
      return thumbnailUrlForVersion(thumbnail.version, thumbnail.extension);
    }
    case "mep_get_thumbnails": {
      if (!cookingRuntime) throw new Error("Rust cooking helper is unavailable");
      const sourcePaths = Array.isArray(args.paths)
        ? await Promise.all(args.paths.map((entry) => resolveVaultImagePath(entry, vaultRoot)))
        : [];
      if (sourcePaths.length > 500) throw new Error("At most 500 thumbnails can be requested.");
      const thumbnails = await cookingRuntime.createThumbnails(sourcePaths, thumbnailSize(args.size));
      return thumbnails.map((thumbnail) => thumbnail ? thumbnailUrlForVersion(thumbnail.version, thumbnail.extension) : null);
    }
    case "mep_prepare_database_thumbnails": {
      if (!cookingRuntime) throw new Error("Rust cooking helper is unavailable");
      const sourcePaths = Array.isArray(args.paths)
        ? await Promise.all(args.paths.map((entry) => resolveVaultImagePath(entry, vaultRoot)))
        : [];
      if (sourcePaths.length > 500) throw new Error("At most 500 thumbnails can be requested.");
      const thumbnails = await cookingRuntime.prepareDatabaseThumbnails(sourcePaths);
      return thumbnails.map((thumbnail) => thumbnail ? thumbnailUrlForVersion(thumbnail.version, thumbnail.extension) : null);
    }
    default:
      throw new Error(`Unsupported invoke command: ${cmd}`);
  }
}

function sseFrame(event, data, id) {
  const lines = [];
  if (id !== undefined && id !== null) lines.push(`id: ${id}`);
  lines.push(`event: ${event}`);
  for (const line of JSON.stringify(data).split("\n")) {
    lines.push(`data: ${line}`);
  }
  return `${lines.join("\n")}\n\n`;
}

class VaultWatchSseHub {
  constructor(mapper) {
    this.mapper = mapper;
    this.generation = 0;
    this.sourceGeneration = null;
    this.alive = false;
    this.clients = new Set();
  }

  setStatus(status) {
    const observed = Number(status?.generation);
    if (Number.isSafeInteger(observed) && observed >= 0) {
      this.generation = Math.max(this.generation, observed);
      this.sourceGeneration = observed;
    }
    this.alive = status?.alive === true;
  }

  beginSource() {
    this.sourceGeneration = null;
    this.alive = false;
  }

  confirmSource(status) {
    const observed = Number(status?.generation);
    if (Number.isSafeInteger(observed) && observed >= 0) {
      this.sourceGeneration = this.sourceGeneration === null
        ? observed
        : Math.max(this.sourceGeneration, observed);
    }
    this.alive = status?.alive === true;
  }

  statusSince(generation) {
    const cursor = Number.isSafeInteger(generation) && generation >= 0 ? generation : 0;
    return {
      generation: this.generation,
      alive: this.alive,
      changed: this.generation > cursor
    };
  }

  attach(req, res, generation) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    if (!this.#write(res, sseFrame("status", this.statusSince(generation), this.generation))) {
      return;
    }
    this.clients.add(res);
    const detach = () => this.clients.delete(res);
    res.once("close", detach);
  }

  publish(batch) {
    const events = Array.isArray(batch?.events) ? batch.events : [];
    const sourceGeneration = Number(batch?.generation);
    if (events.length > 0) {
      const advance = this.sourceGeneration === null
        ? 1
        : Number.isSafeInteger(sourceGeneration) && sourceGeneration > this.sourceGeneration
          ? sourceGeneration - this.sourceGeneration
          : 0;
      this.generation += advance;
    }
    if (Number.isSafeInteger(sourceGeneration) && sourceGeneration >= 0) {
      this.sourceGeneration = this.sourceGeneration === null
        ? sourceGeneration
        : Math.max(this.sourceGeneration, sourceGeneration);
    }
    const mapped = {
      ...batch,
      generation: this.generation,
      events: events
        .map((event) => ({
            ...event,
            path: this.mapper.toVirtualPath(event.path, "vault"),
            oldPath: event.oldPath
              ? this.mapper.toVirtualPath(event.oldPath, "vault")
              : null
          }))
    };
    this.alive = mapped.alive === true;
    const frame = sseFrame("batch", mapped, this.generation);
    for (const client of this.clients) this.#write(client, frame);
  }

  fail() {
    this.publish({
      generation: this.generation,
      alive: false,
      events: []
    });
  }

  close() {
    for (const client of this.clients) client.end();
    this.clients.clear();
  }

  #write(client, frame) {
    try {
      if (client.write(frame)) return true;
    } catch {
      // The client is no longer usable; source-truth resume owns recovery.
    }
    this.clients.delete(client);
    client.destroy();
    return false;
  }
}

function createVaultWatchRuntime({
  vaultRoot,
  helper,
  watchHub,
  recipeDatabaseIndex = null
}) {
  helper.onWatch((batch) => {
    recipeDatabaseIndex?.invalidate(batch);
    watchHub.publish(batch);
  });
  helper.onWatchFailure(() => watchHub.fail());

  const startWatcher = async () => {
    watchHub.beginSource();
    try {
      const status = await helper.startWatch(vaultRoot, [
        { id: "vault", path: vaultRoot }
      ]);
      watchHub.confirmSource(status);
      return status;
    } catch (error) {
      watchHub.fail();
      throw error;
    }
  };

  return {
    startConfigured() {
      return startWatcher();
    },
    async ensureStarted(generation) {
      if (!watchHub.alive) await startWatcher();
      return watchHub.statusSince(generation);
    }
  };
}

function isLoopbackBind(host) {
  return host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
}

function isTrustedTailscaleServeRequest(bindHost, headers) {
  if (!isLoopbackBind(bindHost)) return false;
  const hostHeader = typeof headers.host === "string" ? headers.host.trim() : "";
  const match = hostHeader.match(
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net(?::([1-9]\d{0,4}))?$/i
  );
  if (!match || (match[1] && Number(match[1]) > 65_535)) return false;
  const login = headers["tailscale-user-login"];
  return typeof login === "string" && login.trim().length > 0;
}

function createRequestHandler({
  appDataRoot,
  vaultRoot,
  mapper,
  token,
  host,
  port,
  cookingRuntime = null,
  watchHub = null,
  watchRuntime = null,
  recipeDatabaseIndex = createRecipeDatabaseIndex(vaultRoot),
  thumbnailCacheRoot = thumbnailCacheRootForAppData(appDataRoot),
  distDir = DIST_DIR
}) {
  const allowedHosts = new Set([`${host}:${port}`, `localhost:${port}`]);
  const indexFile = path.join(distDir, "index.html");

  return async (req, res) => {
    try {
      applySecurityHeaders(res);
      if (
        !allowedHosts.has(req.headers.host) &&
        !isTrustedTailscaleServeRequest(host, req.headers)
      ) {
        json(res, 403, { error: "Forbidden host" });
        return;
      }

      const requestUrl = new URL(req.url || "/", `http://${host}:${port}`);
      const thumbnailMatch = requestUrl.pathname.match(/^\/api\/thumbnail\/(v4-(?:320|640)-[a-f0-9]{64})\.(jpg|png|webp|avif)$/);
      if (
        requestUrl.pathname.startsWith("/api/") &&
        requestUrl.pathname !== "/api/health" &&
        !thumbnailMatch &&
        req.headers.authorization !== `Bearer ${token}`
      ) {
        json(res, 401, { error: "Unauthorized" });
        return;
      }

      if (req.method === "GET" && requestUrl.pathname === "/api/health") {
        json(res, 200, {
          ok: true,
          mode: "remote-host",
          vaultPath: DEFAULT_VIRTUAL_VAULT
        });
        return;
      }

      if (req.method === "GET" && requestUrl.pathname === "/api/watch") {
        if (!watchHub) {
          json(res, 503, { error: "Vault watcher unavailable" });
          return;
        }
        const lastEventId = Number(req.headers["last-event-id"]);
        const queryGeneration = Number(requestUrl.searchParams.get("generation"));
        const generation = Number.isSafeInteger(lastEventId) && lastEventId >= 0
          ? lastEventId
          : queryGeneration;
        watchHub.attach(req, res, generation);
        return;
      }

      if (req.method === "POST" && requestUrl.pathname === "/api/watch/status") {
        if (!watchHub) {
          json(res, 503, { error: "Vault watcher unavailable" });
          return;
        }
        const payload = await readBody(req);
        json(res, 200, watchHub.statusSince(payload.generation));
        return;
      }

      if (req.method === "POST" && requestUrl.pathname === "/api/watch/start") {
        if (!watchHub || !watchRuntime) {
          json(res, 503, { error: "Vault watcher unavailable" });
          return;
        }
        const payload = await readBody(req);
        json(res, 200, await watchRuntime.ensureStarted(payload.generation));
        return;
      }

      if (req.method === "POST" && requestUrl.pathname === "/api/invoke") {
        const payload = await readBody(req);
        const result = await handleInvoke(
          appDataRoot,
          vaultRoot,
          payload,
          cookingRuntime,
          recipeDatabaseIndex
        );
        json(res, 200, result);
        return;
      }

      if (
        (req.method === "GET" || req.method === "HEAD") &&
        thumbnailMatch
      ) {
        if (!hasThumbnailAuthorization(req, token)) {
          json(res, 401, { error: "Unauthorized" });
          return;
        }
        const imagePath = thumbnailPathForVersion(thumbnailCacheRoot, thumbnailMatch[1], thumbnailMatch[2]);
        const info = await stat(imagePath);
        if (!info.isFile()) {
          json(res, 404, { error: "Thumbnail not found" });
          return;
        }
        res.writeHead(200, {
          "Content-Type": contentTypeFor(imagePath),
          "Cache-Control": "private, max-age=31536000, immutable",
          Vary: "Cookie"
        });
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        const stream = createReadStream(imagePath);
        stream.on("error", (error) => {
          if (!res.headersSent) {
            json(res, 404, { error: "Thumbnail not found" });
          } else {
            res.destroy(error);
          }
        });
        stream.pipe(res);
        return;
      }

      if (req.method === "POST" && requestUrl.pathname.startsWith("/api/fs/")) {
        const payload = await readBody(req);
        const op = requestUrl.pathname.slice("/api/fs/".length);

        switch (op) {
          case "exists": {
            const resolved = mapper.resolveReal(payload.path);
            if (resolved.kind === "virtual-root" || resolved.kind === "virtual-home") {
              json(res, 200, { exists: true });
              return;
            }
            json(res, 200, { exists: await fileExists(resolved.realPath) });
            return;
          }
          case "mkdir": {
            const resolved = mapper.resolveReal(payload.path);
            if (!resolved.realPath) {
              json(res, 200, null);
              return;
            }
            await mkdir(resolved.realPath, { recursive: true });
            json(res, 200, null);
            return;
          }
          case "read-text": {
            const resolved = mapper.resolveReal(payload.path);
            const content = await readFile(resolved.realPath, "utf8");
            json(res, 200, { content });
            return;
          }
          case "read-text-batch": {
            const files = await readTextBatch(mapper, payload.paths);
            json(res, 200, { files });
            return;
          }
          case "write-text": {
            const resolved = mapper.resolveReal(payload.path);
            await mkdir(path.dirname(resolved.realPath), { recursive: true });
            await writeFile(resolved.realPath, String(payload.content ?? ""), "utf8");
            recipeDatabaseIndex?.invalidate({
              events: [{ kind: "modify", path: resolved.realPath }]
            });
            json(res, 200, null);
            return;
          }
          case "read-file": {
            const resolved = mapper.resolveReal(payload.path);
            const data = await readFile(resolved.realPath);
            json(res, 200, {
              dataBase64: Buffer.from(data).toString("base64")
            });
            return;
          }
          case "write-file": {
            const resolved = mapper.resolveReal(payload.path);
            await mkdir(path.dirname(resolved.realPath), { recursive: true });
            await writeFile(
              resolved.realPath,
              Buffer.from(String(payload.dataBase64 || ""), "base64")
            );
            recipeDatabaseIndex?.invalidate({
              events: [{ kind: "modify", path: resolved.realPath }]
            });
            json(res, 200, null);
            return;
          }
          case "read-dir": {
            const recursive = Boolean(payload.options?.recursive);
            const entries = recursive
              ? await listDirectoryRecursive(mapper, payload.path)
              : await listDirectoryEntries(mapper, payload.path);
            json(res, 200, { entries });
            return;
          }
          case "remove": {
            const resolved = mapper.resolveReal(payload.path);
            if (!resolved.realPath) {
              throw new Error("Cannot remove a virtual root.");
            }
            await rm(resolved.realPath, {
              recursive: Boolean(payload.options?.recursive),
              force: false
            });
            recipeDatabaseIndex?.invalidate({
              events: [{ kind: "remove", path: resolved.realPath }]
            });
            json(res, 200, null);
            return;
          }
          case "stat": {
            const resolved = mapper.resolveReal(payload.path);
            if (resolved.kind === "virtual-root" || resolved.kind === "virtual-home") {
              json(res, 200, {
                isFile: false,
                isDirectory: true,
                isSymlink: false,
                size: 0,
                mtime: null
              });
              return;
            }
            const info = await stat(resolved.realPath);
            json(res, 200, {
              isFile: info.isFile(),
              isDirectory: info.isDirectory(),
              isSymlink: info.isSymbolicLink(),
              size: info.size,
              mtime: info.mtime.toISOString()
            });
            return;
          }
          case "rename": {
            const source = mapper.resolveReal(payload.oldPath);
            const target = mapper.resolveReal(payload.newPath);
            if (!source.realPath || !target.realPath) {
              throw new Error("Cannot rename virtual roots.");
            }
            await mkdir(path.dirname(target.realPath), { recursive: true });
            await rename(source.realPath, target.realPath);
            recipeDatabaseIndex?.invalidate({
              events: [{ kind: "rename", path: target.realPath, oldPath: source.realPath }]
            });
            json(res, 200, null);
            return;
          }
          default:
            throw new Error(`Unsupported fs operation: ${op}`);
        }
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }

      const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
      const safePath = path.resolve(path.join(distDir, pathname.replace(/^\/+/, "")));
      if (!safePath.startsWith(`${distDir}${path.sep}`) && safePath !== indexFile) {
        json(res, 403, { error: "Forbidden" });
        return;
      }

      let filePath = safePath;
      if (!(await fileExists(filePath)) || (await stat(filePath)).isDirectory()) {
        // Hashed asset requests must fail loudly instead of silently
        // resolving to the SPA shell and corrupting the module graph.
        if (pathname.startsWith("/assets/")) {
          json(res, 404, { error: "Not found" });
          return;
        }
        filePath = indexFile;
      }

      if (filePath === indexFile) {
        const raw = await readFile(indexFile, "utf8");
        const html = injectRemoteHostConfig(raw, token);
        if (html !== raw) {
          // The runtime-config bootstrap must stay inline; allow exactly its
          // bytes under script-src instead of relaxing to unsafe-inline.
          res.setHeader(
            "Content-Security-Policy",
            contentSecurityPolicy([inlineScriptSource(remoteHostConfigScript(token))])
          );
        }
        res.setHeader("Set-Cookie", thumbnailCookie(token, requestUsesSecureTransport(req)));
        sendStatic(res, req, 200, html, "text/html; charset=utf-8", { "Cache-Control": "no-store" });
        return;
      }

      const body = await readFile(filePath);
      sendStatic(res, req, 200, body, contentTypeFor(filePath), {
        "Cache-Control": cacheControlForDistFile(filePath, distDir)
      });
    } catch (error) {
      const status = error?.statusCode === 413 ? 413 : error?.code === "ENOENT" ? 404 : 500;
      const message = status === 404
        ? "Not found"
        : error instanceof Error
          ? error.message
          : "Unknown error";
      json(res, status, { error: message });
    }
  };
}

async function start() {
  const args = parseArgs(process.argv.slice(2));
  const port = Number(args.port || process.env.MEP_HOST_PORT || DEFAULT_PORT);
  const host = args.host || process.env.MEP_HOST_BIND || DEFAULT_HOST;
  const vaultRoot = await selectVaultRoot({ args });
  const appDataRoot = path.resolve(
    expandTilde(
      args.appdata ||
        process.env.MEP_HOST_APPDATA_PATH ||
        path.join(os.homedir(), DEFAULT_APPDATA_NAME)
    )
  );
  // Settings, shopping state, and the ledger stay under appDataRoot (~/.mep-web-host by
  // default); only the thumbnail cache defaults to the native app's
  // app-data directory so both runtimes share one set of generated files.
  const thumbnailCacheRoot = path.resolve(
    expandTilde(
      args["thumbnail-cache"] ||
        process.env.MEP_HOST_THUMBNAIL_CACHE_PATH ||
        resolveDefaultThumbnailCacheRoot()
    )
  );
  const helperCommand = await resolveRustHelperBinary(args["rust-helper"]);

  if (!(await fileExists(INDEX_FILE))) {
    console.error(`Missing ${INDEX_FILE}. Run \`npm run build\` first.`);
    process.exit(1);
  }

  await ensureServerFiles({
    vaultRoot,
    appDataRoot
  });
  const mapper = createVirtualMapper({ vaultRoot, appDataRoot });
  const token = process.env.MEP_HOST_TOKEN || crypto.randomUUID();
  const cookingRuntime = new RustCookingHelperClient({
    command: helperCommand,
    configDir: path.join(vaultRoot, ".mep"),
    shoppingDataDir: appDataRoot,
    thumbnailCacheDir: thumbnailCacheRoot
  });
  await cookingRuntime.start();
  const watchHub = new VaultWatchSseHub(mapper);
  const recipeDatabaseIndex = createRecipeDatabaseIndex(vaultRoot);
  const hostSettings = JSON.parse(
    await readFile(path.join(appDataRoot, "settings.json"), "utf8")
  );
  const watchRuntime = createVaultWatchRuntime({
    vaultRoot,
    mapper,
    helper: cookingRuntime,
    watchHub,
    recipeDatabaseIndex,
    hostSettings
  });
  await watchRuntime.startConfigured();
  const server = http.createServer(
    createRequestHandler({
      appDataRoot,
      vaultRoot,
      mapper,
      token,
      host,
      port,
      cookingRuntime,
      watchHub,
      watchRuntime,
      recipeDatabaseIndex,
      thumbnailCacheRoot
    })
  );

  // listen() emits startup failures instead of throwing; exit non-zero so
  // benchmark and preview supervisors do not keep using a stale server.
  server.on("error", (error) => {
    if (error && error.code === "EADDRINUSE") {
      console.error(`Enplace web host cannot start: ${host}:${port} is already in use. Stop the process bound to it and retry.`);
    } else {
      console.error("Enplace web host failed to start:", error);
    }
    process.exit(1);
  });
  server.listen(port, host, () => {
    console.log(`Enplace web host listening on http://${host}:${port}/`);
    console.log(`Vault root: ${vaultRoot}`);
    console.log(`App data: ${appDataRoot}`);
    console.log(`Thumbnail cache: ${thumbnailCacheRoot}`);
    console.log(`Rust cooking helper: ${helperCommand}`);
    console.log("Tailscale tip: keep this bound to 127.0.0.1 and expose it with `tailscale serve`.");
  });
  const shutdown = () => {
    watchHub.close();
    cookingRuntime.stop();
    server.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

export {
  buildRecipeDatabaseView,
  createRecipeDatabaseIndex,
  defaultVaultRoot,
  selectVaultRoot,
  contentTypeFor,
  createRequestHandler,
  createVirtualMapper,
  createVaultWatchRuntime,
  RustCookingHelperClient,
  VaultWatchSseHub,
  DEFAULT_SETTINGS,
  handleInvoke,
  injectRemoteHostConfig,
  readBody,
  recipeDatabaseStreamEvents,
  resolveDefaultThumbnailCacheRoot,
  resolveHostVaultRoot,
  resolveRustHelperBinary,
  thumbnailCookie,
  requestUsesSecureTransport,
  thumbnailCacheRootForAppData,
  thumbnailPathForVersion,
  thumbnailSize,
  thumbnailUrlForVersion,
  hasThumbnailAuthorization
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
