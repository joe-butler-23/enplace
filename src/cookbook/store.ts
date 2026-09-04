import { useSyncExternalStore } from "react";
import { finalizeRecipes, parsePlan, parseRecipe, parseShopping, scanRecipes, type Plan, type Recipe } from "../core";
import {
  hasCookbookFile, isTextPath, listCookbookPaths, observeCookbook, readCookbookBytes, readCookbookText,
} from "./doc";
import { currentCookbookConnection, onCurrentCookbookConnection } from "./current";

export type CookbookFile = { path: string };
export type ShoppingList = { items: { id: string; content: string; labels: string[]; sources: string[]; checked: boolean }[] };
export type CookbookSnapshot = {
  recipes: Recipe[]; plan: Plan; shopping: ShoppingList; files: CookbookFile[];
  texts: ReadonlyMap<string, string>; imageUrls: ReadonlyMap<string, string>;
  revision: number;
};
const empty: CookbookSnapshot = {
  recipes: [], plan: { marked: [], days: new Map(), notes: new Map() }, shopping: { items: [] },
  files: [], texts: new Map(), imageUrls: new Map(), revision: 0,
};
let snapshot = empty;
let bound = currentCookbookConnection();
let unobserve: (() => void) | null = null;
const listeners = new Set<() => void>();
const images = /\.(?:avif|gif|jpe?g|png|webp)$/i;
const recipePath = (path: string): boolean => /\.md$/i.test(path) && path !== "Plan.md" && path !== "Shopping.md";
const emit = (): void => listeners.forEach((listener) => listener());
const shoppingList = (text: string): ShoppingList => ({ items: parseShopping(text).map((item) => ({
  id: `line:${item.line}`, content: item.text, labels: item.aisle ? [item.aisle] : [],
  sources: item.heading ? [item.heading] : [], checked: item.checked,
})) });
const sameReferences = <T,>(left: readonly T[], right: readonly T[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

function imageUrl(path: string): string | null {
  if (!bound) return null;
  const bytes = readCookbookBytes(bound.doc, path);
  return bytes ? URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer])) : null;
}

function bootstrap(): void {
  if (!bound) {
    const changed = snapshot !== empty;
    snapshot = empty;
    if (changed) emit();
    return;
  }
  const paths = listCookbookPaths(bound.doc);
  const texts = new Map<string, string>();
  const imageUrls = new Map<string, string>();
  for (const path of paths) {
    if (isTextPath(path)) {
      const text = readCookbookText(bound.doc, path);
      if (text !== null) texts.set(path, text);
    }
    if (images.test(path)) {
      const url = imageUrl(path);
      if (url) imageUrls.set(path, url);
    }
  }
  snapshot = {
    recipes: scanRecipes([...texts]
      .filter(([path]) => recipePath(path))
      .map(([path, text]) => ({ path, text }))),
    plan: parsePlan(texts.get("Plan.md") ?? ""),
    shopping: shoppingList(texts.get("Shopping.md") ?? ""),
    files: paths.map((path) => ({ path })), texts, imageUrls,
    revision: snapshot.revision + 1,
  };
  emit();
}

function projectFiles(changed: ReadonlySet<string>): CookbookFile[] {
  const files = new Map(snapshot.files.map((file) => [file.path, file]));
  let differs = false;
  for (const path of changed) {
    const exists = bound ? hasCookbookFile(bound.doc, path) : false;
    if (exists === files.has(path)) continue;
    differs = true;
    if (exists) files.set(path, { path }); else files.delete(path);
  }
  return differs
    ? [...files.values()].sort((left, right) => left.path.localeCompare(right.path))
    : snapshot.files;
}

function projectTexts(changed: ReadonlySet<string>): { texts: ReadonlyMap<string, string>; paths: Set<string> } {
  let texts: Map<string, string> | null = null;
  const paths = new Set<string>();
  for (const path of changed) {
    if (!isTextPath(path)) continue;
    const next = bound ? readCookbookText(bound.doc, path) : null;
    if (next === (snapshot.texts.get(path) ?? null) && snapshot.texts.has(path) === (next !== null)) continue;
    texts ??= new Map(snapshot.texts);
    if (next === null) texts.delete(path); else texts.set(path, next);
    paths.add(path);
  }
  return { texts: texts ?? snapshot.texts, paths };
}

function projectImages(changed: ReadonlySet<string>): ReadonlyMap<string, string> {
  let next: Map<string, string> | null = null;
  for (const path of changed) {
    if (!images.test(path)) continue;
    const previous = snapshot.imageUrls.get(path);
    const url = imageUrl(path);
    if (!previous && !url) continue;
    next ??= new Map(snapshot.imageUrls);
    if (previous) URL.revokeObjectURL(previous);
    next.delete(path);
    if (url) next.set(path, url);
  }
  return next ?? snapshot.imageUrls;
}

function projectRecipes(paths: ReadonlySet<string>, texts: ReadonlyMap<string, string>): Recipe[] {
  if (![...paths].some(recipePath)) return snapshot.recipes;
  const recipes = new Map(snapshot.recipes.map((recipe) => [recipe.path, recipe]));
  for (const path of paths) {
    if (!recipePath(path)) continue;
    const text = texts.get(path);
    const recipe = text === undefined ? null : parseRecipe(path, text);
    if (recipe) recipes.set(path, recipe); else recipes.delete(path);
  }
  const ordered = [...recipes.values()].sort((left, right) => left.path.localeCompare(right.path));
  const result = finalizeRecipes(ordered);
  return sameReferences(result, snapshot.recipes) ? snapshot.recipes : result;
}

function rebuild(changed: ReadonlySet<string>): void {
  if (!bound) return;
  const files = projectFiles(changed);
  const textProjection = projectTexts(changed);
  const recipes = projectRecipes(textProjection.paths, textProjection.texts);
  const plan = textProjection.paths.has("Plan.md")
    ? parsePlan(textProjection.texts.get("Plan.md") ?? "") : snapshot.plan;
  const shopping = textProjection.paths.has("Shopping.md")
    ? shoppingList(textProjection.texts.get("Shopping.md") ?? "") : snapshot.shopping;
  const imageUrls = projectImages(changed);
  if (
    recipes === snapshot.recipes && plan === snapshot.plan && shopping === snapshot.shopping
    && files === snapshot.files && textProjection.texts === snapshot.texts && imageUrls === snapshot.imageUrls
  ) return;
  snapshot = {
    recipes, plan, shopping, files, texts: textProjection.texts, imageUrls,
    revision: snapshot.revision + 1,
  };
  emit();
}

function bind(): void {
  const next = currentCookbookConnection();
  if (next === bound && unobserve) return;
  unobserve?.();
  for (const url of snapshot.imageUrls.values()) URL.revokeObjectURL(url);
  bound = next;
  unobserve = bound ? observeCookbook(bound.doc, (paths) => rebuild(paths)) : null;
  bootstrap();
}
onCurrentCookbookConnection(bind);
bind();
export const getCookbookSnapshot = (): CookbookSnapshot => snapshot;
export function subscribeCookbook(listener: () => void): () => void {
  listeners.add(listener); return () => listeners.delete(listener);
}
export function useCookbookSlice<K extends keyof CookbookSnapshot>(key: K): CookbookSnapshot[K] {
  return useSyncExternalStore(subscribeCookbook, () => snapshot[key], () => snapshot[key]);
}
export function useCookbookText(path: string | null): string | null {
  return useSyncExternalStore(
    subscribeCookbook,
    () => path === null ? null : snapshot.texts.get(path) ?? null,
    () => path === null ? null : snapshot.texts.get(path) ?? null,
  );
}
