import { describe, expect, it } from "vitest";
import { renderItemHTML } from "../kanban/organiserCardTemplate";

describe("organiser recipe card markup", () => {
	it("uses separate named open and unschedule buttons", () => {
		const markup = renderItemHTML({ id: "recipes/soup.md", title: "Soup", path: "recipes/soup.md" }, "");
		expect(markup).toContain('<button type="button" class="card-open-btn card-header" aria-label="Open Soup">');
		expect(markup).toContain('data-kanban-action="remove-recipe"');
		expect(markup).not.toContain('role="button"');
	});

	it("renders only the resolved URL and never falls back to the raw cover path", () => {
		const item = {
			id: "recipes/soup.md",
			title: "Soup",
			path: "recipes/soup.md",
			coverImage: "/home/test/vault/images/soup.jpg",
		};
		const url = "https://images.example.test/soup.jpg";

		expect(renderItemHTML(item, url)).toContain(`src="${url}"`);
		expect(renderItemHTML(item, "")).not.toContain("/home/test/vault");
	});
});
