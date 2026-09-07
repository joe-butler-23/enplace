import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough, Readable, Writable } from "node:stream";
import { once } from "node:events";
import { executeSession } from "./session";
import { openCookingSession } from "../src/agent/session";

vi.mock("../src/agent/session", () => ({ openCookingSession: vi.fn() }));
const association = { id: "fixture", relayUrl: "ws://localhost" };
const request = (operation: string, args = {}) => JSON.stringify({ operation, args }) + "\n";
function fixture(execute = vi.fn(async (_operation: string, args: Record<string, unknown>, _request?: { signal?: AbortSignal }) => args)) {
  const close = vi.fn(async () => {});
  vi.mocked(openCookingSession).mockResolvedValue({ execute, close } as unknown as Awaited<ReturnType<typeof openCookingSession>>);
  const input = new PassThrough();
  const output = new PassThrough();
  return { input, output, execute, close };
}
afterEach(() => { vi.resetAllMocks(); });

describe("JSONL cooking session", () => {
  it("opens once and replies before EOF so the next request can depend on a result", async () => {
    const { input, output, execute, close } = fixture();
    const running = executeSession(association, input, output);
    const first = once(output, "data");
    input.write(request("plan.read", { revision: "first" }));
    const revision = JSON.parse(String((await first)[0])).revision;
    const second = once(output, "data");
    input.write(request("plan.note", { expectedRevision: revision, note: "Dinner" }));
    expect(JSON.parse(String((await second)[0]))).toEqual({ expectedRevision: "first", note: "Dinner" });
    expect(close).not.toHaveBeenCalled();
    input.end();
    await running;
    expect(openCookingSession).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls.map(call => call[0])).toEqual(["plan.read", "plan.note"]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("handles split UTF-8 and an unterminated final line; empty input needs no connection", async () => {
    const { output, close } = fixture();
    const chunks: Buffer[] = [];
    output.on("data", chunk => chunks.push(chunk));
    const content = request("shopping.add", { content: "Crème fraîche 🍋" }).trimEnd();
    await executeSession(association, Readable.from([...Buffer.from(content)].map(byte => Buffer.from([byte]))), output);
    expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({ content: "Crème fraîche 🍋" });
    expect(close).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    await executeSession(association, Readable.from([]), new PassThrough());
    expect(openCookingSession).not.toHaveBeenCalled();
  });

  it.each(["{bad JSON}\n", "\n", '{"operation":"plan.read","args":[]}\n', '{"operation":"plan.read","args":{},"extra":true}\n', request("shopping.add", { content: "x".repeat(2 * 1024 * 1024) })])("stops at invalid input and closes after earlier successful work (%#)", async invalid => {
    const { output, execute, close } = fixture();
    const chunks: Buffer[] = [];
    output.on("data", chunk => chunks.push(chunk));
    await expect(executeSession(association, Readable.from([request("shopping.add", { content: "Saved" }), invalid, request("shopping.add", { content: "Never" })]), output)).rejects.toThrow();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({ content: "Saved" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("stops at a domain error without claiming a response for it or executing later requests", async () => {
    const { output, close, execute } = fixture(vi.fn(async () => { throw new Error("stale revision"); }));
    const write = vi.spyOn(output, "write");
    await expect(executeSession(association, Readable.from([request("plan.note"), request("shopping.add")]), output)).rejects.toThrow("stale revision");
    expect(write).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("waits for output backpressure before executing the next request", async () => {
    const { input, execute, close } = fixture();
    let release!: () => void;
    let received!: () => void;
    const firstWrite = new Promise<void>(resolve => { received = resolve; });
    const output = new Writable({ highWaterMark: 1, write(_chunk, _encoding, callback) { release = callback; received(); } });
    const running = executeSession(association, input, output);
    input.end(request("plan.read") + request("shopping.read"));
    await firstWrite;
    expect(execute).toHaveBeenCalledTimes(1);
    output._write = (_chunk, _encoding, callback) => callback();
    release();
    await running;
    expect(execute).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each(["input", "output", "abort"])("closes on %s failure while waiting for the next request", async failure => {
    const { input, output, close, execute } = fixture();
    const controller = new AbortController();
    const running = executeSession(association, input, output, controller.signal);
    const rejected = expect(running).rejects.toThrow();
    const written = once(output, "data");
    input.write(request("recipe.list"));
    await written;
    if (failure === "abort") controller.abort(new Error("interrupted"));
    else (failure === "input" ? input : output).destroy(new Error("broken pipe"));
    await rejected;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("cancels an in-flight operation and never starts a queued request after output fails", async () => {
    const started = Promise.withResolvers<void>();
    const execute = vi.fn(async (_operation: string, _args: Record<string, unknown>, request?: { signal?: AbortSignal }) => {
      started.resolve();
      return new Promise<Record<string, unknown>>((_resolve, reject) => request!.signal!.addEventListener("abort", () => reject(request!.signal!.reason), { once: true }));
    });
    const { input, output, close } = fixture(execute);
    const running = executeSession(association, input, output);
    const rejected = expect(running).rejects.toThrow("broken output");
    input.end(request("shopping.add") + request("plan.note"));
    await started.promise;
    output.destroy(new Error("broken output"));
    await rejected;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
