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
  sortBy?: RecipeIndexSort;
  filter?: RecipeIndexFilter;
  search?: string;
  recipesFolder?: string;
  limit?: number;
};

export type RecipeIndexItem = {
  path: string;
  title: string;
  coverPath: string | null;
  marked: boolean;
  added: string | null;
  scheduled: string | null;
  addedTimestamp: number | null;
  scheduledTimestamp: number | null;
  tags: string[];
};

export type CachedRecipe = RecipeIndexItem & {
  fingerprint: string;
  titleLower: string;
  tagsLower: string[];
};
