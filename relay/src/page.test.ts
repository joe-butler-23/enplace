import { describe, expect, it } from "vitest";
import { allowedOrigin, fetchPage, MAX_IMAGE_BYTES, MAX_PAGE_BYTES, pageResponse, pageTarget } from "./page";

const html = (body: string, init: ResponseInit = {}) => new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, ...init });

describe("page targets", () => {
  it("accepts public http and https pages and drops the fragment", () => {
    const target = pageTarget("https://www.example.com/recipes/soup?x=1#top");
    expect(target).toMatchObject({ ok: true });
    if (target.ok) expect(target.url.href).toBe("https://www.example.com/recipes/soup?x=1");
  });
  it("rejects missing, malformed, non-web, credentialed, numeric and private addresses", () => {
    for (const raw of [null, "", "not a url", "ftp://example.com/x", "https://user:pw@example.com/", "http://127.0.0.1/", "http://[::1]/", "http://localhost/", "http://intranet/", "http://box.local/", "http://svc.internal/"]) {
      expect(pageTarget(raw)).toMatchObject({ ok: false, status: 400 });
    }
  });
});

describe("allowed origins", () => {
  it("allows the configured site, its preview deployments and local development only", () => {
    expect(allowedOrigin("https://enplace-trial.pages.dev", "https://enplace-trial.pages.dev")).toBe("https://enplace-trial.pages.dev");
    expect(allowedOrigin("https://abc123.enplace-trial.pages.dev", "https://enplace-trial.pages.dev")).toBe("https://abc123.enplace-trial.pages.dev");
    expect(allowedOrigin("http://127.0.0.1:4173", "https://enplace-trial.pages.dev")).toBe("http://127.0.0.1:4173");
    expect(allowedOrigin("https://evil.example", "https://enplace-trial.pages.dev")).toBeNull();
    expect(allowedOrigin("https://enplace-trial.pages.dev.evil.example", "https://enplace-trial.pages.dev")).toBeNull();
    expect(allowedOrigin(null, "https://enplace-trial.pages.dev")).toBeNull();
    expect(allowedOrigin("https://enplace-trial.pages.dev", undefined)).toBeNull();
  });
});

describe("fetching a page", () => {
  const target = new URL("https://www.example.com/soup");
  it("returns HTML bytes, the content type and the final address", async () => {
    const page = await fetchPage(target, async () => html("<p>hi</p>"));
    expect(page.status).toBe(200);
    expect(new TextDecoder().decode(page.body)).toBe("<p>hi</p>");
    expect(page.finalUrl).toBe(target.href); // A Response without a url reports the requested address.
    const response = pageResponse(page, "https://enplace-trial.pages.dev");
    expect(response.headers.get("access-control-allow-origin")).toBe("https://enplace-trial.pages.dev");
    expect(response.headers.get("x-final-url")).toBe(target.href);
    expect(response.headers.get("access-control-expose-headers")).toBe("x-final-url");
  });
  it("refuses non-HTML, failing, oversized and unreachable pages", async () => {
    expect((await fetchPage(target, async () => new Response("{}", { headers: { "content-type": "application/json" } }))).status).toBe(415);
    expect((await fetchPage(target, async () => new Response("gone", { status: 404 }))).status).toBe(502);
    expect((await fetchPage(target, async () => html("x".repeat(MAX_PAGE_BYTES + 1)))).status).toBe(413);
    expect((await fetchPage(target, async () => { throw new TypeError("fetch failed"); })).status).toBe(504);
    expect(pageResponse({ status: 415, message: "no" }, "https://enplace-trial.pages.dev").status).toBe(415);
  });
});

describe("fetching a picture", () => {
  const target = new URL("https://www.example.com/soup.jpg");
  const png = (body = "png-bytes", init: ResponseInit = {}) => new Response(body, { status: 200, headers: { "content-type": "image/png" }, ...init });
  it("returns image bytes with their type and refuses pages, other types, failures and oversized files", async () => {
    const picture = await fetchPage(target, async () => png(), "image");
    expect(picture.status).toBe(200);
    expect(picture.contentType).toBe("image/png");
    expect(new TextDecoder().decode(picture.body)).toBe("png-bytes");
    expect(pageResponse(picture, "https://enplace-trial.pages.dev").headers.get("content-type")).toBe("image/png");
    expect((await fetchPage(target, async () => html("<p>hi</p>"), "image"))).toMatchObject({ status: 415, message: "That address is not a picture." });
    expect((await fetchPage(target, async () => new Response("x", { headers: { "content-type": "image/svg+xml" } }), "image")).status).toBe(415);
    expect((await fetchPage(target, async () => new Response("gone", { status: 404 }), "image")).status).toBe(502);
    expect((await fetchPage(target, async () => png("x".repeat(MAX_IMAGE_BYTES + 1)), "image")).status).toBe(413);
    // A page fetch still refuses a picture.
    expect((await fetchPage(target, async () => png())).status).toBe(415);
  });
});
