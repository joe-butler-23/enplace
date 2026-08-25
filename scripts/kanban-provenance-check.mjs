import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("portable kanban builds fail without exact Git provenance", () => {
	const result = spawnSync(
		process.execPath,
		[path.resolve(root, "node_modules/vite/bin/vite.js"), "build", "--config", "vite.kanban-core.config.ts"],
		{
			cwd: root,
			encoding: "utf8",
			env: { ...process.env, PATH: "" },
		},
	);

	assert.notEqual(result.status, 0, "build unexpectedly succeeded without Git");
	assert.match(
		`${result.stdout}\n${result.stderr}`,
		/Cannot build portable kanban artifacts without an exact Git source commit/,
	);
});
