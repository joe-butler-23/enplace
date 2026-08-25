import { describe, expect, it } from "vitest";
import { escapeHtml } from "./html";

describe("escapeHtml", () => {
	it("escapes all HTML entities", () => {
		expect(escapeHtml(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &#39;");
	});

	it("returns an empty string for empty input", () => {
		expect(escapeHtml("")).toBe("");
	});

	it("leaves already-safe text unchanged", () => {
		expect(escapeHtml("A safe card title")).toBe("A safe card title");
	});
});
