type ResponsiveSampleCover = { avifSrcSet: string; webpSrcSet: string };

export function responsiveSampleCover(
  url: string,
  widths: readonly number[],
): ResponsiveSampleCover | null {
  const match = /^(.*\/samples\/)([^/?#]+)\.webp([?#].*)?$/.exec(url);
  if (!match) return null;
  const [, directory, stem, suffix = ""] = match;
  const srcSet = (extension: "avif" | "webp") => widths
    .map((width) => `${directory}${stem}-${width}.${extension}${suffix} ${width}w`)
    .join(", ");
  return { avifSrcSet: srcSet("avif"), webpSrcSet: srcSet("webp") };
}
