// Shared port/baseURL resolution for Playwright configs.
//
// Both playwright.config.ts and playwright.diagnostics.config.ts used to default
// to a fixed port (4173) with reuseExistingServer enabled outside CI. Any stale
// server already bound to that port (an orphaned preview, an ssh tunnel, a
// stale leftover) would silently get reused and serve an arbitrary old
// build to the whole suite. Default to a per-invocation ephemeral port instead
// so a fresh server is always the one under test; PLAYWRIGHT_PORT still
// overrides when a specific port is genuinely wanted.

export function resolvePlaywrightPort(): number {
  const envPort = process.env.PLAYWRIGHT_PORT;
  if (envPort) {
    const parsed = Number(envPort);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  // Deterministic-per-invocation: derived from the main runner process's pid
  // so concurrent invocations (local + CI + remote host) don't collide on 4173.
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
