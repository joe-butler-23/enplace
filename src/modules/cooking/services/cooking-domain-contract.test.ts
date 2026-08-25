import { describe, expect, it } from "vitest";
import golden from "../../../../fixtures/cooking-domain/golden.json";
import sidecar from "../../../../fixtures/cooking-domain/sidecar.json";
import hostInvokeResolution from "../../../../fixtures/cooking-domain/host-invoke-resolution.json";
import {
  formatMetricQuantity,
  parseIngredientLine,
  parseMachineRecipeIngredients
} from "./ingredient-parsing";
import { buildShoppingItems } from "./shopping-aggregation";

describe("cooking-domain contract fixtures", () => {
  it("keeps the three-pipe representation and TypeScript quantity conversion explicit", () => {
    const flour = parseIngredientLine(golden.recipes[0].ingredients[0]);
    expect(flour).toEqual({
      displayName: "plain flour",
      quantity: 1000,
      unit: "g",
      countUnit: null
    });

    const oil = parseIngredientLine(golden.recipes[0].ingredients[1]);
    expect(oil).toEqual({
      displayName: "extra virgin olive oil",
      quantity: 15,
      unit: "ml",
      countUnit: null
    });
    expect(formatMetricQuantity(1500, "g")).toBe("1.5kg");
  });

  it("locks TypeScript ignore, label, merge, and source-order behavior", () => {
    const items = buildShoppingItems(
      golden.recipes.map((recipe) => ({
        path: recipe.path,
        title: recipe.title,
        ingredients: recipe.ingredients
      }))
    );

    expect(items).toEqual(golden.typescript.shoppingItems);
    expect(items.some((item) => item.content.includes("salt"))).toBe(false);
    expect(items.some((item) => item.content.includes("water"))).toBe(false);
  });

  it("locks the markdown sidecar snake_case schema", () => {
    const raw = JSON.stringify(sidecar);
    expect(parseMachineRecipeIngredients(raw)).toEqual([
      "1kg | plain flour | bakery"
    ]);

    const ingredient = sidecar.recipe.ingredients[0];
    expect(Object.keys(ingredient)).toEqual([
      "text",
      "normalized_text",
      "resolved_ingredient_id",
      "resolved_display_name",
      "resolution_status",
      "confidence",
      "review_required",
      "resolution_reason"
    ]);
    expect("resolvedDisplayName" in ingredient).toBe(false);
  });

  it("locks the host command payload camelCase boundary", () => {
    expect(Object.keys(hostInvokeResolution)).toEqual([
      "raw",
      "normalized",
      "resolvedIngredientId",
      "resolvedDisplayName",
      "resolutionStatus",
      "confidence",
      "resolutionPath",
      "resolutionReason",
      "reviewRequired"
    ]);
    expect("resolved_ingredient_id" in hostInvokeResolution).toBe(false);
    expect(hostInvokeResolution.resolutionStatus).toBe("resolved");
  });
});
