import { browserSuiteConfig } from "./playwright.shared";

export default browserSuiteConfig({
  testDir: "tests/kanban-client",
  workers: 1,
  timeout: 30_000,
  expectTimeout: 5_000,
  command: (port) => `vite build --config vite.kanban-core.config.ts && vite --host 127.0.0.1 --port ${port} --strictPort`
});
