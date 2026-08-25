import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KANBAN_CORE_DIR = dirname(fileURLToPath(import.meta.url));

const FORBIDDEN_SOURCES: Array<{ label: string; test: (specifier: string) => boolean }> = [
	{ label: "react", test: (specifier) => specifier === "react" || specifier.startsWith("react/") },
	{ label: "@/platform", test: (specifier) => specifier.startsWith("@/platform") },
	{ label: "@/vendor", test: (specifier) => specifier.startsWith("@/vendor") },
	{ label: "src/modules", test: (specifier) => specifier.split("/").includes("modules") },
];

const IMPORT_SOURCE_PATTERN = /(?:import|export)[^'"]*from\s+["']([^"']+)["']/g;

function collectSourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...collectSourceFiles(fullPath));
			continue;
		}
		if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
		if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) continue;
		files.push(fullPath);
	}
	return files;
}

describe("kanban-core import boundary", () => {
	it("stays framework-neutral: no react, @/platform, @/vendor, or src/modules imports", () => {
		const files = collectSourceFiles(KANBAN_CORE_DIR);
		expect(files.length).toBeGreaterThan(0);

		const violations: string[] = [];
		for (const file of files) {
			const source = readFileSync(file, "utf8");
			for (const match of source.matchAll(IMPORT_SOURCE_PATTERN)) {
				const specifier = match[1];
				for (const forbidden of FORBIDDEN_SOURCES) {
					if (forbidden.test(specifier)) {
						violations.push(`${file}: forbidden import "${specifier}" (${forbidden.label})`);
					}
				}
			}
		}

		expect(violations).toEqual([]);
	});
});
