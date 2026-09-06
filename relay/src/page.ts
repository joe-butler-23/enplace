/**
 * Page fetching for URL import. The static app cannot read other sites itself, so the relay
 * fetches one public HTML page on its behalf and returns the bytes unchanged; extraction stays in
 * the browser. Only GET, only http(s) targets, only public host names, only HTML, bounded in size
 * and time, only for the app's own origin, and rate limited per client address.
 */
export const MAX_PAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const PAGE_TIMEOUT_MS = 15_000;

/** What the relay fetches on the app's behalf: a recipe page, or the picture a recipe page names. */
export type FetchKind = "page" | "image";
const kinds = {
  page: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1", type: /^(?:text\/html|application\/xhtml\+xml)\b/i, bytes: MAX_PAGE_BYTES,
    wrongType: "That address is not a web page.", tooLarge: "That page is too large to read.", failed: "The page answered with status", slow: "The page took too long to answer.", unreachable: "The page could not be reached." },
  image: { accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1", type: /^image\/(?:jpeg|png|webp|gif|avif)\b/i, bytes: MAX_IMAGE_BYTES,
    wrongType: "That address is not a picture.", tooLarge: "That picture is too large to fetch.", failed: "The picture answered with status", slow: "The picture took too long to answer.", unreachable: "The picture could not be reached." },
} as const;

export type PageTarget = { ok: true; url: URL } | { ok: false; status: number; message: string };

export function pageTarget(raw: string | null): PageTarget {
  if (!raw?.trim()) return { ok: false, status: 400, message: "Give the address of a recipe page." };
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return { ok: false, status: 400, message: "That is not a valid web address." }; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, status: 400, message: "Only http and https pages can be fetched." };
  if (url.username || url.password) return { ok: false, status: 400, message: "Addresses with sign-in details are not fetched." };
  const host = url.hostname.toLowerCase();
  const numeric = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith("[") || host.includes(":");
  if (numeric || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")) {
    return { ok: false, status: 400, message: "Only public web sites can be fetched." };
  }
  url.hash = "";
  return { ok: true, url };
}

/** The app's own origin, its preview deployments, and local development are allowed; nothing else. */
export function allowedOrigin(origin: string | null, configured: string | undefined): string | null {
  if (!origin) return null;
  let requester: URL;
  try { requester = new URL(origin); } catch { return null; }
  const host = requester.hostname;
  if (host === "localhost" || host === "127.0.0.1") return origin;
  if (!configured) return null;
  let site: URL;
  try { site = new URL(configured); } catch { return null; }
  return host === site.hostname || host.endsWith(`.${site.hostname}`) ? origin : null;
}

export type FetchedPage = { status: number; body?: Uint8Array; contentType?: string; finalUrl?: string; message?: string };

export async function fetchPage(target: URL, fetcher: typeof fetch = fetch, kind: FetchKind = "page"): Promise<FetchedPage> {
  const rules = kinds[kind];
  let response: Response;
  try {
    response = await fetcher(target.href, {
      redirect: "follow",
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      headers: { accept: rules.accept, "accept-language": "en-GB,en;q=0.8", "user-agent": "Mozilla/5.0 (compatible; Enplace/1.0; +https://github.com/joe-butler-23/enplace)" },
    });
  } catch (error) {
    return { status: 504, message: error instanceof Error && error.name === "TimeoutError" ? rules.slow : rules.unreachable };
  }
  if (!response.ok) return { status: 502, message: `${rules.failed} ${response.status}.` };
  const contentType = response.headers.get("content-type") ?? "";
  if (!rules.type.test(contentType)) return { status: 415, message: rules.wrongType };
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > rules.bytes) { await reader.cancel(); return { status: 413, message: rules.tooLarge }; }
      chunks.push(value);
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return { status: 200, body, contentType, finalUrl: response.url || target.href };
}

export function pageResponse(page: FetchedPage, origin: string): Response {
  const cors = { "access-control-allow-origin": origin, vary: "Origin", "cache-control": "no-store" };
  if (page.status !== 200 || !page.body) return new Response(page.message ?? "Could not fetch the page.", { status: page.status, headers: cors });
  return new Response(page.body, { status: 200, headers: { ...cors, "content-type": page.contentType ?? "text/html", "x-final-url": page.finalUrl ?? "", "access-control-expose-headers": "x-final-url" } });
}
