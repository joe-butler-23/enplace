import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteVaultWatchStream } from "./remote-host";

const encoder = new TextEncoder();

function sse(event: string, data: unknown, id: number): Uint8Array {
  return encoder.encode(
    `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  );
}

describe("RemoteVaultWatchStream", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as { __MEP_REMOTE_HOST__?: unknown }).__MEP_REMOTE_HOST__;
  });

  it("resumes from the supplied generation and reports stream closure explicitly", async () => {
    (globalThis as { __MEP_REMOTE_HOST__?: unknown }).__MEP_REMOTE_HOST__ = {
      mode: "remote-host",
      apiBase: "/api",
      token: "secret"
    };
    let streamController: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(sse("status", {
          generation: 4,
          alive: true,
          changed: false
        }, 4));
      }
    });
    const fetchMock = vi.fn(async () => new Response(body, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const batches: unknown[] = [];
    const stream = new RemoteVaultWatchStream();

    await expect(stream.start(4, (batch) => batches.push(batch))).resolves.toEqual({
      generation: 4,
      alive: true,
      changed: false
    });
    expect(stream.isConnected()).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/watch?generation=4",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer secret",
          "Last-Event-ID": "4"
        })
      })
    );

    streamController!.enqueue(sse("batch", {
      generation: 5,
      alive: true,
      events: [{ kind: "create" }]
    }, 5));
    await vi.waitFor(() => expect(batches).toHaveLength(1));
    streamController!.close();
    await vi.waitFor(() => expect(batches).toHaveLength(2));
    expect(batches[1]).toEqual({ generation: 5, alive: false, events: [] });
    expect(stream.isConnected()).toBe(false);
  });

  it("cancels the prior connection without treating an intentional reconnect as failure", async () => {
    (globalThis as { __MEP_REMOTE_HOST__?: unknown }).__MEP_REMOTE_HOST__ = {
      mode: "remote-host",
      apiBase: "/api",
      token: "secret"
    };
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const generation = Number((init.headers as Record<string, string>)["Last-Event-ID"]);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(sse("status", {
            generation,
            alive: true,
            changed: false
          }, generation));
          init.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        }
      });
      return new Response(body, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const batches: unknown[] = [];
    const stream = new RemoteVaultWatchStream();

    await stream.start(2, (batch) => batches.push(batch));
    await stream.start(3, (batch) => batches.push(batch));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(batches).toEqual([]);
    stream.stop();
    expect(stream.isConnected()).toBe(false);
  });

  it("rejects a connection that closes before reporting owned status", async () => {
    (globalThis as { __MEP_REMOTE_HOST__?: unknown }).__MEP_REMOTE_HOST__ = {
      mode: "remote-host",
      apiBase: "/api",
      token: "secret"
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        }
      }),
      { status: 200 }
    )));
    const stream = new RemoteVaultWatchStream();

    await expect(stream.start(0, vi.fn())).rejects.toThrow(
      "closed before reporting status"
    );
    expect(stream.isConnected()).toBe(false);
  });
});
