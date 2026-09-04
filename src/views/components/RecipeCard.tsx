import * as React from "react";
import type { RecipeIndexItem } from "../../modules/cooking/types";

type RecipeCardProps = {
  recipe: RecipeIndexItem;
  coverPath: string | null;
  onOpenRecipe: (path: string, split: boolean) => void;
  onToggleMarked: (path: string, marked: boolean) => Promise<void>;
  onPointerDownRecipe?: (path: string, coverUrl?: string) => void;
};

const RecipeCard: React.FC<RecipeCardProps> = React.memo(({ recipe, coverPath, onOpenRecipe, onPointerDownRecipe, onToggleMarked }) => {
  const [toggleDisabled, setToggleDisabled] = React.useState(false);
  const [optimisticMarked, setOptimisticMarked] = React.useState(recipe.marked);

  React.useEffect(() => {
    setOptimisticMarked(recipe.marked);
  }, [recipe.marked]);

  const handleToggle = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.checked;
    setOptimisticMarked(newValue);
    setToggleDisabled(true);
    try {
      await onToggleMarked(recipe.path, newValue);
    } catch (err) {
      setOptimisticMarked(!newValue);
      console.error("Failed to toggle marked", err);
    } finally {
      setToggleDisabled(false);
    }
  };

  const coverImage = coverPath ? (
    <img src={coverPath} alt="" decoding="sync" data-path={recipe.path} />
  ) : null;

  return (
    <article
      className="cooking-db__card"
      data-path={recipe.path}
      data-has-cover={coverPath ? "true" : "false"}
    >
      <button
        type="button"
        className="cooking-db__card-open"
        aria-label={`Open recipe ${recipe.title}`}
        onPointerDown={() => onPointerDownRecipe?.(recipe.path, coverPath ?? undefined)}
        onClick={(e) => onOpenRecipe(recipe.path, e.ctrlKey || e.metaKey)}
      >
        <div className={`cooking-db__cover ${coverPath ? "" : "cooking-db__cover--empty"}`}>
          {coverImage}
        </div>
        <div className="cooking-db__body">
          <div
            className="cooking-db__title"
          >
            {recipe.title}
          </div>
          <div className="cooking-db__meta">
            {recipe.added ? `Added ${recipe.added}` : ""}
          </div>
        </div>
      </button>
      <div className="cooking-db__actions">
        <label className="cooking-db__toggle">
          <input
            type="checkbox"
            checked={optimisticMarked}
            onChange={handleToggle}
            disabled={toggleDisabled}
          />
          <span>Marked</span>
        </label>
      </div>
    </article>
  );
}, areRecipeCardsEqual);

function areRecipeCardsEqual(prev: RecipeCardProps, next: RecipeCardProps): boolean {
  return (
    prev.recipe.path === next.recipe.path &&
    prev.recipe.title === next.recipe.title &&
    prev.recipe.added === next.recipe.added &&
    prev.recipe.marked === next.recipe.marked &&
    prev.coverPath === next.coverPath &&
    prev.onOpenRecipe === next.onOpenRecipe &&
    prev.onPointerDownRecipe === next.onPointerDownRecipe &&
    prev.onToggleMarked === next.onToggleMarked
  );
}
export { RecipeCard };
