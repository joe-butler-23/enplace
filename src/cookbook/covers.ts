import type * as Y from "yjs";
import { scanRecipes } from "../core";
import { resolveDatabaseCoverPath } from "../modules/cooking/utils/databaseCover";
import {
  listCookbookPaths, readCookbookBytes, readCookbookText, writeCookbookBytes,
} from "./doc";

export const COVER_LONGEST_SIDE = 1280;
export const COVER_THUMBNAIL_SIZE = 448;
// Measured on the eleven sample covers at 448px, which is a 224px card at DPR 2: 0.70 is
// indistinguishable from 0.82 there and 28% smaller. The display cover is shown far larger,
// was not measured at that size, and keeps its own quality.
const COVER_QUALITY = 0.82;
const THUMBNAIL_QUALITY = 0.70;
export const COVER_BACKFILL_ORIGIN = Symbol("enplace-cookbook-cover-backfill");

export type CoverFiles = { cover: Uint8Array; thumbnail: Uint8Array };
type CoverTransformer = (source: Blob) => Promise<CoverFiles>;

/** `images/dish.jpg` and `images/dish.webp` both map to `images/dish.card.webp`. */
export function thumbnailPathForCover(coverPath: string): string {
  const slash = coverPath.lastIndexOf("/");
  const dot = coverPath.lastIndexOf(".");
  const stem = dot > slash ? coverPath.slice(0, dot) : coverPath;
  return `${stem}.card.webp`;
}

export function cardCoverUrl(
  coverPath: string,
  imageUrls: ReadonlyMap<string, string>,
): string | null {
  return imageUrls.get(thumbnailPathForCover(coverPath)) ?? imageUrls.get(coverPath) ?? null;
}

export function coverGeometry(width: number, height: number): {
  cappedWidth: number; cappedHeight: number; cropX: number; cropY: number; cropSize: number;
} {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("Cover image has invalid dimensions.");
  }
  const scale = Math.min(1, COVER_LONGEST_SIDE / Math.max(width, height));
  const cropSize = Math.min(width, height);
  return {
    cappedWidth: Math.max(1, Math.round(width * scale)),
    cappedHeight: Math.max(1, Math.round(height * scale)),
    cropX: (width - cropSize) / 2,
    cropY: (height - cropSize) / 2,
    cropSize,
  };
}

function canvas(width: number, height: number): { element: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const element = document.createElement("canvas");
  element.width = width;
  element.height = height;
  const context = element.getContext("2d");
  if (!context) throw new Error("This browser cannot resize cover images.");
  return { element, context };
}

function webpBytes(element: HTMLCanvasElement, quality: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    element.toBlob((blob) => {
      // toBlob silently falls back to PNG where WebP encoding is unsupported; never store that under a .webp name.
      if (!blob || blob.type !== "image/webp") {
        reject(new Error("This browser could not encode the cover image as WebP."));
        return;
      }
      void blob.arrayBuffer().then((bytes) => resolve(new Uint8Array(bytes)), reject);
    }, "image/webp", quality);
  });
}

/** Decode once, then produce the only two stored cover representations. */
export async function createCoverFiles(source: Blob): Promise<CoverFiles> {
  const image = await createImageBitmap(source, { imageOrientation: "from-image" });
  try {
    const geometry = coverGeometry(image.width, image.height);
    const capped = canvas(geometry.cappedWidth, geometry.cappedHeight);
    capped.context.imageSmoothingQuality = "high";
    capped.context.drawImage(image, 0, 0, geometry.cappedWidth, geometry.cappedHeight);
    const thumbnail = canvas(COVER_THUMBNAIL_SIZE, COVER_THUMBNAIL_SIZE);
    thumbnail.context.imageSmoothingQuality = "high";
    thumbnail.context.drawImage(
      image,
      geometry.cropX, geometry.cropY, geometry.cropSize, geometry.cropSize,
      0, 0, COVER_THUMBNAIL_SIZE, COVER_THUMBNAIL_SIZE,
    );
    const [cover, thumbnailBytes] = await Promise.all([
      webpBytes(capped.element, COVER_QUALITY), webpBytes(thumbnail.element, THUMBNAIL_QUALITY),
    ]);
    return { cover, thumbnail: thumbnailBytes };
  } finally {
    image.close();
  }
}

/** Normalize legacy local covers after open; complete pairs need only a path-set check. */
export async function backfillCookbookCovers(
  doc: Y.Doc,
  transform: CoverTransformer = createCoverFiles,
): Promise<number> {
  const paths = new Set(listCookbookPaths(doc));
  const recipes = scanRecipes([...paths]
    .filter((path) => /\.md$/i.test(path) && path !== "Plan.md" && path !== "Shopping.md")
    .map((path) => ({ path, text: readCookbookText(doc, path) ?? "" })));
  const pending: Array<{ coverPath: string; thumbnailPath: string; files: CoverFiles }> = [];
  const considered = new Set<string>();
  const resolver = {
    findAbsolutePath: (candidate: string): string | null => paths.has(candidate) ? candidate : null,
    resolveLinkpath: (): null => null,
  };
  for (const recipe of recipes) {
    const coverPath = resolveDatabaseCoverPath(recipe.cover, recipe.path, resolver);
    if (!coverPath || !paths.has(coverPath) || considered.has(coverPath)) continue;
    considered.add(coverPath);
    const thumbnailPath = thumbnailPathForCover(coverPath);
    if (paths.has(thumbnailPath)) continue;
    const bytes = readCookbookBytes(doc, coverPath);
    if (!bytes) continue;
    try {
      const files = await transform(new Blob([bytes.slice().buffer as ArrayBuffer]));
      pending.push({ coverPath, thumbnailPath, files });
      paths.add(thumbnailPath);
    } catch (error) {
      console.warn(`Could not optimize cover ${coverPath}:`, error);
    }
  }
  if (!pending.length) return 0;
  let written = 0;
  doc.transact(() => {
    for (const entry of pending) {
      // A concurrent writer may have completed the same deterministic pair while images decoded.
      if (listCookbookPaths(doc).includes(entry.thumbnailPath)) continue;
      writeCookbookBytes(doc, entry.coverPath, entry.files.cover, COVER_BACKFILL_ORIGIN);
      writeCookbookBytes(doc, entry.thumbnailPath, entry.files.thumbnail, COVER_BACKFILL_ORIGIN);
      written += 1;
    }
  }, COVER_BACKFILL_ORIGIN);
  return written;
}
