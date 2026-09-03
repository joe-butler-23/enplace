import { browserSuiteConfig } from "./playwright.shared";

export default browserSuiteConfig({
  testDir: "tests/thumbnails",
  workers: 1,
  command: (port) => `npx vite --host 127.0.0.1 --port ${port}`
});
