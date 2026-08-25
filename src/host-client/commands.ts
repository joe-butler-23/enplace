import { invoke, Channel } from "./invoke";
import type {
  RecipeDatabaseItem,
  RecipeDatabaseQuery
} from "@/pttNode";

export type VaultWatchEvent = {
  kind: "create" | "modify" | "remove" | "rename";
  path: string;
  oldPath?: string | null;
  mtimeMs?: number | null;
  size?: number | null;
  contentHash?: string | null;
  content?: string | null;
  selfAuthored?: boolean;
  subscriptions: string[];
};

export type VaultWatchBatch = {
  generation: number;
  alive: boolean;
  events: VaultWatchEvent[];
};

export type VaultWatchStatus = {
  generation: number;
  alive: boolean;
  changed: boolean;
};

export type RecipeDatabaseStreamEvent =
  | { event: "started"; data: { total: number } }
  | { event: "batch"; data: { items: RecipeDatabaseItem[]; offset: number } }
  | {
      event: "done";
      data: { totalCount: number; markedCount: number; availableTags: string[] };
    };

export type CookingRecipeInput = {
  path: string;
  title: string;
  markdown: string;
  machineSidecarJson?: string | null;
};

export type CookingDesiredItem = {
  content: string;
  labels: string[];
  sources?: string[];
};

export type ShoppingListItem = CookingDesiredItem & {
  id: string;
  checked: boolean;
  /** Hand-added items survive an apply that rebuilds the week from recipes. */
  manual?: boolean;
};

export type ShoppingList = {
  schemaVersion: number;
  revision: number;
  weekLabel: string;
  items: ShoppingListItem[];
  rollback: { weekLabel: string; items: ShoppingListItem[] } | null;
};

export type ShoppingListPlan = {
  baseRevision: number;
  weekLabel: string;
  items: ShoppingListItem[];
  summary: {
    currentCount: number;
    desiredCount: number;
    unchangedCount: number;
    createCount: number;
    deleteCount: number;
    manualCount: number;
  };
};

export function createChannel<T>(): Channel<T> {
  return new Channel<T>();
}

export async function mepCookingBuildDesiredItems(args: {
  recipes: CookingRecipeInput[];
}): Promise<CookingDesiredItem[]> {
  return invoke<CookingDesiredItem[]>("mep_cooking_build_desired_items", args);
}

export async function mepShoppingList(): Promise<ShoppingList> {
  return invoke<ShoppingList>("mep_shopping_list");
}

export async function mepShoppingPreview(args: {
  weekLabel: string;
  desiredItems: CookingDesiredItem[];
}): Promise<ShoppingListPlan> {
  return invoke<ShoppingListPlan>("mep_shopping_preview", args);
}

export async function mepShoppingApply(args: {
  expectedRevision: number;
  weekLabel: string;
  desiredItems: CookingDesiredItem[];
}): Promise<ShoppingList> {
  return invoke<ShoppingList>("mep_shopping_apply", args);
}

export async function mepShoppingCheck(args: {
  expectedRevision: number;
  itemId: string;
  checked: boolean;
}): Promise<ShoppingList> {
  return invoke<ShoppingList>("mep_shopping_check", args);
}

export async function mepShoppingAdd(args: {
  expectedRevision: number;
  content: string;
  labels: string[];
}): Promise<ShoppingList> {
  return invoke<ShoppingList>("mep_shopping_add", args);
}

export async function mepShoppingRemove(args: {
  expectedRevision: number;
  itemId: string;
}): Promise<ShoppingList> {
  return invoke<ShoppingList>("mep_shopping_remove", args);
}

export async function mepShoppingRollback(args: {
  expectedRevision: number;
}): Promise<ShoppingList> {
  return invoke<ShoppingList>("mep_shopping_rollback", args);
}

export async function mepGetThumbnail(args: { path: string; size?: "card" | "detail" }): Promise<string> {
  return invoke<string>("mep_get_thumbnail", args);
}

export async function mepGetThumbnails(args: {
  paths: string[];
  size?: "card" | "detail";
}): Promise<Array<string | null>> {
  return invoke<Array<string | null>>("mep_get_thumbnails", args);
}

export async function mepPrepareDatabaseThumbnails(args: {
  paths: string[];
}): Promise<Array<string | null>> {
  return invoke<Array<string | null>>("mep_prepare_database_thumbnails", args);
}

export async function mepWatchVault(args: {
  vaultPath: string;
  generation?: number;
  onEvent: Channel<VaultWatchBatch>;
}): Promise<VaultWatchStatus> {
  return invoke<VaultWatchStatus>("mep_watch_vault", args);
}

export async function mepUnwatchVault(): Promise<void> {
  return invoke("mep_unwatch_vault");
}

export async function mepVaultChangesSince(args: {
  generation: number;
}): Promise<VaultWatchStatus> {
  return invoke<VaultWatchStatus>("mep_vault_changes_since", args);
}

export async function mepRecipeDatabaseStream(args: {
  vaultPath?: string;
  query?: RecipeDatabaseQuery;
  onEvent: Channel<RecipeDatabaseStreamEvent>;
}): Promise<void> {
  return invoke("mep_recipe_database_stream", args);
}
