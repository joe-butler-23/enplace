import * as React from "react";
import type { RecipeIndexItem } from "../../modules/cooking/types";
import { responsiveSampleCover } from "./responsive-sample-cover";

// Card covers stop at 2x density: 672 px serves a 323 px phone card at 2.1x, and a 3x
// photograph is not distinguishable from a 2x one at that pixel pitch (decision 2026-09-03).
// The 1288 px files stay for the recipe hero, which renders the full viewport width.
const SAMPLE_COVER_WIDTHS = [224, 672] as const;
const CARD_COVER_SIZES = [
  "(max-width: 516px) calc(100vw - 67px)",
  "(max-width: 720px) calc((100vw - 81px) / 2)",
  "(max-width: 796px) calc((100vw - 129px) / 2)",
  "(max-width: 1028px) calc((100vw - 143px) / 3)",
  "(max-width: 1260px) calc((100vw - 157px) / 4)",
  "(max-width: 1492px) calc((100vw - 171px) / 5)",
  "calc((100vw - 185px) / 6)",
].join(", ");

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

  const responsiveCover = coverPath ? responsiveSampleCover(coverPath, SAMPLE_COVER_WIDTHS) : null;
  const coverImage = coverPath ? (
    <img
      src={coverPath}
      alt=""
      decoding="async"
      srcSet={responsiveCover?.webpSrcSet}
      sizes={responsiveCover ? CARD_COVER_SIZES : undefined}
      data-path={recipe.path}
    />
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
          {responsiveCover ? (
            <picture style={{ display: "contents" }}>
              <source type="image/avif" srcSet={responsiveCover.avifSrcSet} sizes={CARD_COVER_SIZES} />
              {coverImage}
            </picture>
          ) : coverImage}
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
