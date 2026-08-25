# mep CLI Contracts

This document defines the active `mep` contract surface.

The cross-surface cooking-domain lock (including known TypeScript/Rust
differences) is documented in
[`docs/cooking-domain-contract.md`](cooking-domain-contract.md), with golden
fixtures under [`fixtures/cooking-domain`](../fixtures/cooking-domain).

## Design Contract

- The active agent extracts recipe meaning from a URL, pasted text, or image.
- `.agents/skills/recipe-extraction/SKILL.md` owns that workflow.
- `mep recipe import` is the only recipe write gate.
- The CLI performs deterministic validation and artifact rendering without a
  model, provider, or network call.
- Invalid input fails closed without writing recipe artifacts.

## Config Contract

Config file:

- `$MEP_CONFIG_DIR/cooking.toml`

If missing, defaults apply.

Fields:

- `default_label: string`
- `labels: string[]`
- `ignore: string[]`
- `[merge]` alias map (`from` -> `to`)

## Recipe Markdown Contract

Imported recipes are written to `recipes/{slug}.md` with frontmatter + body.

Body contract:

```markdown
# {recipe title}

## Ingredients
- {quantity} | {ingredient} | {label}

## Method
1. {step}
```

Ingredient line rules:

- exactly 3 pipe-separated segments
- quantity may be blank
- ingredient must be lowercase and length >= 2
- label must be in configured `labels`
- `|` inside segment values is invalid

## `mep recipe import`

Usage:

```bash
mep recipe import <markdown-file|-> --recipes-dir <dir>
```

This is the stable agent-facing write boundary. It accepts already-extracted
Markdown from an explicit file, or from stdin when the input is `-`. Input
must contain matching frontmatter and body titles, `type: recipe`, an
HTTP(S) `source`, strict pipe ingredients, and at least one numbered method
step. A `cover`, when present, must be a safe existing path below the recipes
directory and any Markdown image must reference that same file.

The command makes no model, provider, or network call. It validates and renders
both canonical recipe artifacts before writing `recipes/{slug}.md` and
`recipes/.machine/{slug}.json`. Success is JSON on stdout. Failure is JSON on
stderr with a stable `error.code`, exits non-zero, and performs no recipe write.

## QA Contract

Quality validation is agent-led, not a scripted adjudicator pipeline.

- `.agents/skills/recipe-extraction/SKILL.md` owns new recipe extraction and may
  write only through `mep recipe import`.
- `.agents/skills/mep-ai-led-qa/SKILL.md` is the sole authority for read-only QA
  of existing recipe markdown.
