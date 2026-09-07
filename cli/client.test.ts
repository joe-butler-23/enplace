import { afterEach, describe, expect, it, vi } from "vitest";
import { withCookbook } from "./client";
import { readAssociation } from "./association";
import { openCookingSession } from "../src/agent/session";

vi.mock("./association", () => ({ readAssociation: vi.fn() }));
vi.mock("../src/agent/session", () => ({ openCookingSession: vi.fn() }));
const association = { id: "fixture", relayUrl: "ws://localhost" };
function fixture(execute = vi.fn(async (_operation: string, args: Record<string, unknown>, _request?: { signal?: AbortSignal }): Promise<unknown> => args)) {
  const close = vi.fn(async () => {});
  vi.mocked(readAssociation).mockResolvedValue(association);
  vi.mocked(openCookingSession).mockResolvedValue({ execute, close } as unknown as Awaited<ReturnType<typeof openCookingSession>>);
  return { execute, close };
}
afterEach(() => { vi.resetAllMocks(); });

describe("configured cookbook client", () => {
  it("opens once through secure configuration and returns the callback result after dependent calls", async () => {
    const { execute, close } = fixture();
    const signal = new AbortController().signal;
    const result = await withCookbook(async call => {
      const plan = await call("plan.read", { revision: "current" }) as { revision: string };
      expect(close).not.toHaveBeenCalled();
      const saved = await call("plan.note", { expectedRevision: plan.revision, note: "Dinner" });
      return { saved };
    }, { config: "/private/cookbook.json", signal });
    expect(result).toEqual({ saved: { expectedRevision: "current", note: "Dinner" } });
    expect(readAssociation).toHaveBeenCalledExactlyOnceWith("/private/cookbook.json");
    expect(openCookingSession).toHaveBeenCalledExactlyOnceWith({ ...association, signal });
    expect(execute.mock.calls.map(call => call[0])).toEqual(["plan.read", "plan.note"]);
    expect(execute.mock.calls.every(call => call[2]?.signal === signal)).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("waits for unawaited submitted calls before closing and returning", async () => {
    const pending = Promise.withResolvers<unknown>();
    const started = Promise.withResolvers<void>();
    const { close } = fixture(vi.fn(() => { started.resolve(); return pending.promise; }));
    const running = withCookbook(call => { void call("shopping.add", {}); return "done"; });
    await started.promise;
    expect(close).not.toHaveBeenCalled();
    pending.resolve("saved");
    await expect(running).resolves.toBe("done");
    expect(readAssociation).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("reports an ignored operation failure and never executes the next queued request", async () => {
    const failure = new Error("stale revision");
    const { execute, close } = fixture(vi.fn(async () => { throw failure; }));
    await expect(withCookbook(call => {
      void call("plan.note", {});
      void call("shopping.add", {});
      return "not saved";
    })).rejects.toBe(failure);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps a caught operation failure visible and rejects later calls without executing them", async () => {
    const failure = new Error("save failed");
    const { execute, close } = fixture(vi.fn(async () => { throw failure; }));
    await expect(withCookbook(async call => {
      await call("plan.note", {}).catch(() => {});
      await expect(call("shopping.add", {})).rejects.toBe(failure);
      return "not saved";
    })).rejects.toBe(failure);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes after callback failure and stops work queued by a failed callback", async () => {
    const { execute, close } = fixture();
    const failure = new Error("caller failed");
    await expect(withCookbook(call => {
      void call("shopping.add", {});
      throw failure;
    })).rejects.toBe(failure);
    expect(execute).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects use of a retained call after the callback has finished", async () => {
    const { execute, close } = fixture();
    let retained!: Parameters<Parameters<typeof withCookbook>[0]>[0];
    await withCookbook(call => { retained = call; });
    await expect(retained("plan.read", {})).rejects.toThrow("closed");
    expect(execute).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects new calls after the callback resolves while earlier submitted work drains", async () => {
    const pending = Promise.withResolvers<unknown>();
    const started = Promise.withResolvers<void>();
    const { execute, close } = fixture(vi.fn(() => { started.resolve(); return pending.promise; }));
    let retained!: Parameters<Parameters<typeof withCookbook>[0]>[0];
    const running = withCookbook(call => {
      retained = call;
      void call("shopping.add", {});
      return "done";
    });
    await started.promise;
    await expect(retained("plan.note", {})).rejects.toThrow("closed");
    pending.resolve("saved");
    await expect(running).resolves.toBe("done");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  }, 1000);

  it("stops queued work after asynchronous callback failure while allowing the in-flight call to settle", async () => {
    const pending = Promise.withResolvers<unknown>();
    const started = Promise.withResolvers<void>();
    const failed = Promise.withResolvers<void>();
    const { execute, close } = fixture(vi.fn(() => { started.resolve(); return pending.promise; }));
    const failure = new Error("caller failed");
    const running = withCookbook(async call => {
      void call("shopping.add", {});
      await started.promise;
      void call("plan.note", {});
      failed.resolve();
      throw failure;
    });
    const rejected = expect(running).rejects.toBe(failure);
    await failed.promise;
    expect(close).not.toHaveBeenCalled();
    pending.resolve("saved");
    await rejected;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("propagates secure configuration and connection failures without entering the callback", async () => {
    fixture();
    const callback = vi.fn();
    vi.mocked(readAssociation).mockRejectedValueOnce(new Error("private association unreadable"));
    await expect(withCookbook(callback)).rejects.toThrow("private association unreadable");
    expect(openCookingSession).not.toHaveBeenCalled();
    vi.mocked(openCookingSession).mockRejectedValueOnce(new Error("relay unavailable"));
    await expect(withCookbook(callback)).rejects.toThrow("relay unavailable");
    expect(callback).not.toHaveBeenCalled();
  });
});
