const CACHE_ROOT = "enplace-thumbnails";
const CACHE_VERSION = "v1";
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_SOURCE_DIMENSION = 8192;
const MAX_SOURCE_PIXELS = 16_000_000;

const tierSize = (tier: "card" | "detail") => tier === "card" ? 320 : 1280;

const isPassthroughFormat = (bytes: Uint8Array) => {
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));
  return (bytes[0] === 0xff && bytes[1] === 0xd8) ||
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte) ||
    (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") ||
    ascii(0, 3) === "GIF" ||
    (ascii(4, 4) === "ftyp" && ["avif", "avis"].includes(ascii(8, 4)));
};

const cacheDirectory = async () => {
  const root = await navigator.storage.getDirectory();
  const cache = await root.getDirectoryHandle(CACHE_ROOT, { create: true });
  return cache.getDirectoryHandle(CACHE_VERSION, { create: true });
};

const cacheKey = async (bytes: Uint8Array<ArrayBuffer>, tier: "card" | "detail") => {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hash}-${tier}-${CACHE_VERSION}`;
};

const cachedBlob = async (name: string) => {
  try {
    const file = await (await cacheDirectory()).getFileHandle(name).then(handle => handle.getFile());
    return file.size > 0 ? file : null;
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return null;
    throw error;
  }
};

const writeCache = async (name: string, blob: Blob) => {
  const handle = await (await cacheDirectory()).getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
};

export async function getOrCreateThumbnail(
  sourceBytes: Uint8Array,
  tier: "card" | "detail"
): Promise<Blob> {
  if (sourceBytes.byteLength > MAX_SOURCE_BYTES) {
    throw new Error(`Image source exceeds ${MAX_SOURCE_BYTES} byte thumbnail limit`);
  }
  const bytes = Uint8Array.from(sourceBytes);
  const name = await cacheKey(bytes, tier);
  const cached = await cachedBlob(name);
  if (cached) return cached;

  const source = new Blob([bytes]);
  const bitmap = await createImageBitmap(source);
  try {
    const { width, height } = bitmap;
    if (width > MAX_SOURCE_DIMENSION || height > MAX_SOURCE_DIMENSION || width * height > MAX_SOURCE_PIXELS) {
      throw new Error(`Image dimensions ${width}x${height} exceed thumbnail dimension limit`);
    }
    const max = tierSize(tier);
    if (tier === "detail" && width <= max && height <= max && isPassthroughFormat(bytes)) {
      await writeCache(name, source);
      return source;
    }
    const scale = Math.min(1, max / Math.max(width, height));
    const targetWidth = Math.max(1, Math.floor(width * scale));
    const targetHeight = Math.max(1, Math.floor(height * scale));
    const canvas = new OffscreenCanvas(targetWidth, targetHeight);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    const output = await canvas.convertToBlob({
      type: "image/webp",
      quality: tier === "card" ? 0.75 : 0.8
    });
    await writeCache(name, output);
    return output;
  } finally {
    bitmap.close();
  }
}

export async function clearThumbnailCache(): Promise<void> {
  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry(CACHE_ROOT, { recursive: true });
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
  }
}
