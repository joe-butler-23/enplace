# UI Consistency Spec

Status: Active  
Last updated: 2026-02-11

## Goals

- Make planner and database surfaces feel like one coherent system.
- Eliminate control drift (size, spacing, typography, icon treatment, states).
- Preserve performance while improving perceived polish.

## Design Tokens

Use shared CSS variables in one source (root/theme block) and consume everywhere.

### Sizing

- `--ctl-height`: 32px (toolbar controls)
- `--ctl-radius`: 6px
- `--ctl-pad-x`: 12px
- `--ctl-gap`: 8px

### Typography

- `--ctl-font-size`: 14px
- `--ctl-font-weight`: 500
- `--ctl-placeholder-opacity`: 0.65

### Color

- `--ctl-bg`: var(--background-primary)
- `--ctl-border`: var(--background-modifier-border)
- `--ctl-border-hover`: var(--background-modifier-border-hover)
- `--ctl-text`: var(--text-normal)
- `--ctl-muted`: var(--text-muted)
- `--focus-ring`: var(--interactive-accent)

### Motion

- `--ctl-transition`: `border-color 120ms ease, box-shadow 120ms ease, background-color 120ms ease`

## Control Rules

Apply to: buttons, inputs, selects, pseudo-select triggers, date controls, toolbar dropdowns.

- All controls in a toolbar row must share height (`--ctl-height`).
- Border radius must be identical (`--ctl-radius`).
- Text baseline alignment must be consistent (single vertical centering strategy).
- Horizontal spacing is tokenized (`--ctl-gap`), not per-component custom margins.
- Placeholder styles should match in size/color/opacity.

## Icon Rules

- One icon size in controls: 14px.
- One icon stroke strategy per theme.
- Icon + label spacing tokenized (6px).
- Caret icon style and alignment must be shared across all select-like controls.

## Focus and Interaction States

- Hover: only border/background delta, no layout shift.
- Focus-visible: single ring definition (`outline`/`box-shadow`) across all controls.
- Active/Pressed: subtle background change only.
- Disabled: reduce contrast and pointer interaction consistently.

## Toolbar Composition

Standard primitives:

- `ToolbarRow`: horizontal container with wrap support and tokenized gaps.
- `ToolbarGroup`: visually related cluster with optional separators.
- `ToolbarControl`: normalized control wrapper for input/select/button parity.

Planner and database toolbars must use the same primitives.

## Layout Rhythm

- Use one spacing scale: 8/12/16/24.
- Keep left and right insets consistent between planner and database main toolbars.
- Cluster date navigation controls as one unit; no ad-hoc offsets.

## Recipe Surface Rules

- Recipe metadata in full view should render as compact cards (label + value), not
  as a dense inline sentence.
- Hide metadata keys that are purely structural (`title`, `cover`, `image`) from
  the visible metadata strip.
- Normalize raw frontmatter strings for display:
  - remove wrapping quotes
  - map `null`/`undefined` to empty or `None`
  - map booleans to readable labels

## Modal Rules

- Quick Meal modal actions should remain visually balanced: secondary cancel on
  the left and primary submit on the right, with consistent minimum tap sizes.
- Form fields should keep predictable heights and spacing; avoid oversized textarea
  defaults that push action buttons out of rhythm.

## Performance Constraints

- No visual state should force expensive relayout during drag.
- Avoid box-shadow/scale effects on all cards during drag.
- Keep hover/focus transitions GPU-cheap; avoid animating layout-affecting properties.
- Side preview and recipe full view should avoid blank-state flicker during normal
  file switches. Prefer cached content and deferred loading indicators.
- Warm likely-next views/files during idle time, with bounded concurrency and no
  main-thread blocking work in the hot interaction path.

## QA Checklist

- Planner and database controls have same visual height.
- Placeholder text looks identical in size/color across views.
- Focus ring looks the same for input/select/button.
- Icon size/alignment consistent across rows.
- No flicker when planner cards are dropped and metadata updates.
- No full-toolbar layout jump on window resize.
