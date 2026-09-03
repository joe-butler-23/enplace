import { useSyncExternalStore } from "react";
import { parsePlan, parseShopping, scanRecipes, type Plan, type Recipe } from "../core";
import { listKitchenPaths, observeKitchen, readKitchenBytes, readKitchenText } from "./doc";
import { currentKitchenConnection, onCurrentKitchenConnection } from "./current";

export type KitchenFile = { path: string };
export type ShoppingList = { items: { id: string; content: string; labels: string[]; sources: string[]; checked: boolean }[] };
export type KitchenSnapshot = {
  recipes: Recipe[]; plan: Plan; shopping: ShoppingList; files: KitchenFile[];
  texts: ReadonlyMap<string, string>; imageUrls: ReadonlyMap<string, string>; revision: number;
};
const empty: KitchenSnapshot = { recipes: [], plan: { marked: [], days: new Map() }, shopping: { items: [] }, files: [], texts: new Map(), imageUrls: new Map(), revision: 0 };
let snapshot = empty;
let bound = currentKitchenConnection();
let unobserve: (() => void) | null = null;
const listeners = new Set<() => void>();
const urls = new Map<string, string>();
const images = /\.(?:avif|gif|jpe?g|png|webp)$/i;
const emit = (): void => listeners.forEach((listener) => listener());
const shoppingList = (text: string): ShoppingList => ({ items: parseShopping(text).map((item) => ({
  id: `line:${item.line}`, content: item.text, labels: item.heading ? [item.heading] : [],
  sources: item.heading ? [item.heading] : [], checked: item.checked,
})) });
function rebuild(changed?: ReadonlySet<string>): void {
  if (!bound) { snapshot = empty; emit(); return; }
  const paths = listKitchenPaths(bound.doc);
  const texts = new Map<string, string>();
  for (const path of paths) {
    const text = readKitchenText(bound.doc, path);
    if (text !== null) texts.set(path, text);
  }
  if (changed) for (const path of changed) {
    const url = urls.get(path);
    if (url) URL.revokeObjectURL(url);
    urls.delete(path);
  }
  for (const [path, url] of urls) if (!paths.includes(path)) { URL.revokeObjectURL(url); urls.delete(path); }
  // Cover URLs are made here, synchronously, so the first render already has every image.
  for (const path of paths) {
    if (!images.test(path) || urls.has(path)) continue;
    const bytes = readKitchenBytes(bound.doc, path);
    if (bytes) urls.set(path, URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer])));
  }
  snapshot = {
    recipes: scanRecipes([...texts].filter(([path]) => /\.md$/i.test(path)).map(([path, text]) => ({ path, text }))),
    plan: parsePlan(texts.get("Plan.md") ?? ""), shopping: shoppingList(texts.get("Shopping.md") ?? ""),
    files: paths.map((path) => ({ path })), texts, imageUrls: new Map(urls), revision: snapshot.revision + 1,
  };
  emit();
}
function bind(): void {
  const next = currentKitchenConnection();
  if (next === bound && unobserve) return;
  unobserve?.();
  for (const url of urls.values()) URL.revokeObjectURL(url);
  urls.clear(); bound = next;
  unobserve = bound ? observeKitchen(bound.doc, (paths) => rebuild(paths)) : null;
  rebuild();
}
onCurrentKitchenConnection(bind);
bind();
export const getKitchenSnapshot = (): KitchenSnapshot => snapshot;
export function subscribeKitchen(listener: () => void): () => void {
  listeners.add(listener); return () => listeners.delete(listener);
}
export const useKitchenStore = (): KitchenSnapshot => useSyncExternalStore(subscribeKitchen, getKitchenSnapshot, getKitchenSnapshot);
