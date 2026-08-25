# Enplace Docs

This folder contains active implementation-facing documentation.

## Active Docs

- `ui-consistency-spec.md`: visual/system consistency rules for toolbars, controls, spacing, typography, and state behavior.
- `weekly-planner-behaviour.md`: source-of-truth behavior for weekly planner behaviour and quick-meal creation.
- `engineering-guardrails.md`: debugging workflow, layout invariants, and pre-merge safety checklist.
- `weekly-planner-dnd-plan.md`: phased planner drag/drop plan and data-contract alignment.
- `mep-cli-contracts.md`: canonical `mep` command contracts and data flow.
- `ci-checks-and-triage.md`: local hooks vs CI gates and automated triage mapping.
- `repo-architecture.md`: module boundaries and ownership.
- `web-host-mode.md`: hosted browser runtime and its filesystem boundary.
- `security-baseline.md`: web-host filesystem scope, local data, and security-header baseline.

## Historical Docs

- `archive/organiser/`: older organiser notes retained for reference.

## Documentation Policy

- Keep docs short and directly actionable.
- Update existing docs before creating new ones.
- Remove docs that no longer match shipped behavior.
- Keep read-only existing-recipe QA in `.agents/skills/mep-ai-led-qa/SKILL.md`; do not duplicate that workflow in docs.
- Keep new-recipe extraction in `.agents/skills/recipe-extraction/SKILL.md`; it
  writes only through `mep recipe import`.
