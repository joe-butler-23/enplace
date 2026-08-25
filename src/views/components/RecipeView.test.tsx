import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RecipeEditor } from "./RecipeEditor";
import { ReadDocument, RecipeView } from "./RecipeView";

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
    const cachedResource = { url: "blob:soup", width: 1200, height: 800 };
    const getImageResource = vi.fn(() => cachedResource);
    const document = ReadDocument({ markdown, path: "recipes/soup.md", getImageResource });
    const markdownElement = (document.props.children as React.ReactElement);
    expect(markdownElement.props.children).toBe(markdown);
    expect(markdownElement.props.remarkPlugins).toHaveLength(1);
    const image = markdownElement.props.components.img({ src: "images/soup.png", alt: "Soup", title: "hero" });
    expect((image as React.ReactElement).props.src).toBe("images/soup.png");
    expect((image as React.ReactElement).props.getImageResource("images/soup.png", "recipes/soup.md")).toEqual(cachedResource);
  });

  it("renders a cached detail image immediately without an alt-text banner", () => {
    const markup = renderToStaticMarkup(
      <ReadDocument
        markdown="![Recipe image](images/soup.png)"
        path="recipes/soup.md"
        getImageResource={() => ({ url: "blob:soup", width: 1200, height: 800 })}
      />
    );

    expect(markup).toContain('src="blob:soup"');
    expect(markup).not.toContain("<figcaption");
  });

  it("renders a full recipe title once while preserving later markdown headings", () => {
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
    expect(markup).toContain("<h2>Method</h2>");
  });

  it("keeps the sole full-view Edit action in the method heading", () => {
    const markup = renderToStaticMarkup(
      <RecipeView path="recipes/soup.md" title="Soup" mode="full" content="# Soup\n\nMethod" />
    );

    expect((markup.match(/>Edit<\/button>/g) ?? [])).toHaveLength(1);
    expect(markup).toContain('class="recipe-view__method-heading"');
    expect(markup).toContain('class="recipe-view__edit-action"');
    expect(markup).not.toContain("recipe-view__toolbar");
  });

  it("retains the markdown title in a rendered preview", () => {
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

    expect(markup).toContain("<h1>Preview Soup</h1>");
    expect(markup).toContain("<h2>Method</h2>");
    expect((markup.match(/>Edit<\/button>/g) ?? [])).toHaveLength(1);
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
});
