// Shared port/baseURL resolution for Playwright configs.
//
// Use a per-invocation port so concurrent browser suites cannot reuse an old
// preview. PLAYWRIGHT_PORT still overrides when a specific port is wanted.

export function resolvePlaywrightPort(): number {
  const envPort = process.env.PLAYWRIGHT_PORT;
  if (envPort) {
    const parsed = Number(envPort);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  // Deterministic-per-invocation: derived from the main runner process's pid
  // so concurrent invocations do not collide on 4173.
  // Playwright's test workers are separate forked processes that each
  // re-import this config, so the chosen port is stamped back into
  // process.env here — forked children inherit it and agree with the
  // webServer the main process actually started, instead of each worker
  // deriving a different port from its own pid.
  const port = 4200 + (process.pid % 800);
  process.env.PLAYWRIGHT_PORT = String(port);
  return port;
}

export function resolvePlaywrightBaseURL(port: number): string {
  return process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`;
}

export function resolvePlaywrightRelayPort(): number {
  const envPort = process.env.PLAYWRIGHT_RELAY_PORT;
  if (envPort) {
    const parsed = Number(envPort);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  const port = 14_200 + (process.pid % 800);
  process.env.PLAYWRIGHT_RELAY_PORT = String(port);
  return port;
}

import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";

type BrowserSuiteOptions = {
  command: (port: number, relayPort: number) => string;
  relay?: boolean;
  testDir: string;
  testMatch?: string;
  testIgnore?: string[];
  workers?: number;
  timeout?: number;
  expectTimeout?: number;
  trace?: NonNullable<PlaywrightTestConfig["use"]>["trace"];
};

export function browserSuiteConfig(options: BrowserSuiteOptions): PlaywrightTestConfig {
  const port = resolvePlaywrightPort();
  const relayPort = resolvePlaywrightRelayPort();
  const appServer = {
    command: options.command(port, relayPort),
    port,
    reuseExistingServer: false,
  };
  return defineConfig({
    testDir: options.testDir,
    testMatch: options.testMatch,
    testIgnore: options.testIgnore,
    workers: options.workers,
    timeout: options.timeout,
    expect: { timeout: options.expectTimeout ?? 10_000 },
    webServer: options.relay ? [
      {
        command: `node scripts/kitchen-relay.mjs --port ${relayPort}`,
        port: relayPort,
        reuseExistingServer: false,
      },
      appServer,
    ] : appServer,
    use: {
      baseURL: resolvePlaywrightBaseURL(port),
      trace: options.trace ?? "on-first-retry"
    }
  });
}
