import { describe, expect, it, vi } from "vitest";
import { createImageResourceKey, ImageResourceStore } from "./image-resources";

const key = (version: string, sourcePath = "recipes/soup.md") => ({
  sourcePath,
  resolvedPath: "/vault/images/soup.png",
  version,
  variant: "full" as const
});

describe("ImageResourceStore", () => {
  it("reuses the canonical recipe key between prewarm and read", async () => {
    const store = new ImageResourceStore();
    const prewarmKey = createImageResourceKey("recipes/soup.md", "/vault/images/soup.png", "10:20|30:40");
    const readKey = createImageResourceKey("recipes/soup.md", "/vault/images/soup.png", "10:20|30:40");
    const loader = vi.fn(async () => ({ url: "blob:soup", width: 1200, height: 800 }));

    await store.load(prewarmKey, loader);
    await store.load(readKey, loader);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(store.get(readKey)?.url).toBe("blob:soup");
  });

  it("keeps direct sources in the recipe-scoped readiness key", () => {
    expect(createImageResourceKey("recipes/soup.md", "https://example.test/soup.png", "10:20|direct:https://example.test/soup.png")).toEqual({
      sourcePath: "recipes/soup.md",
      resolvedPath: "https://example.test/soup.png",
      version: "10:20|direct:https://example.test/soup.png",
      variant: "full",
    });
  });

  it("keeps card and detail thumbnail variants separate", () => {
    const card = createImageResourceKey("recipes/soup.md", "/vault/images/soup.png", "1", "card");
    const detail = createImageResourceKey("recipes/soup.md", "/vault/images/soup.png", "1", "detail");
    expect(card).not.toEqual(detail);
  });

  it("shares in-flight card work between planner and database consumers", async () => {
    const store = new ImageResourceStore();
    const planner = createImageResourceKey("/vault/images/soup.png", "/vault/images/soup.png", "30:40", "card");
    const database = createImageResourceKey("/vault/images/soup.png", "/vault/images/soup.png", "30:40", "card");
    const loader = vi.fn(async () => ({ url: "blob:soup", width: 320, height: 160 }));
    await Promise.all([store.load(planner, loader), store.load(database, loader)]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(store.get(database)?.url).toBe("blob:soup");
  });

  it("deduplicates in-flight loads and publishes dimensions", async () => {
    const store = new ImageResourceStore();
    const loader = vi.fn(async () => ({ url: "blob:soup", width: 1200, height: 800 }));
    const [first, second] = await Promise.all([store.load(key("1"), loader), store.load(key("1"), loader)]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ url: "blob:soup", width: 1200, height: 800 });
    expect(second).toEqual(first);
    expect(store.get(key("1"))?.width).toBe(1200);
  });

  it("keeps file versions distinct and invalidates source paths", async () => {
    const store = new ImageResourceStore();
    await store.load(key("1"), async () => ({ url: "blob:old", width: 1, height: 1 }));
    await store.load(key("2"), async () => ({ url: "blob:new", width: 2, height: 1 }));
    expect(store.get(key("1"))?.url).toBe("blob:old");
    expect(store.get(key("2"))?.url).toBe("blob:new");
    store.invalidatePath("recipes/soup.md");
    expect(store.get(key("1"))).toBeUndefined();
    expect(store.get(key("2"))).toBeUndefined();
  });

  it("schedules visible requests before bounded lookahead requests", async () => {
    const store = new ImageResourceStore(20, undefined, 1);
    const order: string[] = [];
    const requests = [
      { key: key("lookahead"), priority: 2, loader: async () => {
        order.push("lookahead");
        return { url: "blob:lookahead", width: 1, height: 1 };
      } },
      { key: key("visible"), priority: 0, loader: async () => {
        order.push("visible");
        return { url: "blob:visible", width: 1, height: 1 };
      } },
      { key: key("overscan"), priority: 1, loader: async () => {
        order.push("overscan");
        return { url: "blob:overscan", width: 1, height: 1 };
      } }
    ];
    store.schedule(requests);
    await vi.waitFor(() => expect(order).toEqual(["visible", "overscan", "lookahead"]));
    expect(store.getState(key("visible"))).toEqual({
      status: "ready",
      resource: { url: "blob:visible", width: 1, height: 1 }
    });
  });

  it("publishes explicit stable errors and does not revoke retained resources", async () => {
    const dispose = vi.fn();
    const store = new ImageResourceStore(1, dispose, 1, 1000);
    const failed = key("failed");
    await expect(store.load(failed, async () => null)).resolves.toBeNull();
    expect(store.getState(failed)).toEqual({ status: "error", message: "Cover unavailable" });

    const first = key("first");
    const second = key("second");
    await store.load(first, async () => ({ url: "blob:first", width: 1, height: 1 }));
    store.retain(first, 1000);
    await store.load(second, async () => ({ url: "blob:second", width: 1, height: 1 }));
    expect(dispose).not.toHaveBeenCalledWith({ url: "blob:first", width: 1, height: 1 });
  });

  it("exposes a settled key's state immediately, without waiting for other in-flight keys (per-card reveal)", async () => {
    const store = new ImageResourceStore(20, undefined, 1);
    let resolveSlow: (() => void) | undefined;
    const fast = key("fast");
    const slow = key("slow");
    store.schedule([
      { key: fast, priority: 0, loader: async () => ({ url: "blob:fast", width: 1, height: 1 }) },
      { key: slow, priority: 1, loader: () => new Promise((resolve) => {
        resolveSlow = () => resolve({ url: "blob:slow", width: 1, height: 1 });
      }) }
    ]);
    await vi.waitFor(() => expect(store.getState(fast)?.status).toBe("ready"));
    // The slower sibling has not resolved yet -- a per-card reader must see that distinctly from
    // "ready", and must not be blocked from reading the fast card's ready state in the meantime.
    expect(store.getState(slow)).toBeUndefined();
    resolveSlow?.();
    await vi.waitFor(() => expect(store.getState(slow)?.status).toBe("ready"));
  });

  it("coalesces listener notifications for completions that land in the same tick", async () => {
    const store = new ImageResourceStore();
    const notifications: number[] = [];
    store.subscribe(() => notifications.push(store.getSnapshot()));
    const loader = (url: string) => async () => ({ url, width: 1, height: 1 });
    await Promise.all([
      store.load(key("one"), loader("blob:one")),
      store.load(key("two"), loader("blob:two")),
      store.load(key("three"), loader("blob:three"))
    ]);
    // Version bumps once per completion (visible to getSnapshot immediately)...
    expect(store.getSnapshot()).toBe(3);
    // ...but three same-tick completions collapse into a single coalesced listener flush.
    await vi.waitFor(() => expect(notifications.length).toBeGreaterThan(0));
    expect(notifications.length).toBe(1);
    expect(notifications[0]).toBe(3);
  });
  it("retains every key from a two-stage union schedule (viewport then full view)", async () => {
    const store = new ImageResourceStore(20, undefined, 1);
    const viewportKey = key("viewport");
    const overscanKey = key("overscan");
    const remainderKey = key("remainder");

    // Stage 1: schedule viewport keys
    const viewportRequests = [
      { key: viewportKey, priority: 0, loader: async () => ({ url: "blob:vp", width: 1, height: 1 }) },
      { key: overscanKey, priority: 0, loader: async () => ({ url: "blob:os", width: 1, height: 1 }) },
    ];
    store.schedule(viewportRequests);
    await vi.waitFor(() => expect(store.getState(viewportKey)?.status).toBe("ready"));
    expect(store.getState(overscanKey)?.status).toBe("ready");

    // Stage 2: schedule the union (viewport + remainder).
    // The store must NOT drop viewport keys from scheduledKeys or reduce their retainUntil
    // below INFINITY; already-loaded keys are deduped by the store.
    const remainderRequests = [
      { key: remainderKey, priority: 0, loader: async () => ({ url: "blob:rm", width: 1, height: 1 }) },
    ];
    const unionRequests = [...viewportRequests, ...remainderRequests];
    store.schedule(unionRequests);
    await vi.waitFor(() => expect(store.getState(remainderKey)?.status).toBe("ready"));

    // All three keys must still be retained (loaded resources present).
    expect(store.get(viewportKey)?.url).toBe("blob:vp");
    expect(store.get(overscanKey)?.url).toBe("blob:os");
    expect(store.get(remainderKey)?.url).toBe("blob:rm");
  });

  it("preserves in-flight first-stage loads when the union schedule fires before they finish", async () => {
    const store = new ImageResourceStore(20, undefined, 2); // concurrency 2 so both start
    let resolveSlow: (() => void) | undefined;
    const viewportKey = key("vp-slow");
    const overscanKey = key("os-fast");
    const remainderKey = key("rm");

    const viewportRequests = [
      { key: viewportKey, priority: 0, loader: () => new Promise<{ url: string; width: number; height: number }>((resolve) => {
        resolveSlow = () => resolve({ url: "blob:vp-slow", width: 1, height: 1 });
      }) },
      { key: overscanKey, priority: 0, loader: async () => ({ url: "blob:os-fast", width: 1, height: 1 }) },
    ];
    store.schedule(viewportRequests);
    // Wait for the fast one to settle; the slow one is still in-flight.
    await vi.waitFor(() => expect(store.getState(overscanKey)?.status).toBe("ready"));

    // Stage 2 union fires while vp-slow is still in-flight.
    const remainderRequests = [
      { key: remainderKey, priority: 0, loader: async () => ({ url: "blob:rm", width: 1, height: 1 }) },
    ];
    store.schedule([...viewportRequests, ...remainderRequests]);

    // The in-flight load must not be dropped or duplicated.
    resolveSlow?.();
    await vi.waitFor(() => expect(store.getState(viewportKey)?.status).toBe("ready"));
    await vi.waitFor(() => expect(store.getState(remainderKey)?.status).toBe("ready"));

    expect(store.get(viewportKey)?.url).toBe("blob:vp-slow");
    expect(store.get(overscanKey)?.url).toBe("blob:os-fast");
    expect(store.get(remainderKey)?.url).toBe("blob:rm");
  });

  it("does not retry error records through schedule (sticky error contract)", async () => {
    // The store's schedule() skips keys that already have an error state.
    // Retry must go through load() directly; this is the intended sticky-error
    // contract so a transient backend failure does not cause repeated prepare
    // calls on every effect re-run.
    const store = new ImageResourceStore();
    const errorKey = key("sticky");
    await store.load(errorKey, async () => null);
    expect(store.getState(errorKey)?.status).toBe("error");

    let loaded = false;
    store.schedule([{
      key: errorKey,
      priority: 0,
      loader: async () => { loaded = true; return { url: "blob:retry", width: 1, height: 1 }; },
    }]);
    // schedule() skips error-state records; load() is needed for a retry.
    expect(loaded).toBe(false);
    expect(store.getState(errorKey)?.status).toBe("error");
  });

});
