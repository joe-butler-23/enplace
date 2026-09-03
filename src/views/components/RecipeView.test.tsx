import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RecipeEditor } from "./RecipeEditor";
import { ReadDocument } from "./RecipeMarkdown";
import { PreparedRecipeDocument, RecipeView, StepText, parsedListsMatch, prepareRecipeMarkdown } from "./RecipeView";

describe("recipe read/edit boundary", () => {
  it("hands complex GFM markdown through the maintained renderer with the shared image resource getter", () => {
    const markdown = [
      "## Ingredients",
      "",
      "- [x] beans",
      "- [ ] rice",
      "",
      "| serving | time |",
      "| --- | --- |",
      "| 2 | 30m |",
      "",
      "![Soup](images/soup.png \"hero\")"
    ].join("\n");
    const resolveImage = vi.fn(() => "blob:soup");
    const document = ReadDocument({ markdown, path: "recipes/soup.md", resolveImage });
    const markdownElement = (document.props.children as React.ReactElement);
    expect(markdownElement.props.children).toBe(markdown);
    expect(markdownElement.props.remarkPlugins).toHaveLength(1);
    const image = markdownElement.props.components.img({ src: "images/soup.png", alt: "Soup", title: "hero" });
    expect((image as React.ReactElement).props.src).toBe("images/soup.png");
    expect((image as React.ReactElement).props.resolveImage("images/soup.png", "recipes/soup.md")).toBe("blob:soup");
  });

  it("renders a cached detail image immediately without an alt-text banner", () => {
    const markup = renderToStaticMarkup(
      <ReadDocument
        markdown="![Recipe image](images/soup.png)"
        path="recipes/soup.md"
        resolveImage={() => "blob:soup"}
      />
    );

    expect(markup).toContain('src="blob:soup"');
    expect(markup).not.toContain("<figcaption");
  });

  it("renders a full recipe title once", () => {
    const markup = renderToStaticMarkup(
      <RecipeView
        path="recipes/soup.md"
        title="Fallback Soup"
        mode="full"
        content={[
          "---",
          "title: Soup",
          "---",
          "",
          "# Soup",
          "",
          "## Method",
          "",
          "Simmer."
        ].join("\n")}
      />
    );

    expect((markup.match(/<h1/g) ?? [])).toHaveLength(1);
    expect(markup).toContain("<h1>Soup</h1>");
  });

  it("keeps the sole full-view Edit action on the masthead meta line", () => {
    const markup = renderToStaticMarkup(
      <RecipeView path="recipes/soup.md" title="Soup" mode="full" content="# Soup\n\nMethod" />
    );

    expect((markup.match(/>Edit<\/button>/g) ?? [])).toHaveLength(1);
    expect(markup).toContain('class="recipe-view__meta"');
    expect(markup).toContain('class="recipe-view__edit-action"');
    expect(markup).not.toContain("recipe-view__toolbar");
  });

  it("retains the preview action without a renderer placeholder", () => {
    const markup = renderToStaticMarkup(
      <RecipeView
        path="recipes/soup.md"
        title="Soup"
        mode="rendered"
        content={[
          "---",
          "title: Preview Soup",
          "---",
          "",
          "# Preview Soup",
          "",
          "## Method"
        ].join("\n")}
      />
    );

    expect(markup).not.toContain("aria-busy");
    expect((markup.match(/>Edit<\/button>/g) ?? [])).toHaveLength(1);
  });

  it("owns ingredients and steps in the columns and leaves the rest of the body below", () => {
    const markup = renderToStaticMarkup(
      <RecipeView
        path="recipes/soup.md"
        title="Soup"
        mode="full"
        content={[
          "---",
          "title: Soup",
          "source: https://example.test/soup",
          "---",
          "",
          "# Soup",
          "",
          "## Ingredients",
          "- water",
          "- salt",
          "",
          "## Method",
          "1. Bring it to the boil.",
          "2. Season generously.",
          "",
          "## Notes",
          "Better on day two."
        ].join("\n")}
      />
    );

    expect(markup).toContain("Bring it to the boil.");
    expect(markup).toContain("Season generously.");
    // Only ingredients carry a checkbox; a step's number is its own toggle, so the row
    // is one control instead of a checkbox sitting next to a decorative number.
    expect((markup.match(/type="checkbox"/g) ?? [])).toHaveLength(2);
    expect((markup.match(/aria-pressed="false"/g) ?? [])).toHaveLength(2);
    // The step count is not restated in the masthead: the list is numbered on screen.
    expect(markup).not.toContain("2 steps");
    // The columns own both structured sections, so "water" appears once, not once per surface.
    expect((markup.match(/water/g) ?? [])).toHaveLength(1);
    // A recipe carrying other sections keeps a region for them below the columns.
    expect(markup).toContain("recipe-view__notes");
  });

  it("promotes a standalone body image to the masthead instead of repeating it below", () => {
    const markup = renderToStaticMarkup(
      <RecipeView
        path="recipes/soup.md"
        title="Soup"
        mode="full"
        content={"# Soup\n\n![Bowl](images/soup.png)\n\nServe hot."}
        resolveImage={() => "blob:soup"}
      />
    );

    expect((markup.match(/src="blob:soup"/g) ?? [])).toHaveLength(1);
    expect(markup).toContain('<div class="recipe-view__hero">');
    expect(markup).toMatch(/elementtiming="mep:recipe-hero:\d+:recipes\/soup\.md"/);
  });

  it("drops the masthead image column when a recipe has no image", () => {
    const markup = renderToStaticMarkup(
      <RecipeView path="recipes/soup.md" title="Soup" mode="full" content={"# Soup\n\nServe hot."} />
    );

    expect(markup).toContain("recipe-view__masthead--textonly");
    expect(markup).not.toContain("recipe-view__hero");
  });

  it("passes editor changes back as raw local image targets", () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    const editor = RecipeEditor({
      path: "recipes/soup.md",
      markdown: "![Soup](images/soup.png)",
      onChange,
      onClose
    });
    const [actions, mdxEditor] = editor.props.children as React.ReactElement[];
    expect(mdxEditor.type).toBeDefined();
    expect(mdxEditor.props.className).toBe("recipe-view__mdx-editor");
    expect(mdxEditor.props.markdown).toBe("![Soup](images/soup.png)");
    expect(mdxEditor.props.plugins).toHaveLength(9);

    const doneButton = actions.props.children as React.ReactElement;
    doneButton.props.onClick();
    expect(onClose).toHaveBeenCalledOnce();

    mdxEditor.props.onChange("![Soup](images/soup.png)");
    expect(onChange).toHaveBeenCalledWith("![Soup](images/soup.png)");
  });

  it("renders inline markdown within a method step instead of literal syntax (defect 1)", async () => {
    await prepareRecipeMarkdown();
    const markup = renderToStaticMarkup(
      <RecipeView
        path="recipes/soup.md"
        title="Soup"
        mode="full"
        content={[
          "# Soup",
          "",
          "## Method",
          "1. Heat the **oil** until it [shimmers](https://x.test)."
        ].join("\n")}
      />
    );

    expect(markup).toContain("<strong>oil</strong>");
    expect(markup).toContain('<a href="https://x.test">shimmers</a>');
    expect(markup).not.toContain("**oil**");
    expect(markup).not.toContain("[shimmers]");
    // Constraint (d): a step is a list row — the inline renderer must not wrap it in a <p>.
    expect(markup).not.toContain("<p>");
  });

  it("memoises each step's markdown so an unrelated toggle does not reparse every step (defect 1b)", () => {
    // renderToStaticMarkup is a single-shot render with no DOM and no event dispatch, so it
    // cannot itself drive a checkbox toggle and count reparses. What IS directly verifiable
    // without a renderer is the actual fix the constraint calls for: StepText is wrapped in
    // React.memo (props-equal renders bail before react-markdown ever runs). This fails before
    // the fix (StepText did not exist) and passes after.
    expect(StepText.$$typeof).toBe(Symbol.for("react.memo"));
  });

  it("preserves checked ticks when a content update leaves the ingredient/step lists unchanged (defect 2)", () => {
    // The reset effect only runs on commit (useEffect), which renderToStaticMarkup never
    // performs — there is no DOM here to mount into and no way to dispatch a click or observe
    // a second render. So the interactive "tick five, edit a typo, autosave, ticks survive"
    // scenario genuinely cannot be exercised in this node-only test environment. What can be
    // pinned directly is the pure decision logic RecipeView now uses to decide whether a
    // content change is list-preserving, which is the actual fix for the bug.
    expect(parsedListsMatch(["water", "salt"], ["water", "salt"])).toBe(true);
    expect(parsedListsMatch(["water", "salt"], ["water", "salt", "pepper"])).toBe(false);
    expect(parsedListsMatch(["water", "salt"], ["salt", "water"])).toBe(false);
    expect(parsedListsMatch([], [])).toBe(true);
  });

  it("memoises the notes renderer so a checkbox toggle does not reparse the notes body (defect 3)", () => {
    // Same renderer-less limitation as defect 2: no DOM means no way to toggle a checkbox and
    // observe whether react-markdown ran again. The mechanism that prevents it is verifiable
    // directly: PreparedRecipeDocument is wrapped in React.memo, so a re-render with the same
    // markdown/path/image-resource props bails before ReadDocument (and react-markdown) runs.
    // Fails before the fix (the component was a plain, unmemoised function).
    expect(PreparedRecipeDocument.$$typeof).toBe(Symbol.for("react.memo"));
  });

  it("uses the renamed method column class instead of the stale method-pane name (defect 4)", () => {
    const markup = renderToStaticMarkup(
      <RecipeView
        path="recipes/soup.md"
        title="Soup"
        mode="full"
        content={["## Method", "1. Simmer."].join("\n")}
      />
    );

    expect(markup).toMatch(/class="recipe-view__panel recipe-view__method"/);
    expect(markup).not.toContain("recipe-view__method-pane");
  });

  it("keeps one Reset, unambiguously named and always mounted (defect 5)", () => {
    const markup = renderToStaticMarkup(
      <RecipeView
        path="recipes/soup.md"
        title="Soup"
        mode="full"
        content={["## Ingredients", "- water", "", "## Method", "1. Simmer."].join("\n")}
      />
    );

    // Two buttons both named "Reset" were ambiguous in a screen-reader button list. One
    // button clearing both columns is the simpler fix than two disambiguating aria-labels.
    expect((markup.match(/>Reset</g) ?? [])).toHaveLength(1);
    expect(markup).not.toContain('aria-label="Reset');
    // It renders on a fresh recipe with nothing ticked, and so never unmounts on the click
    // that empties the lists — the conditional render is what dropped focus to <body>.
    expect(markup).toContain("recipe-view__reset");
  });
});
