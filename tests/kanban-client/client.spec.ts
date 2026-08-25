import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

async function dragCard(page: Page, cardId: string, targetLaneId: string) {
	const placement = await page.evaluate(({ cardId, targetLaneId }) => {
		const source = document.querySelector<HTMLElement>(`[data-eid="${cardId}"]`)!;
		const target = document.querySelector<HTMLElement>(`[data-id="${targetLaneId}"] .kanban-drag`)!;
		const sourceBox = source.getBoundingClientRect();
		const targetBox = target.getBoundingClientRect();
		return {
			start: {
				x: sourceBox.left + 12,
				y: sourceBox.top + 12,
			},
			end: {
				x: targetBox.left + Math.min(36, Math.max(10, targetBox.width / 5)),
				y: targetBox.top + Math.min(110, Math.max(24, targetBox.height / 3)),
			},
		};
	}, { cardId, targetLaneId });
	await page.mouse.move(placement.start.x, placement.start.y);
	await page.mouse.down();
	await page.mouse.move(placement.end.x, placement.end.y, { steps: 16 });
	await expect(page.locator(".gu-mirror")).toHaveCount(1);
	await page.mouse.up();
}

async function startDragging(page: Page, cardId: string) {
	const start = await page.locator(`[data-eid="${cardId}"]`).evaluate((source) => {
		const box = source.getBoundingClientRect();
		return { x: box.left + 12, y: box.top + 12 };
	});
	await page.mouse.move(start.x, start.y);
	await page.mouse.down();
	await page.mouse.move(start.x + 80, start.y + 60, { steps: 12 });
}

test.beforeEach(async ({ page }) => {
	await page.goto("/tests/kanban-client/index.html");
	await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
});

test("renders, updates, delegates, drags, and destroys through one client", async ({ page }) => {
	const first = page.locator('[data-eid="one"]');
	await expect(first).toHaveClass(/card-one/);
	await expect(page.locator(".kanban-board")).toHaveCount(2);

	await first.locator('[data-kanban-action="remove"]').click();
	await first.locator("span").click();
	expect(await page.evaluate(() => window.kanbanFixture.events.slice(-2))).toEqual([
		{ type: "action", name: "remove", cardId: "one" },
		{ type: "click", cardId: "one", defaultPrevented: false },
	]);

	expect(await page.evaluate(() => window.kanbanFixture.update())).toEqual(["backlog"]);
	await expect(page.locator('[data-id="backlog"] .kanban-item').first()).toHaveAttribute("data-eid", "two");
	await expect(page.locator('[data-eid="two"]')).toHaveClass(/updated/);
	expect(await page.evaluate(() => window.firstCard === document.querySelector('[data-eid="one"]'))).toBe(true);

	await dragCard(page, "one", "done");

	await expect(page.locator('[data-id="done"] [data-eid="one"]')).toHaveCount(1);
	await expect(page.locator('#board [data-eid="one"]')).not.toHaveClass(/is-moving/);
	expect(await page.evaluate(() => window.kanbanFixture.events.find((event) => event.type === "drop"))).toMatchObject({
		type: "drop",
		cardId: "one",
		sourceLaneId: "backlog",
		targetLaneId: "done",
		index: 0,
		sourceOrder: ["two"],
		targetOrder: ["one"],
	});

	await page.evaluate(() => window.kanbanFixture.client.destroy());
	await expect(page.locator("#board")).toBeEmpty();
});

test("prevents non-draggable cards from entering the drag lifecycle", async ({ page }) => {
	await startDragging(page, "group");
	await expect(page.locator(".gu-mirror")).toHaveCount(0);
	await page.mouse.up();

	await expect(page.locator('[data-id="backlog"] [data-eid="group"]')).toHaveCount(1);
	expect(await page.evaluate(() =>
		window.kanbanFixture.events.filter(({ type }) =>
			type === "drag" || type === "dragend" || type === "drop"
		)
	)).toEqual([]);
});

test("cleans up movement state after a spilled drag is cancelled", async ({ page }) => {
	await startDragging(page, "one");
	await expect(page.locator(".gu-mirror")).toHaveCount(1);
	await expect(page.locator('#board [data-eid="one"]')).toHaveClass(/is-moving/);

	await page.mouse.move(1100, 700, { steps: 12 });
	await page.mouse.up();

	await expect(page.locator(".gu-mirror")).toHaveCount(0);
	await expect(page.locator('#board [data-eid="one"]')).not.toHaveClass(/is-moving/);
	await expect(page.locator('[data-id="backlog"] [data-eid="one"]')).toHaveCount(1);
	expect(await page.evaluate(() =>
		window.kanbanFixture.events.filter(({ type }) =>
			type === "drag" || type === "dragend" || type === "drop"
		)
	)).toEqual([
		{ type: "drag", cardId: "one" },
		{ type: "dragend", cardId: "one" },
	]);
});

