// The core discovers and orchestrates card image lazy-loading. Image resolution
// and failure presentation are consumer-provided, so no app CSS class is
// hardcoded here.

export const KANBAN_IMAGE_ATTRIBUTE = "data-kanban-img";
export const KANBAN_IMAGE_LOADED_ATTRIBUTE = "data-kanban-img-loaded";

export type LoadCardImage = (path: string) => Promise<string | null>;

export type ResolveCardImagesOptions = {
	loadCardImage: LoadCardImage;
	onImageUnavailable?: (img: HTMLImageElement) => void;
	onImageLoadError?: (error: unknown, path: string, img: HTMLImageElement) => void;
};

// Finds every not-yet-loaded `data-kanban-img` image under `container` and
// resolves its real src through the injected loader. Deliberately avoids the
// CSS `:not()` pseudo-selector (filters the "already loaded" marker in JS
// instead) so both real DOM and the purpose-built fake DOM used in
// kanban-core's node-environment tests can drive it identically.
export function resolveCardImagesInDom(container: ParentNode, options: ResolveCardImagesOptions): void {
	const { loadCardImage, onImageUnavailable, onImageLoadError } = options;
	const candidates = container.querySelectorAll<HTMLImageElement>(`img[${KANBAN_IMAGE_ATTRIBUTE}]`);

	for (const img of Array.from(candidates)) {
		if (img.getAttribute(KANBAN_IMAGE_LOADED_ATTRIBUTE) === "1") continue;
		const rawPath = img.getAttribute(KANBAN_IMAGE_ATTRIBUTE);
		if (!rawPath) continue;
		img.setAttribute(KANBAN_IMAGE_LOADED_ATTRIBUTE, "1");
		void loadCardImage(rawPath)
			.then((loadedSrc) => {
				if (!loadedSrc) {
					onImageUnavailable?.(img);
					return;
				}
				img.src = loadedSrc;
			})
			.catch((error) => {
				onImageLoadError?.(error, rawPath, img);
				onImageUnavailable?.(img);
			});
	}
}
