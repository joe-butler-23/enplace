import { defineConfig } from "@playwright/test";

const port = 4193;

export default defineConfig({
	testDir: "tests/kanban-client",
	workers: 1,
	timeout: 30_000,
	expect: { timeout: 5_000 },
	webServer: {
		command: `npm run build:kanban-client && vite --host 127.0.0.1 --port ${port} --strictPort`,
		port,
		reuseExistingServer: false,
	},
	use: {
		baseURL: `http://127.0.0.1:${port}`,
	},
});
