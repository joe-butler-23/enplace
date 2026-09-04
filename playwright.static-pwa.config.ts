import { browserSuiteConfig } from "./playwright.shared";

export default browserSuiteConfig({
  testDir: "tests/static-pwa",
  workers: 1,
  timeout: 60_000,
  expectTimeout: 15_000,
  relay: true,
  command: (port, relayPort) => `npm run build:sample-pack && VITE_ENPLACE_RELAY_URL=ws://127.0.0.1:${relayPort} npx vite build --mode static --outDir tmp/static-pwa-a && VITE_ENPLACE_RELAY_URL=ws://127.0.0.1:${relayPort}/ npx vite build --mode static --outDir tmp/static-pwa-b && rm -rf dist-static && cp -a tmp/static-pwa-a dist-static && npx vite preview --host 127.0.0.1 --port ${port} --outDir dist-static`
});
