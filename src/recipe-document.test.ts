import { describe, expect, it } from "vitest";
import { parseRecipeDocument, renderImportedRecipe } from "./core";
import { withRecipeAdded } from "./recipe-document";
import {
  composeMarkdown,
  extractHeroImage,
} from "./views/utils/recipe-frontmatter";

const parse = (markdown: string, recipePath = "recipe.md") =>
  parseRecipeDocument(recipePath, markdown);

describe("recipe parser compatibility", () => {
  it("keeps core and view frontmatter projections and LF/CRLF editor framing", () => {
    const lf = [
      "---",
      String.raw`title: "Hot\nPot"`,
      "source: 'Family notebook'",
      "cover: 'images/pot.jpg'",
      "added: 2026-08-30",
      'tags: ["quick", batch]',
      "aliases:",
      "  - 'weeknight'",
      "---",
      "",
      "# Body title",
      "",
      "## Ingredients",
      "- onion",
      "",
      "#body-tag",
      "",
    ].join("\n");
    const parsed = parse(lf, "recipes/pot.md");

    expect(parsed.markdown).toBe(lf);
    expect(parsed.recipe).toEqual({
      title: "Hot\nPot",
      ingredients: ["onion"],
      cover: "images/pot.jpg",
      added: "2026-08-30",
      tags: ["batch", "body-tag", "quick"],
    });
    expect(parsed.frontmatter).toEqual({
      title: String.raw`"Hot\nPot"`,
      source: "'Family notebook'",
      cover: "'images/pot.jpg'",
      added: "2026-08-30",
      tags: '["quick", batch]',
      aliases: ["'weeknight'"],
    });
    expect(parsed.rawFrontmatter).toBe(lf.split("\n").slice(1, 8).join("\n"));
    expect(parsed.body).toBe("\n# Body title\n\n## Ingredients\n- onion\n\n#body-tag\n");
    expect(parsed.view).toMatchObject({
      title: String.raw`Hot\nPot`,
      ingredients: ["onion", "#body-tag"],
      directions: [],
      declaredCover: "images/pot.jpg",
      source: "Family notebook",
      tags: ["quick", "batch"],
    });
    expect(extractHeroImage(parsed).hero).toEqual({ src: "images/pot.jpg", alt: "" });
    expect(composeMarkdown(parsed.rawFrontmatter, parsed.body)).toBe(lf.trimEnd());

    const crlf = lf.replace(/\n/g, "\r\n");
    const crlfParsed = parse(crlf, "recipes/pot.md");
    const crlfRaw = [
      String.raw`title: "Hot\nPot"`,
      "source: 'Family notebook'",
      "cover: 'images/pot.jpg'",
      "added: 2026-08-30",
      'tags: ["quick", batch]',
      "aliases:",
      "  - 'weeknight'",
    ].join("\r\n");
    const crlfBody = "\r\n# Body title\r\n\r\n## Ingredients\r\n- onion\r\n\r\n#body-tag\r\n";
    expect(crlfParsed.markdown).toBe(crlf);
    expect(crlfParsed.rawFrontmatter).toBe(crlfRaw);
    expect(crlfParsed.body).toBe(crlfBody);
    expect(crlfParsed.recipe).toEqual(parsed.recipe);
    expect(crlfParsed.frontmatter).toEqual(parsed.frontmatter);
    expect(composeMarkdown(crlfParsed.rawFrontmatter, crlfParsed.body)).toBe(
      `---\n${crlfRaw}\n---\n\n${crlfBody.trim()}`,
    );
  });

  const sectionCases = [
    {
      name: "permissive view headings",
      markdown: [
        "# Supper",
        "## Ingredients deluxe",
        "1. numbered ingredient",
        "plain ingredient",
        "+ plus ingredient",
        "## Directions quickly",
        "1. First step",
        "wrapped continuation",
        "2) Parenthesized continuation",
        "- Bullet step",
        "### Phase two",
        "more continuation",
        "## Notes",
        "ignored",
      ].join("\n"),
      core: null,
      viewIngredients: ["numbered ingredient", "plain ingredient", "plus ingredient"],
      directions: [
        "First step wrapped continuation 2) Parenthesized continuation",
        "Bullet step more continuation",
      ],
    },
    {
      name: "exact Directions heading",
      markdown: [
        "## Directions",
        "1. Step one",
        "2. Step two",
        "## Notes",
        "ignored",
      ].join("\n"),
      core: null,
      viewIngredients: [],
      directions: ["Step one", "Step two"],
    },
    {
      name: "exact core heading and bullet forms",
      markdown: [
        "## Ingredients",
        "- dash",
        "* star",
        "+ plus",
        "### garnish",
        "1. numbered",
        "continued prose",
        "## Method",
        "1. Dot step",
        "2) Parenthesis is continuation",
        "- Bullet step",
      ].join("\n"),
      core: ["dash", "star", "plus"],
      viewIngredients: ["dash", "star", "plus", "### garnish", "numbered", "continued prose"],
      directions: ["Dot step 2) Parenthesis is continuation", "Bullet step"],
    },
    {
      name: "fenced fake sections",
      markdown: [
        "```markdown",
        "## Ingredients",
        "- code ingredient",
        "```",
        "## Notes",
        "~~~",
        "## Method",
        "1. code step",
        "~~~",
      ].join("\n"),
      core: null,
      viewIngredients: ["code ingredient", "```"],
      directions: ["code step ~~~"],
    },
  ];

  it.each(sectionCases)("keeps $name policy", ({ markdown, core, viewIngredients, directions }) => {
    const parsed = parse(markdown);
    expect(parsed.recipe.ingredients).toEqual(core);
    expect(parsed.view.ingredients).toEqual(viewIngredients);
    expect(parsed.view.directions).toEqual(directions);
  });

  it("keeps distinct core cover and view hero candidates", () => {
    const cases = [
      ["image fallback", "---\nimage: view.jpg\n---\n## Ingredients\n- x", null, { src: "view.jpg", alt: "" }],
      ["inline image", "## Ingredients\n- x\n\nServe ![Dish](inline.jpg) now.", "inline.jpg", null],
      ["leading image", "![Dish](leading.jpg)\n\n## Ingredients\n- x", "leading.jpg", { src: "leading.jpg", alt: "Dish" }],
      ["late image", "## Ingredients\n- x\n\n![Dish](late.jpg)", "late.jpg", null],
      ["fenced image", "## Ingredients\n- x\n```\n![Dish](code.jpg)\n```", "code.jpg", null],
      ["wiki image", "## Ingredients\n- x\n![[wiki.jpg|Dish]]", "wiki.jpg", null],
    ] as const;

    for (const [name, markdown, coreCover, viewHero] of cases) {
      const parsed = parse(markdown);
      expect({ coreCover: parsed.recipe.cover, viewHero: extractHeroImage(parsed).hero }, name)
        .toEqual({ coreCover, viewHero });
    }
  });

  it("keeps core and view tag-list differences", () => {
    const cases = [
      {
        markdown: "---\ntags:\n  - 'quoted'\n  - plain\n---\n## Ingredients\n- salt\n\n#body-tag",
        core: ["body-tag", "plain", "quoted"],
        view: ["'quoted'", "plain"],
      },
      {
        markdown: "---\ntags: alpha, beta\n---\n## Ingredients\n- salt",
        core: ["alpha", "beta"],
        view: ["alpha", "beta"],
      },
      {
        markdown: "---\ntags:\n- one\n---\n## Ingredients\n- salt",
        core: ["one"],
        view: [],
      },
    ];

    for (const { markdown, core, view } of cases) {
      const parsed = parse(markdown);
      expect([parsed.recipe.tags, parsed.view.tags]).toEqual([core, view]);
    }
    const zeroIndented = parse(cases[2].markdown);
    expect(zeroIndented.frontmatter.tags).toBe("");
    expect(zeroIndented.rawFrontmatter).toBe("tags:\n- one");
  });

  it("reparses imported Markdown without losing method or provenance", () => {
    const parsed = parse(renderImportedRecipe({
      title: "Imported Soup",
      ingredients: ["one onion"],
      method: ["1. Stir well"],
      source: "https://example.test/soup",
    }));

    expect(parsed.recipe).toMatchObject({ title: "Imported Soup", ingredients: ["one onion"] });
    expect(parsed.view).toMatchObject({
      title: "Imported Soup",
      ingredients: ["one onion"],
      directions: ["Stir well"],
      source: "https://example.test/soup",
    });
  });

  it("keeps EOF, malformed-closing, and unclosed frontmatter policies", () => {
    const eof = "---\ntitle: At EOF\ntags:\n  - one\n---";
    const eofParsed = parse(eof, "recipes/eof.md");
    expect(eofParsed.recipe.ingredients).toBeNull();
    expect(eofParsed.frontmatter).toEqual({ title: "At EOF", tags: ["one"] });
    expect(eofParsed.rawFrontmatter).toBe("title: At EOF\ntags:\n  - one");
    expect(eofParsed.body).toBe("");
    expect(eofParsed.view.title).toBe("At EOF");
    expect(composeMarkdown(eofParsed.rawFrontmatter, eofParsed.body)).toBe(`${eof}\n\n`);

    const malformedClosing = "---\ntitle: X\n---junk\n# Body\n## Ingredients\n- salt";
    const malformedParsed = parse(malformedClosing, "recipes/file-name.md");
    expect(malformedParsed.recipe).toMatchObject({ title: "Body", ingredients: ["salt"] });
    expect(malformedParsed.frontmatter).toEqual({ title: "X" });
    expect(malformedParsed.rawFrontmatter).toBe("title: X");
    expect(malformedParsed.body).toBe("junk\n# Body\n## Ingredients\n- salt");
    expect(malformedParsed.view.title).toBe("X");
    expect(composeMarkdown(malformedParsed.rawFrontmatter, malformedParsed.body)).toBe(
      "---\ntitle: X\n---\n\njunk\n# Body\n## Ingredients\n- salt",
    );

    const unclosed = "---\ntitle: Unclosed\n# Body title\n## Ingredients\n- salt";
    const unclosedParsed = parse(unclosed, "recipes/file-name.md");
    expect(unclosedParsed.recipe).toMatchObject({ title: "Body title", ingredients: ["salt"] });
    expect(unclosedParsed.frontmatter).toEqual({});
    expect(unclosedParsed.rawFrontmatter).toBeNull();
    expect(unclosedParsed.body).toBe(unclosed);
    expect(unclosedParsed.view.title).toBe("Body title");
    expect(composeMarkdown(unclosedParsed.rawFrontmatter, unclosedParsed.body)).toBe(unclosed);
  });
});


