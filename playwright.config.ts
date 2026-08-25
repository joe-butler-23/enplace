import { defineConfig } from "@playwright/test";
import { resolvePlaywrightPort, resolvePlaywrightBaseURL } from "./playwright.shared";

const port = resolvePlaywrightPort();
const baseURL = resolvePlaywrightBaseURL(port);

export default defineConfig({
  testDir: "tests",
  testIgnore: ["visual-stability.spec.ts", "kanban-client/**"],
  timeout: 60000,
  expect: {
    timeout: 10000
  },
  webServer: {
    command: `npm run build && npm run preview -- --port ${port}`,
    port,
    reuseExistingServer: false
  },
  use: {
    baseURL,
    trace: "on-first-retry"
  }
});
