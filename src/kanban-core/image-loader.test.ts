import { describe, expect, it, vi } from "vitest";
import {
	KANBAN_IMAGE_ATTRIBUTE,
	KANBAN_IMAGE_LOADED_ATTRIBUTE,
	resolveCardImagesInDom,
} from "./image-loader";

// vitest.config.ts runs kanban-core tests in the "node" environment (no
// jsdom/happy-dom), so image-loader tests drive a purpose-built fake image
// element rather than a real one — same rationale as patcher.test.ts's
// FakeElement, scoped down to only what resolveCardImagesInDom touches:
// tag-agnostic attribute get/set and a fake `src` assignment.
class FakeImage {
	private attrs = new Map<string, string>();
	src = "";
	getAttribute(name: string): string | null {
		return this.attrs.has(name) ? this.attrs.get(name)! : null;
	}
	setAttribute(name: string, value: string): void {
		this.attrs.set(name, value);
	}
}

class FakeContainer {
	constructor(private images: FakeImage[]) {}
	querySelectorAll(): FakeImage[] {
		return this.images.filter((img) => img.getAttribute(KANBAN_IMAGE_ATTRIBUTE) !== null);
	}
}

function asContainer(container: FakeContainer): ParentNode {
	return container as unknown as ParentNode;
}
function asImage(img: FakeImage): HTMLImageElement {
	return img as unknown as HTMLImageElement;
}

describe("resolveCardImagesInDom", () => {
	it("loads a pending image and marks it loaded", async () => {
		const img = new FakeImage();
		img.setAttribute(KANBAN_IMAGE_ATTRIBUTE, "recipes/soup.png");
		const container = new FakeContainer([img]);
		const loadCardImage = vi.fn().mockResolvedValue("blob://resolved");

		resolveCardImagesInDom(asContainer(container), { loadCardImage });
		expect(img.getAttribute(KANBAN_IMAGE_LOADED_ATTRIBUTE)).toBe("1");
		await vi.waitFor(() => expect(img.src).toBe("blob://resolved"));
		expect(loadCardImage).toHaveBeenCalledWith("recipes/soup.png");
	});

	it("skips images already marked loaded", () => {
		const img = new FakeImage();
		img.setAttribute(KANBAN_IMAGE_ATTRIBUTE, "recipes/soup.png");
		img.setAttribute(KANBAN_IMAGE_LOADED_ATTRIBUTE, "1");
		const container = new FakeContainer([img]);
		const loadCardImage = vi.fn().mockResolvedValue("blob://resolved");

		resolveCardImagesInDom(asContainer(container), { loadCardImage });
		expect(loadCardImage).not.toHaveBeenCalled();
	});

	it("reports unavailable images via the callback instead of a hardcoded class", async () => {
		const img = new FakeImage();
		img.setAttribute(KANBAN_IMAGE_ATTRIBUTE, "recipes/missing.png");
		const container = new FakeContainer([img]);
		const loadCardImage = vi.fn().mockResolvedValue(null);
		const onImageUnavailable = vi.fn();

		resolveCardImagesInDom(asContainer(container), { loadCardImage, onImageUnavailable });
		await vi.waitFor(() => expect(onImageUnavailable).toHaveBeenCalledWith(asImage(img)));
		expect(img.src).toBe("");
	});

	it("reports a load error through onImageLoadError and still marks unavailable", async () => {
		const img = new FakeImage();
		img.setAttribute(KANBAN_IMAGE_ATTRIBUTE, "recipes/broken.png");
		const container = new FakeContainer([img]);
		const error = new Error("network down");
		const loadCardImage = vi.fn().mockRejectedValue(error);
		const onImageLoadError = vi.fn();
		const onImageUnavailable = vi.fn();

		resolveCardImagesInDom(asContainer(container), { loadCardImage, onImageLoadError, onImageUnavailable });
		await vi.waitFor(() => expect(onImageLoadError).toHaveBeenCalledWith(error, "recipes/broken.png", asImage(img)));
		expect(onImageUnavailable).toHaveBeenCalledWith(asImage(img));
	});
});
