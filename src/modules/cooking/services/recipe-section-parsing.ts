export function parseIngredientsSection(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const items: string[] = [];
  let inSection = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("## ")) {
      if (inSection) break;
      if (/^##\s+Ingredients\b/i.test(line)) inSection = true;
      continue;
    }
    if (!inSection || !line) continue;
    const cleaned = line.replace(/^[-*+]\s+/, "").replace(/^\d+\.\s+/, "").trim();
    if (cleaned) items.push(cleaned);
  }

  return items;
}
