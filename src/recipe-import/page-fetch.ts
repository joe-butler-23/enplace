/** The relay's page endpoint, derived from the configured relay address; null when there is no relay. */
export function pageEndpoint(relayUrl: string | null | undefined): string | null {
  if (!relayUrl?.trim()) return null;
  let url: URL;
  try { url = new URL(relayUrl.trim()); } catch { return null; }
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/page"; url.search = ""; url.hash = "";
  return url.href;
}

export function configuredPageEndpoint(): string | null {
  return pageEndpoint((import.meta as ImportMeta & { env?: { VITE_ENPLACE_RELAY_URL?: string } }).env?.VITE_ENPLACE_RELAY_URL);
}

const messages: Record<number, string> = {
  403: "The relay fetches pages only for Enplace itself.",
  413: "That page is too large to read.",
  415: "That address is not a web page.",
  429: "Too many pages fetched from this connection; wait a minute and try again.",
};

/** Decodes with the header's charset, or the page's own meta charset when the header has none. */
function decode(bytes: ArrayBuffer, contentType: string): string {
  const declared = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  const head = new TextDecoder("latin1").decode(bytes.slice(0, 4096));
  const meta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  for (const label of [declared, meta, "utf-8"]) {
    if (!label) continue;
    try { return new TextDecoder(label).decode(bytes); } catch { /* unknown label: try the next */ }
  }
  return new TextDecoder().decode(bytes);
}

/** Fetches one recipe page through the relay; the returned address is where the page finally lived. */
export async function fetchPageHtml(address: string, endpoint: string, fetcher: typeof fetch = fetch): Promise<{ html: string; url: string }> {
  let response: Response;
  try { response = await fetcher(`${endpoint}?url=${encodeURIComponent(address.trim())}`); }
  catch { throw new Error("Could not reach the relay to fetch the page."); }
  if (!response.ok) {
    const body = (await response.text().catch(() => "")).trim();
    throw new Error(messages[response.status] ?? (body || `The page could not be fetched (${response.status}).`));
  }
  const html = decode(await response.arrayBuffer(), response.headers.get("content-type") ?? "");
  return { html, url: response.headers.get("x-final-url") || address.trim() };
}
