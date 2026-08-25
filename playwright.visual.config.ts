import { defineConfig } from "@playwright/test";

const port = 4183;

export default defineConfig({
  testDir: "tests",
  testMatch: "visual-stability.spec.ts",
  workers: 1,
  timeout: 60000,
  expect: { timeout: 10000 },
  webServer: {
    command: `npm run build && npm run preview -- --host 127.0.0.1 --port ${port}`,
    port,
    reuseExistingServer: false
  },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "on-first-retry"
  }
});
