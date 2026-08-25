import { afterEach, describe, expect, it, vi } from "vitest";
import { markVaultRefreshOutcome } from "./vault-refresh-completion";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("vault refresh completion marks", () => {
  it("marks a successful refresh from the current initialize generation exactly once", () => {
    const mark = vi.spyOn(performance, "mark").mockImplementation(
      () => undefined as unknown as PerformanceMark
    );

    markVaultRefreshOutcome("success", 3, 3);

    expect(mark).toHaveBeenCalledTimes(1);
    expect(mark).toHaveBeenCalledWith("mep:vault:refresh-complete", {
      detail: { status: "success", generation: 3 }
    });
  });

  it("uses a distinct failure mark and never reports failure as success", () => {
    const mark = vi.spyOn(performance, "mark").mockImplementation(
      () => undefined as unknown as PerformanceMark
    );

    markVaultRefreshOutcome("failure", 4, 4);

    expect(mark).toHaveBeenCalledTimes(1);
    expect(mark).toHaveBeenCalledWith("mep:vault:refresh-failed", {
      detail: { status: "failure", generation: 4 }
    });
    expect(mark).not.toHaveBeenCalledWith(
      "mep:vault:refresh-complete",
      expect.anything()
    );
  });

  it("does not mark a stale initialize generation as successful", () => {
    const mark = vi.spyOn(performance, "mark").mockImplementation(
      () => undefined as unknown as PerformanceMark
    );

    markVaultRefreshOutcome("success", 5, 6);

    expect(mark).not.toHaveBeenCalled();
  });
});