test("leaves container sizing to CSS while preserving non-pixel board widths", async ({ page }) => {
	const dimensions = await page.evaluate(() => {
		const host = document.querySelector<HTMLElement>("#board")!;
		const container = host.querySelector<HTMLElement>(".kanban-container")!;
		const board = container.querySelector<HTMLElement>(".kanban-board")!;
		return {
			host: host.getBoundingClientRect().width,
			container: container.getBoundingClientRect().width,
			board: board.getBoundingClientRect().width,
			containerInlineWidth: container.style.width,
			boardInlineWidth: board.style.width,
		};
	});

	expect(dimensions.containerInlineWidth).toBe("");
	expect(dimensions.boardInlineWidth).toBe("40%");
	expect(dimensions.container).toBeCloseTo(dimensions.host);
	expect(dimensions.board).toBeGreaterThan(dimensions.host * 0.39);
	expect(dimensions.board).toBeLessThan(dimensions.host * 0.41);
});

test("contains each drag hit area within its owning lane", async ({ page }) => {
	const containment = await page.locator(".kanban-board").evaluateAll((boards) =>
		boards.map((board) => {
			const dragSurface = board.querySelector<HTMLElement>(".kanban-drag")!;
			const laneStyle = getComputedStyle(board);
			const dragStyle = getComputedStyle(dragSurface);
			return {
				laneOverflow: laneStyle.overflow,
				laneMinWidth: laneStyle.minWidth,
				laneMinHeight: laneStyle.minHeight,
				dragOverflow: dragStyle.overflow,
				dragMinWidth: dragStyle.minWidth,
				dragMinHeight: dragStyle.minHeight,
			};
		})
	);

	expect(containment).toEqual(expect.arrayContaining([
		expect.objectContaining({
			laneOverflow: "hidden",
			laneMinWidth: "0px",
			laneMinHeight: "0px",
			dragOverflow: "auto",
			dragMinWidth: "0px",
			dragMinHeight: "0px",
		}),
	]));
});

test("rekeys the exact caller-owned copy and reconciles it", async ({ page }) => {
	await page.evaluate(() => {
		window.kanbanFixture.copy = true;
	});
	await dragCard(page, "one", "done");

	await expect(page.locator('[data-id="backlog"] [data-eid="one"]')).toHaveCount(1);
	await expect(page.locator('[data-id="done"] [data-eid="one"]')).toHaveCount(1);
	expect(await page.evaluate(() => window.kanbanFixture.events.find((event) => event.type === "drop"))).toMatchObject({
		type: "drop",
		cardId: "one",
		sourceLaneId: "backlog",
		targetLaneId: "done",
	});
	expect(await page.evaluate(() => window.kanbanFixture.settleCopy())).toEqual(["backlog", "done"]);
	await expect(page.locator('[data-id="backlog"] [data-eid="one"]')).toHaveCount(1);
	await expect(page.locator('[data-id="done"] [data-eid="one-copy"]')).toHaveCount(1);
});

test("keeps real pointer dragging functional at a narrow viewport", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.reload();
	await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

	await dragCard(page, "one", "done");
	await expect(page.locator('[data-id="done"] [data-eid="one"]')).toHaveCount(1);
});

test("publishes provenance for the exact generated artifacts", async ({ request }) => {
	const provenance = await (await request.get("/dist-kanban-client/PROVENANCE.json")).json() as {
		source: { commit: string; dirty: boolean };
		artifact: { files: Array<{ path: string; bytes: number; sha256: string }> };
	};
	const commit = execFileSync("git", ["rev-parse", "HEAD"]).toString().trim();
	const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"]).toString().trim().length > 0;

	expect(provenance.source).toMatchObject({ commit, dirty });
	expect(provenance.artifact.files.map((file) => file.path)).toEqual([
		"kanban-client.css",
		"kanban-client.mjs",
	]);
	for (const file of provenance.artifact.files) {
		const body = readFileSync(path.resolve("dist-kanban-client", file.path));
		expect(file.bytes).toBe(body.byteLength);
		expect(file.sha256).toBe(createHash("sha256").update(body).digest("hex"));
	}
});

declare global {
	interface Window {
		firstCard?: Element;
		kanbanFixture: {
			client: { destroy: () => void };
			copy: boolean;
			events: Array<Record<string, unknown>>;
			settleCopy: () => string[];
			update: () => string[];
		};
	}
}
