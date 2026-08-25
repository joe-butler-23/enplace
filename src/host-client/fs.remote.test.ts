import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("remote host web shims", () => {
  beforeEach(() => {
    vi.resetModules();
    (globalThis as { __MEP_REMOTE_HOST__?: unknown }).__MEP_REMOTE_HOST__ = {
      mode: "remote-host",
      apiBase: "/api",
      token: "test-host-token",
      canSelectVault: false
    };
    (globalThis as { fetch?: unknown }).fetch = vi.fn();
  });

  afterEach(() => {
    delete (globalThis as { __MEP_REMOTE_HOST__?: unknown }).__MEP_REMOTE_HOST__;
    delete (globalThis as { fetch?: unknown }).fetch;
  });

  it("routes filesystem reads through the remote host api", async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ content: "hello remote" })
    });

    const fs = await import("./fs");
    const content = await fs.readTextFile("/home/vault/recipes/test.md");

    expect(content).toBe("hello remote");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/fs/read-text",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-host-token"
        }
      })
    );
  });

  it("routes ordered text batches through one remote host request", async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        files: [
          { path: "/home/vault/recipes/a.md", content: "# A\n" },
          { path: "/home/vault/recipes/b.md", content: "# B\n" }
        ]
      })
    });

    const fs = await import("./fs");
    const contents = await fs.readTextFiles([
      "/home/vault/recipes/a.md",
      "/home/vault/recipes/b.md"
    ]);

    expect(contents).toEqual(["# A\n", "# B\n"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/fs/read-text-batch",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          paths: [
            "/home/vault/recipes/a.md",
            "/home/vault/recipes/b.md"
          ]
        })
      })
    );
  });

  it("preserves recursive directory children from the remote host inventory", async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        entries: [{
          path: "/home/vault/recipes",
          name: "recipes",
          isFile: false,
          isDirectory: true,
          isSymlink: false,
          children: [{
            path: "/home/vault/recipes/a.md",
            name: "a.md",
            isFile: true,
            isDirectory: false,
            isSymlink: false,
            size: 12,
            mtime: "2026-08-08T12:00:00.000Z"
          }]
        }]
      })
    });

    const fs = await import("./fs");
    const entries = await fs.readDir("/home/vault", { recursive: true });

    expect(entries).toEqual([{
      name: "recipes",
      isFile: false,
      isDirectory: true,
      isSymlink: false,
      children: [{
        name: "a.md",
        isFile: true,
        isDirectory: false,
        isSymlink: false,
        size: 12,
        mtime: new Date("2026-08-08T12:00:00.000Z")
      }]
    }]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/fs/read-dir",
      expect.objectContaining({
        body: JSON.stringify({
          path: "/home/vault",
          options: { recursive: true }
        })
      })
    );
  });

  it("does not expose a binary-fetch helper for remote thumbnails", async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const remoteHost = await import("./remote-host");
    expect("remoteHostBinary" in remoteHost).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