describe("recipe import added metadata", () => {
  const added = "2026-09-07T10:45:12.345Z";
  const recipeMD = "# Soup\n\nSource: https://example.test/soup\n\n![Soup](images/soup.webp)\n\n*quick, lunch*\n\n**2 servings**\n\n---\n\n- *1* cucumber\n\n---\n\n1. Blend.\n";
  const legacy = "# Soup\n\n## Ingredients\n- cucumber\n\n## Method\n1. Blend.\n";

  it.each(["2026-09-07", added, "2026-09-07T12:45:12.345+02:00", "unknown", ""])(
    "retains the complete explicit RecipeMD Added value %s and never overwrites it", (value) => {
      const markdown = recipeMD.replace("Source:", `Added: ${value}\n\nSource:`);
      expect(parse(markdown).recipe.added).toBe(value || null);
      expect(withRecipeAdded("soup.md", markdown, added)).toBe(markdown);
    },
  );

  it.each(["# Soup", "Soup\n====", "Cucumber\nsoup\n===="])(
    "adds metadata after the CommonMark title %s without rewriting the recipe", (title) => {
      const markdown = recipeMD.replace("# Soup", title);
      const next = withRecipeAdded("soup.md", markdown, added);
      expect(next.replace(`Added: ${added}\n\n`, "")).toBe(markdown);
      expect(parse(next).recipe).toEqual({ ...parse(markdown).recipe, added });
      expect(parse(next).recipeMD).toEqual({
        ...parse(markdown).recipeMD,
        description: `Added: ${added}\n\n${parse(markdown).recipeMD!.description}`,
      });
      expect(withRecipeAdded("soup.md", next, "2026-09-08T00:00:00Z")).toBe(next);
    },
  );

  it.each([recipeMD, recipeMD.replace("# Soup", "Soup\n===="), legacy,
    `---\nsource: https://example.test/soup\ncustom: 'keep exact'\n---\n\n${legacy}`])(
    "keeps CRLF source bytes and records a parseable timestamp", (source) => {
      const markdown = source.replace(/\n/g, "\r\n");
      const next = withRecipeAdded("soup.md", markdown, added);
      expect(parse(next).recipe.added).toBe(added);
      expect(next.replace(/\r\n/g, "")).not.toContain("\n");
      if (parse(markdown).recipeMD) expect(next.replace(`Added: ${added}\r\n\r\n`, "")).toBe(markdown);
      else if (markdown.startsWith("---")) expect(next.replace(`added: ${added}\r\n`, "")).toBe(markdown);
      else expect(next).toBe(`---\r\nadded: ${added}\r\n---\r\n${markdown}`);
    },
  );

  it("preserves mixed line endings around a RecipeMD title", () => {
    const markdown = recipeMD.replace("# Soup\n", "# Soup\r\n");
    const next = withRecipeAdded("soup.md", markdown, added);
    expect(next.replace(`Added: ${added}\r\n\r\n`, "")).toBe(markdown);
    expect(parse(next).recipe.added).toBe(added);
  });

  it("adds legacy metadata without changing any existing frontmatter or body bytes", () => {
    const markdown = `---\nsource: https://example.test/soup\ncustom: 'keep exact'\n---\n\n${legacy}`;
    const next = withRecipeAdded("soup.md", markdown, added);
    expect(next.replace(`added: ${added}\n`, "")).toBe(markdown);
    expect(parse(next).recipe).toEqual({ ...parse(markdown).recipe, added });
    expect(withRecipeAdded("soup.md", legacy, added)).toBe(`---\nadded: ${added}\n---\n${legacy}`);
  });

  it.each(["2026-09-07", added, "unknown", ""])("preserves explicit legacy added: %s", (value) => {
    const markdown = `---\nadded: ${value}\n---\n\n${legacy}`;
    expect(withRecipeAdded("soup.md", markdown, added)).toBe(markdown);
    expect(parse(markdown).recipe.added).toBe(value || null);
  });

  it.each([
    ["notes.md", "# Notes\n\nKeep this exact."],
    ["image.webp", recipeMD],
    ["Plan.md", legacy],
    ["Shopping.md", legacy],
    ["Aisles.md", legacy],
  ])("does not stamp non-recipe input %s", (path, markdown) => {
    expect(withRecipeAdded(path, markdown, added)).toBe(markdown);
  });
});
