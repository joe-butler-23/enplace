/**
 * Splits a view-ordered list of items into two batches of unique paths:
 * the first viewport-sized group and the remainder.
 *
 * Paths are collected in first-occurrence order. The first batch contains unique
 * paths from the first `viewportSize` items; the remainder contains paths from
 * the remaining items that were not already in the first batch.
 */
export function splitViewportPaths<T>(
  items: readonly T[],
  viewportSize: number,
  extractPath: (item: T) => string | null,
): { firstBatch: string[]; restBatch: string[] } {
  if (viewportSize <= 0) {
    // Degenerate: everything goes into the rest batch.
    const paths: string[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const path = extractPath(item);
      if (path !== null && !seen.has(path)) {
        seen.add(path);
        paths.push(path);
      }
    }
    return { firstBatch: [], restBatch: paths };
  }

  const firstSeen = new Set<string>();
  const firstBatch: string[] = [];

  const limit = Math.min(items.length, viewportSize);
  for (let i = 0; i < limit; i++) {
    const path = extractPath(items[i]);
    if (path !== null && !firstSeen.has(path)) {
      firstSeen.add(path);
      firstBatch.push(path);
    }
  }

  const restBatch: string[] = [];
  for (const item of items) {
    const path = extractPath(item);
    if (path !== null && !firstSeen.has(path)) {
      firstSeen.add(path);
      restBatch.push(path);
    }
  }

  return { firstBatch, restBatch };
}
