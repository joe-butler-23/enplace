---
name: recipe-extraction
description: Extract and import a new recipe from a URL, pasted recipe text, or an attached recipe image. Uses the active agent for extraction and writes only through `mep recipe import`. Do not use for QA of an existing recipe, shopping-list work, or importer implementation and release QA.
category: command
---

# Recipe Extraction

Create one canonical recipe from user-supplied source material without calling an in-product model provider or writing recipe files directly.

## Inputs

- For a URL, use the active agent's browsing tools to read the source page.
- For pasted text, extract only what the text supports.
- For an image, inspect the attached image directly and transcribe only visible recipe content.
- Every input needs an honest HTTP(S) provenance URL. Use the supplied page URL when available; for pasted text or an image without provenance, ask for it. Never invent a source URL.

## Requirements

1. The agent must resolve the target recipes directory from the user's selected vault or explicit instruction and must not assume Joe's paths.
2. The agent must extract a title, ingredients, and numbered method. It must preserve quantities and wording where the source is clear and ask about material gaps instead of guessing.
3. The agent must produce Markdown with closed frontmatter containing matching `title`, `type: recipe`, and `source`; a matching `#` title; strict `quantity | ingredient | label` ingredient bullets; and at least one numbered method step. It must use only labels allowed by the active cooking configuration.
4. Before the write, the agent must state the source and target recipes directory.
5. The agent must send the Markdown over stdin to the sole write gate:

   ```bash
   mep recipe import - --recipes-dir <recipes-directory>
   ```

6. The agent must treat the command's JSON as authoritative. On success, it must report the title and paths. On failure, it must report the stable error code; corrected Markdown must go through the same gate again.

## Locating the mep binary

Resolve the `mep` binary deterministically before importing; never assume a
global install or any author-specific path:

1. If `<repository-root>/target/release/mep` exists, use that path.
2. Otherwise, if `mep` resolves on `PATH`, use it.
3. Otherwise build it from the repository clone (`cargo build --release -p mep-cli`)
   and use `<repository-root>/target/release/mep`.

## Constraints

- Never create, edit, move, or copy a recipe Markdown or `.machine` sidecar directly.
- Never call an external model API from MEP; extraction is performed by the active agent.
- Use only the current `mep recipe import` command.
- Do not include a `cover` for an attached source image. A cover is valid only when the user identifies an existing safe path under the target recipes directory; the import gate decides whether it is acceptable.
- Do not change shopping state.
- For read-only comparison of an existing recipe with its source, use `mep-ai-led-qa` instead.

## Acceptance Checks

- `clai validate skill recipe-extraction --scope project --project-root .` reports no errors.
- A URL request, pasted-text request with provenance, and image request with provenance each produce valid Markdown and succeed only through `mep recipe import` into an isolated recipes directory.
- Invalid extracted Markdown returns structured JSON failure and leaves the isolated recipes directory absent or byte-for-byte unchanged.

## Regression Checks

- Confirm the generated `mep recipe --help` exposes `import` and no model-backed importer.
- Run `npm run lint:provider-residue`; expect exit zero and no forbidden product-provider residue.
