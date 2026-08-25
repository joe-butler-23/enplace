import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRefreshScheduler } from "./refresh-scheduler";

function makeClickGate(overrides: { isDragging?: () => boolean; dragCooldownRemainingMs?: () => number } = {}) {
	return {
		isDragging: overrides.isDragging ?? (() => false),
		dragCooldownRemainingMs: overrides.dragCooldownRemainingMs ?? (() => 0),
	};
}

describe("createRefreshScheduler", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("window", globalThis);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("batches same-tick requests behind refreshDelayMs into a single flush", () => {
		const onFlush = vi.fn();
		const scheduler = createRefreshScheduler({ refreshDelayMs: 50, clickGate: makeClickGate(), onFlush });

		scheduler.request(["a"]);
		scheduler.request(["b"]);
		expect(onFlush).not.toHaveBeenCalled();

		vi.advanceTimersByTime(50);

		expect(onFlush).toHaveBeenCalledOnce();
		expect(onFlush).toHaveBeenCalledWith(["a", "b"]);
	});

	it("does nothing when request is called with no lane ids and nothing is pending", () => {
		const onFlush = vi.fn();
		const scheduler = createRefreshScheduler({ refreshDelayMs: 50, clickGate: makeClickGate(), onFlush });

		scheduler.request();
		vi.advanceTimersByTime(1000);

		expect(onFlush).not.toHaveBeenCalled();
	});

	it("defers the flush indefinitely while a drag stays in progress", () => {
		const onFlush = vi.fn();
		const scheduler = createRefreshScheduler({
			refreshDelayMs: 50,
			clickGate: makeClickGate({ isDragging: () => true }),
			onFlush,
		});

		scheduler.request(["a"]);
		// Each deferred retry re-checks isDragging and, since it never clears,
		// keeps re-arming rather than ever flushing.
		vi.advanceTimersByTime(5_000);

		expect(onFlush).not.toHaveBeenCalled();
	});

	it("defers the flush until the drag cooldown elapses, then flushes with the eventually-current pending set", () => {
		const onFlush = vi.fn();
		let remaining = 300;
		const scheduler = createRefreshScheduler({
			refreshDelayMs: 50,
			clickGate: makeClickGate({ dragCooldownRemainingMs: () => remaining }),
			onFlush,
		});

		scheduler.request(["a"]);
		expect(onFlush).not.toHaveBeenCalled();

		// Cooldown clears before the deferred retry fires; the retry then
		// re-checks, finds no more blocking, and schedules the real flush.
		remaining = 0;
		vi.advanceTimersByTime(301); // deferred retry fires, reschedules flush
		expect(onFlush).not.toHaveBeenCalled();
		vi.advanceTimersByTime(50); // the rescheduled flush fires
		expect(onFlush).toHaveBeenCalledOnce();
		expect(onFlush).toHaveBeenCalledWith(["a"]);
	});

	it("adds newly requested lanes to an already-pending batch", () => {
		const onFlush = vi.fn();
		const scheduler = createRefreshScheduler({ refreshDelayMs: 50, clickGate: makeClickGate(), onFlush });

		scheduler.request(["a"]);
		vi.advanceTimersByTime(10);
		scheduler.request(["b"]);
		vi.advanceTimersByTime(50);

		expect(onFlush).toHaveBeenCalledOnce();
		expect(onFlush).toHaveBeenCalledWith(["a", "b"]);
	});

	it("clears the pending set once flushed, so a later request starts a fresh batch", () => {
		const onFlush = vi.fn();
		const scheduler = createRefreshScheduler({ refreshDelayMs: 50, clickGate: makeClickGate(), onFlush });

		scheduler.request(["a"]);
		vi.advanceTimersByTime(50);
		expect(onFlush).toHaveBeenNthCalledWith(1, ["a"]);

		scheduler.request(["b"]);
		vi.advanceTimersByTime(50);
		expect(onFlush).toHaveBeenNthCalledWith(2, ["b"]);
	});

	it("cancel drops pending lanes and prevents a scheduled flush from firing", () => {
		const onFlush = vi.fn();
		const scheduler = createRefreshScheduler({ refreshDelayMs: 50, clickGate: makeClickGate(), onFlush });

		scheduler.request(["a"]);
		scheduler.cancel();
		vi.advanceTimersByTime(1000);

		expect(onFlush).not.toHaveBeenCalled();
	});

	it("cancel then a fresh request starts an independent batch", () => {
		const onFlush = vi.fn();
		const scheduler = createRefreshScheduler({ refreshDelayMs: 50, clickGate: makeClickGate(), onFlush });

		scheduler.request(["a"]);
		scheduler.cancel();
		scheduler.request(["b"]);
		vi.advanceTimersByTime(50);

		expect(onFlush).toHaveBeenCalledOnce();
		expect(onFlush).toHaveBeenCalledWith(["b"]);
	});
});
