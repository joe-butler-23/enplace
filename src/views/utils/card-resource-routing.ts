const DIRECT_IMAGE_SOURCE = /^(https?:\/\/|data:|blob:|file:|asset:|app:\/\/|obsidian:\/\/)/i;

export function isDirectCardSource(path: string): boolean {
  return DIRECT_IMAGE_SOURCE.test(path);
}
