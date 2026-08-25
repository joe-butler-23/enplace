function normalize(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/");
}

export async function appDataDir(): Promise<string> {
  return "/appdata";
}

export async function homeDir(): Promise<string> {
  return "/home";
}

export async function join(...parts: string[]): Promise<string> {
  const filtered = parts.filter((part) => part && part.trim());
  if (filtered.length === 0) return "/";
  const joined = filtered
    .map((part) => part.replace(/^\/+|\/+$/g, ""))
    .join("/");
  return normalize(`/${joined}`);
}
