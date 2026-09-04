export type RecipeIndexSort =
  | "title-asc"
  | "title-desc"
  | "added-asc"
  | "added-desc"
  | "scheduled-asc"
  | "scheduled-desc";

export type RecipeIndexFilter = {
  marked?: boolean;
  scheduled?: boolean;
  tags?: string[];
  addedAfter?: number;
};

export type RecipeIndexQuery = {
  sort?: RecipeIndexSort;
  filter?: RecipeIndexFilter;
  search?: string;
  limit?: number;
};

export type RecipeIndexItem = {
  path: string;
  title: string;
  coverPath: string | null;
  marked: boolean;
  added: string | null;
  scheduled: string | null;
  scheduledDates?: string[];
  addedTimestamp: number | null;
  scheduledTimestamp: number | null;
  tags: string[];
};

export type CachedRecipe = RecipeIndexItem & {
  fingerprint: string;
  titleLower: string;
  tagsLower: string[];
};
