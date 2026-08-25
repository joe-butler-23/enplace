import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(fileURLToPath(new URL("./structural.css", import.meta.url)), "utf8");

function declarations(selector: string): string {
	const match = stylesheet.match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`));
	if (!match) throw new Error(`Missing ${selector} rule`);
	return match[1];
}

describe("reusable kanban structural containment", () => {
	it("bounds every drag hit area to its owning lane", () => {
		const lane = declarations(".kanban-board");
		const dragSurface = declarations(".kanban-drag");

		// The lane clips descendants at its own geometry; the drag surface remains
		// scrollable and shrinkable within that boundary on every client host.
		expect(lane).toMatch(/overflow:\s*hidden\s*;/);
		expect(lane).toMatch(/min-width:\s*0\s*;/);
		expect(lane).toMatch(/min-height:\s*0\s*;/);
		expect(dragSurface).toMatch(/overflow:\s*auto\s*;/);
		expect(dragSurface).toMatch(/min-width:\s*0\s*;/);
		expect(dragSurface).toMatch(/min-height:\s*0\s*;/);
	});
});
