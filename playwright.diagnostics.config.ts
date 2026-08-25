import { defineConfig } from "@playwright/test";
import { resolvePlaywrightPort, resolvePlaywrightBaseURL } from "./playwright.shared";

const port = resolvePlaywrightPort();
const baseURL = resolvePlaywrightBaseURL(port);

export default defineConfig({
  testDir: "tests/diagnostics",
  timeout: 120000,
  expect: {
    timeout: 15000,
  },
  webServer: {
    command: `npm run build && npm run preview -- --port ${port}`,
    port,
    reuseExistingServer: false,
  },
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
});
