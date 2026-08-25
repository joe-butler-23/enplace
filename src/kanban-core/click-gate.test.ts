import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClickGate } from "./click-gate";

describe("createClickGate", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("defaults clickBlockMs to 500 and dragCooldownMs to 300 per the contract", () => {
		const clickGate = createClickGate();
		clickGate.dragEnded();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.499Z"));
		expect(clickGate.shouldSuppressClick()).toBe(true);
		vi.setSystemTime(new Date("2026-01-01T00:00:00.501Z"));
		expect(clickGate.shouldSuppressClick()).toBe(false);

		const cooldownGate = createClickGate();
		cooldownGate.dragEnded();
		const dragEndedAt = Date.now();
		vi.setSystemTime(new Date(dragEndedAt + 299));
		expect(cooldownGate.dragCooldownRemainingMs()).toBeGreaterThan(0);
		vi.setSystemTime(new Date(dragEndedAt + 300));
		expect(cooldownGate.dragCooldownRemainingMs()).toBe(0);
	});

	it("reports isDragging across dragStarted/dragEnded", () => {
		const gate = createClickGate();
		expect(gate.isDragging()).toBe(false);

		gate.dragStarted();
		expect(gate.isDragging()).toBe(true);

		gate.dragEnded();
		expect(gate.isDragging()).toBe(false);
	});

	it("suppresses clicks for the whole time a drag is in progress", () => {
		const gate = createClickGate({ clickBlockMs: 500, dragCooldownMs: 300 });
		gate.dragStarted();

		vi.setSystemTime(new Date("2026-01-01T00:00:10.000Z"));

		expect(gate.shouldSuppressClick()).toBe(true);
	});

	it("suppresses clicks only inside the clickBlockMs window after drag end", () => {
		const gate = createClickGate({ clickBlockMs: 500, dragCooldownMs: 300 });
		gate.dragStarted();
		gate.dragEnded();

		vi.setSystemTime(new Date("2026-01-01T00:00:00.499Z"));
		expect(gate.shouldSuppressClick()).toBe(true);

		vi.setSystemTime(new Date("2026-01-01T00:00:00.500Z"));
		expect(gate.shouldSuppressClick()).toBe(false);
	});

	it("computes dragCooldownRemainingMs counting down to zero and never negative", () => {
		const gate = createClickGate({ clickBlockMs: 500, dragCooldownMs: 300 });
		gate.dragStarted();
		gate.dragEnded();

		expect(gate.dragCooldownRemainingMs()).toBe(300);

		vi.setSystemTime(new Date("2026-01-01T00:00:00.150Z"));
		expect(gate.dragCooldownRemainingMs()).toBe(150);

		vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
		expect(gate.dragCooldownRemainingMs()).toBe(0);
	});

	it("captures and returns the most recent click intent", () => {
		const gate = createClickGate();
		expect(gate.clickIntent()).toBeNull();

		gate.captureClickIntent({ cardId: "a.md", split: true });
		expect(gate.clickIntent()).toEqual({ cardId: "a.md", split: true, at: Date.now() });

		vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
		gate.captureClickIntent({ cardId: "b.md", split: false });
		expect(gate.clickIntent()).toEqual({ cardId: "b.md", split: false, at: Date.now() });
	});
});
