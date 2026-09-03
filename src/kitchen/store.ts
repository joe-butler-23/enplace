import { useSyncExternalStore } from "react";
import { parsePlan, parseRecipe, parseShopping, scanRecipes, type Plan, type Recipe } from "../core";
import {
  hasKitchenFile, isTextPath, listKitchenPaths, observeKitchen, readKitchenBytes, readKitchenText,
} from "./doc";
import { currentKitchenConnection, onCurrentKitchenConnection } from "./current";

export type KitchenFile = { path: string };
export type ShoppingList = { items: { id: string; content: string; labels: string[]; sources: string[]; checked: boolean }[] };
export type KitchenSnapshot = {
  recipes: Recipe[]; plan: Plan; shopping: ShoppingList; files: KitchenFile[];
  texts: ReadonlyMap<string, string>; imageUrls: ReadonlyMap<string, string>;
  revision: number; catalogRevision: number;
};
const emptyPlan: Plan = { marked: [], days: new Map(), notes: new Map() };
const emptyShopping: ShoppingList = { items: [] };
const empty: KitchenSnapshot = {
  recipes: [], plan: emptyPlan, shopping: emptyShopping, files: [], texts: new Map(), imageUrls: new Map(),
  revision: 0, catalogRevision: 0,
};
let snapshot = empty;
let bound = currentKitchenConnection();
let unobserve: (() => void) | null = null;
const listeners = new Set<() => void>();
const urls = new Map<string, string>();
let filesByPath = new Map<string, KitchenFile>();
let recipesByPath = new Map<string, Recipe>();
const images = /\.(?:avif|gif|jpe?g|png|webp)$/i;
const emit = (): void => listeners.forEach((listener) => listener());
const shoppingList = (text: string): ShoppingList => ({ items: parseShopping(text).map((item) => ({
  id: `line:${item.line}`, content: item.text, labels: item.heading ? [item.heading] : [],
  sources: item.heading ? [item.heading] : [], checked: item.checked,
})) });
const recipeStem = (path: string): string => path.split("/").pop()?.replace(/\.md$/i, "") ?? path;
const sameReferences = <T,>(left: readonly T[], right: readonly T[]): boolean => (
  left.length === right.length && left.every((value, index) => value === right[index])
);

function bootstrap(): void {
  if (!bound) {
    const changed = snapshot !== empty;
    snapshot = empty; filesByPath = new Map(); recipesByPath = new Map();
    if (changed) emit();
    return;
  }
  const paths = listKitchenPaths(bound.doc);
  const texts = new Map<string, string>();
  filesByPath = new Map(paths.map((path) => [path, { path }]));
  for (const path of paths) {
    if (!isTextPath(path)) continue;
    const text = readKitchenText(bound.doc, path);
    if (text !== null) texts.set(path, text);
  }
  for (const path of paths) {
    if (!images.test(path)) continue;
    const bytes = readKitchenBytes(bound.doc, path);
    if (bytes) urls.set(path, URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer])));
  }
  const recipes = scanRecipes([...texts].map(([path, text]) => ({ path, text })));
  recipesByPath = new Map(recipes.map((recipe) => [recipe.path, recipe]));
  snapshot = {
    recipes,
    plan: parsePlan(texts.get("Plan.md") ?? ""),
    shopping: shoppingList(texts.get("Shopping.md") ?? ""),
    files: [...filesByPath.values()],
    texts,
    imageUrls: new Map(urls),
    revision: snapshot.revision + 1,
    catalogRevision: snapshot.catalogRevision + 1,
  };
  emit();
}

