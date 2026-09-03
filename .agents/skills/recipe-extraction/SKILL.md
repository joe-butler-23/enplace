---
name: recipe-extraction
description: Extract one recipe from a URL, supplied text, or an image into plain Enplace Markdown, then validate and add it with mep. Do not use for reviewing an existing recipe.
---

# Recipe Extraction

Create one faithful recipe in the user's selected Enplace folder.

1. Read the supplied URL, text, or image. Treat it as the only factual source.
2. Draft plain Markdown with a title and an exact `## Ingredients` heading. Use `- ` ingredient lines. Add numbered steps under `## Method` when the source gives a method.
3. Preserve quantities, units, ordering, and useful preparation notes. Do not invent missing ingredients, steps, times, yields, tags, covers, or provenance.
4. Add YAML frontmatter only for useful known values. Record `source` only when the user supplied or the agent actually read that URL. Never guess a source URL.
5. Pass the identical draft on stdin to both commands, in order:

```bash
mep check - --folder <folder>
mep add - --folder <folder>
```

Stop if `mep check` fails. Stop if `mep add` reports an existing file; never overwrite it. Report the path printed by `mep add`.

Use this shape:

```markdown
---
title: Recipe title
source: https://actual.example/source
---

# Recipe title

## Ingredients

- 2 tbsp olive oil

## Method

1. Follow the source instruction.
```

Omit `source` and `## Method` when the source does not provide them.
