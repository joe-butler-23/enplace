import { describe, expect, it } from "vitest";
import { getDropFailureRecovery } from "../utils/drop-failure-recovery";

describe("drop failure reconciliation", () => {
	it("refreshes both columns so a failed optimistic commit rolls back from persistence", () => {
		const recovery = getDropFailureRecovery("2026-07-14", "2026-07-15");

		expect(recovery.refreshColumns).toEqual(new Set(["2026-07-14", "2026-07-15"]));
	});

	it("refreshes only the target when a drop has no source column", () => {
		const recovery = getDropFailureRecovery(undefined, "marked");

		expect(recovery.refreshColumns).toEqual(new Set(["marked"]));
	});
});
