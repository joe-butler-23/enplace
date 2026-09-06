import { describe, expect, it } from "vitest";
import { fetchPageHtml, pageEndpoint } from "./page-fetch";

describe("page endpoint", () => {
  it("derives the relay's HTTP page route from its websocket address", () => {
    expect(pageEndpoint("wss://enplace-relay.joesdownloads.workers.dev/parties/kitchen")).toBe("https://enplace-relay.joesdownloads.workers.dev/page");
    expect(pageEndpoint("ws://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787/page");
    expect(pageEndpoint("")).toBeNull();
    expect(pageEndpoint(null)).toBeNull();
    expect(pageEndpoint("not a url")).toBeNull();
  });
});

describe("fetching a page through the relay", () => {
  const endpoint = "https://relay.example/page";
  it("asks the relay for the address and decodes the page with its charset and final address", async () => {
    let asked = "";
    const latin = new TextEncoder().encode("<html><head><meta charset=\"iso-8859-1\"></head><body>café</body></html>");
    const bytes = Uint8Array.from(latin.map((byte, index) => (index === latin.indexOf(0xc3) ? 0xe9 : byte)).filter((_, index) => index !== latin.indexOf(0xc3) + 1));
    const page = await fetchPageHtml(" https://www.example.com/soup ", endpoint, async (input) => {
      asked = String(input);
      return new Response(bytes, { headers: { "content-type": "text/html", "x-final-url": "https://www.example.com/soup-final" } });
    });
    expect(asked).toBe(`${endpoint}?url=${encodeURIComponent("https://www.example.com/soup")}`);
    expect(page.html).toContain("café");
    expect(page.url).toBe("https://www.example.com/soup-final");
  });
  it("turns relay refusals into plain messages", async () => {
    await expect(fetchPageHtml("https://x.example", endpoint, async () => new Response("", { status: 429 }))).rejects.toThrow(/wait a minute/);
    await expect(fetchPageHtml("https://x.example", endpoint, async () => new Response("Only public web sites can be fetched.", { status: 400 }))).rejects.toThrow("Only public web sites can be fetched.");
    await expect(fetchPageHtml("https://x.example", endpoint, async () => { throw new TypeError("offline"); })).rejects.toThrow(/reach the relay/);
  });
});
