/** A relay HTTP endpoint, derived from the configured relay address; null when there is no relay. */
function relayEndpoint(relayUrl: string | null | undefined, path: "/page" | "/image"): string | null {
  if (!relayUrl?.trim()) return null;
  let url: URL;
  try { url = new URL(relayUrl.trim()); } catch { return null; }
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = path; url.search = ""; url.hash = "";
  return url.href;
}

/** The relay's page endpoint. */
export function pageEndpoint(relayUrl: string | null | undefined): string | null { return relayEndpoint(relayUrl, "/page"); }
/** The relay's picture endpoint, which fetches the image a recipe page names. */
export function imageEndpoint(relayUrl: string | null | undefined): string | null { return relayEndpoint(relayUrl, "/image"); }

const configuredRelay = (): string | undefined => (import.meta as ImportMeta & { env?: { VITE_ENPLACE_RELAY_URL?: string } }).env?.VITE_ENPLACE_RELAY_URL;
export function configuredPageEndpoint(): string | null { return pageEndpoint(configuredRelay()); }
export function configuredImageEndpoint(): string | null { return imageEndpoint(configuredRelay()); }

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

/** Fetches a recipe's picture through the relay. A picture is optional, so any failure yields null rather than an error. */
export async function fetchImageBlob(address: string, endpoint: string, fetcher: typeof fetch = fetch): Promise<Blob | null> {
  if (!/^https?:\/\//i.test(address.trim())) return null;
  try {
    const response = await fetcher(`${endpoint}?url=${encodeURIComponent(address.trim())}`);
    if (!response.ok) return null;
    const type = response.headers.get("content-type") ?? "";
    if (!/^image\//i.test(type)) return null;
    const bytes = await response.arrayBuffer();
    return bytes.byteLength ? new Blob([bytes], { type: type.split(";")[0].trim() }) : null;
  } catch { return null; }
}
