import { type Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { openCookingSession } from "../src/agent/session";
import type { CookbookAssociation } from "./association";

function request(line: string): { operation: string; args: Record<string, unknown> } {
  let value: unknown;
  try { value = JSON.parse(line); }
  catch { throw new Error("Session request must be valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2
    || !("operation" in value) || typeof value.operation !== "string" || !value.operation
    || !("args" in value) || !value.args || typeof value.args !== "object" || Array.isArray(value.args)) {
    throw new Error("Each session request must contain operation (string) and args (object).");
  }
  return { operation: value.operation, args: value.args as Record<string, unknown> };
}

async function* requests(source: AsyncIterable<Buffer | string>) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let line = "", bytes = 0;
  for await (const raw of source) {
    const chunk = typeof raw === "string" ? Buffer.from(raw) : raw;
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(10, start);
      const fragment = chunk.subarray(start, end < 0 ? chunk.length : end);
      bytes += fragment.length;
      if (bytes > 2 * 1024 * 1024) throw new Error("Session request exceeds 2 MiB.");
      line += decoder.decode(fragment, { stream: true });
      if (end < 0) break;
      yield request(line + decoder.decode());
      line = ""; bytes = 0; start = end + 1;
    }
  }
  if (bytes) yield request(line + decoder.decode());
}

/** One peer until EOF; pipeline propagates stream failures and bounds queued work. */
export async function executeSession(association: CookbookAssociation, input: Readable, output: Writable, signal?: AbortSignal): Promise<void> {
  let session: Awaited<ReturnType<typeof openCookingSession>> | undefined;
  try {
    await pipeline(input, async function* (source, { signal } = {}) {
      for await (const { operation, args } of requests(source)) {
        signal?.throwIfAborted();
        session ??= await openCookingSession({ ...association, signal });
        const result = await session.execute(operation, args, { signal });
        yield JSON.stringify(result) + "\n";
      }
    }, output, { signal });
  } finally { await session?.close(); }
}