function updateRecipes(changedTextPaths: ReadonlySet<string>, texts: ReadonlyMap<string, string>): Recipe[] {
  let changed = false;
  for (const path of changedTextPaths) {
    if (!/\.md$/i.test(path) || path === "Plan.md" || path === "Shopping.md") continue;
    const text = texts.get(path);
    const next = text === undefined ? null : parseRecipe(path, text);
    const previous = recipesByPath.get(path);
    if (next) {
      recipesByPath.set(path, next);
      changed = true;
    } else if (previous) {
      recipesByPath.delete(path);
      changed = true;
    }
  }
  if (!changed) return snapshot.recipes;

  const stemCounts = new Map<string, number>();
  for (const recipe of recipesByPath.values()) {
    const stem = recipeStem(recipe.path).toLocaleLowerCase();
    stemCounts.set(stem, (stemCounts.get(stem) ?? 0) + 1);
  }
  for (const [path, recipe] of recipesByPath) {
    const stem = recipeStem(path);
    const link = stemCounts.get(stem.toLocaleLowerCase()) === 1 ? stem : path.replace(/\.md$/i, "");
    if (recipe.link !== link) recipesByPath.set(path, { ...recipe, link });
  }
  const recipes = [...recipesByPath.values()].sort((left, right) => (
    left.title.localeCompare(right.title) || left.path.localeCompare(right.path)
  ));
  return sameReferences(recipes, snapshot.recipes) ? snapshot.recipes : recipes;
}

function rebuild(changed: ReadonlySet<string>): void {
  if (!bound) return;
  let texts: ReadonlyMap<string, string> = snapshot.texts;
  let nextTexts: Map<string, string> | null = null;
  const changedTextPaths = new Set<string>();
  let filesChanged = false;
  let imagesChanged = false;

  for (const path of changed) {
    const exists = hasKitchenFile(bound.doc, path);
    const existed = filesByPath.has(path);
    if (exists !== existed) {
      filesChanged = true;
      if (exists) filesByPath.set(path, { path }); else filesByPath.delete(path);
    }

    if (isTextPath(path)) {
      const next = exists ? readKitchenText(bound.doc, path) : null;
      const previousExists = snapshot.texts.has(path);
      const previous = snapshot.texts.get(path);
      if ((next !== null) !== previousExists || (next !== null && next !== previous)) {
        nextTexts ??= new Map(snapshot.texts);
        if (next === null) nextTexts.delete(path); else nextTexts.set(path, next);
        changedTextPaths.add(path);
      }
    }

    if (images.test(path)) {
      const previous = urls.get(path);
      if (previous || exists) {
        if (previous) URL.revokeObjectURL(previous);
        urls.delete(path);
        if (exists) {
          const bytes = readKitchenBytes(bound.doc, path);
          if (bytes) urls.set(path, URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer])));
        }
        imagesChanged = true;
      }
    }
  }
  if (nextTexts) texts = nextTexts;

  const recipes = updateRecipes(changedTextPaths, texts);
  const plan = changedTextPaths.has("Plan.md") ? parsePlan(texts.get("Plan.md") ?? "") : snapshot.plan;
  const shopping = changedTextPaths.has("Shopping.md") ? shoppingList(texts.get("Shopping.md") ?? "") : snapshot.shopping;
  const files = filesChanged
    ? [...filesByPath.values()].sort((left, right) => left.path.localeCompare(right.path))
    : snapshot.files;
  const imageUrls = imagesChanged ? new Map(urls) : snapshot.imageUrls;
  if (
    recipes === snapshot.recipes && plan === snapshot.plan && shopping === snapshot.shopping
    && files === snapshot.files && texts === snapshot.texts && imageUrls === snapshot.imageUrls
  ) return;

  const catalogChanged = recipes !== snapshot.recipes || plan !== snapshot.plan;
  snapshot = {
    recipes, plan, shopping, files, texts, imageUrls,
    revision: snapshot.revision + 1,
    catalogRevision: snapshot.catalogRevision + (catalogChanged ? 1 : 0),
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
  bootstrap();
}
onCurrentKitchenConnection(bind);
bind();
export const getKitchenSnapshot = (): KitchenSnapshot => snapshot;
export function subscribeKitchen(listener: () => void): () => void {
  listeners.add(listener); return () => listeners.delete(listener);
}
export function useKitchenSlice<K extends keyof KitchenSnapshot>(key: K): KitchenSnapshot[K] {
  return useSyncExternalStore(subscribeKitchen, () => snapshot[key], () => snapshot[key]);
}
export function useKitchenText(path: string | null): string | null {
  return useSyncExternalStore(
    subscribeKitchen,
    () => path === null ? null : snapshot.texts.get(path) ?? null,
    () => path === null ? null : snapshot.texts.get(path) ?? null,
  );
}
export const useKitchenStore = (): KitchenSnapshot => useSyncExternalStore(subscribeKitchen, getKitchenSnapshot, getKitchenSnapshot);
