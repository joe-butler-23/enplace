import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const edits = [
  {
    file: "src/modules/cooking/services/checkShoppingItem.ts",
    old: "type PersistShoppingCheck = (args: {",
    replacement: "let nextShoppingCheckGeneration = 0;\n\ntype PersistShoppingCheck = (args: {",
  },
  {
    file: "src/modules/cooking/services/checkShoppingItem.ts",
    old: "    publish(await persist({ itemId, checked }));",
    replacement: `    const persisted = await persist({ itemId, checked });
    const generation = ++nextShoppingCheckGeneration;
    performance.mark("mep:shopping:check-settled", { detail: {
      generation, itemId, checked,
      presentationIdentifier: \`mep:shopping-check:\${itemId}:\${checked ? "checked" : "unchecked"}\`,
    }});
    publish(persisted);`,
  },
  {
    file: "src/modules/organiser/hooks/useKanbanBoard.ts",
    old: "const plannerCardTitleTimingIdentifier = (entryId: string): string => `mep:planner-card-title:${entryId}`;",
    replacement: "const plannerCardTitleTimingIdentifier = (entryId: string): string => `mep:planner-card-title:${entryId}`;\nlet nextPlannerDropGeneration = 0;",
  },
  {
    file: "src/modules/organiser/hooks/useKanbanBoard.ts",
    old: `\t\t\t\t\t\t\t\t\t}
\t\t\t\t\t\t\t\t})
\t\t\t\t\t\t\t.catch((err) => {`,
    replacement: `\t\t\t\t\t\t\t\t\t}
\t\t\t\t\t\t\t\t\tperformance.mark("mep:planner:drop-settled", { detail: {
\t\t\t\t\t\t\t\t\t\tgeneration: ++nextPlannerDropGeneration,
\t\t\t\t\t\t\t\t\t\titemId: filePath,
\t\t\t\t\t\t\t\t\t\tsourceLaneId: intentForDrop.sourceLaneId,
\t\t\t\t\t\t\t\t\t\ttargetLaneId,
\t\t\t\t\t\t\t\t\t\ttargetEntryId: nextEntryId,
\t\t\t\t\t\t\t\t\t\tpresentationIdentifier: plannerCardTitleTimingIdentifier(nextEntryId),
\t\t\t\t\t\t\t\t\t}});
\t\t\t\t\t\t\t\t})
\t\t\t\t\t\t\t.catch((err) => {`,
  },
  {
    file: "src/views/components/ShoppingListView.tsx",
    old: "export function shoppingItemTimingIdentifier(itemId: string): string {\n  return `mep:shopping-item:${itemId}`;\n}",
    replacement: "export function shoppingItemTimingIdentifier(itemId: string): string {\n  return `mep:shopping-item:${itemId}`;\n}\n\nexport function shoppingCheckTimingIdentifier(itemId: string, checked: boolean): string {\n  return `mep:shopping-check:${itemId}:${checked ? 'checked' : 'unchecked'}`;\n}",
  },
  {
    file: "src/views/components/ShoppingListView.tsx",
    old: "        <span\n          {...({",
    replacement: "        <span key={`${item.id}:${item.checked}`}\n          {...({",
  },
  {
    file: "src/views/components/ShoppingListView.tsx",
    old: "          checked={item.checked}\n          disabled={busy}",
    replacement: "          checked={item.checked}\n          data-item-id={item.id}\n          disabled={busy}",
  },
  {
    file: "src/views/components/ShoppingListView.tsx",
    old: "<ShoppingItemRow key={item.id} item={item} busy={busy} onCheck={onCheck} onRemove={onRemove} elementTimingId={item.id === firstItemId ? shoppingItemTimingIdentifier(item.id) : undefined}/>",
    replacement: "<ShoppingItemRow key={item.id} item={item} busy={busy} onCheck={onCheck} onRemove={onRemove} elementTimingId={shoppingCheckTimingIdentifier(item.id, item.checked)}/>",
  },
  {
    file: "src/standalone.css",
    old: ".mep-nav__item:hover {\n  border-color: var(--line);\n  background: var(--hover);\n}",
    replacement: ".mep-nav__item:hover {\n  border-color: var(--line);\n  background: var(--hover);\n}\n\n.mep-nav__item:active {\n  transform: scale(0.94);\n}",
  },
  {
    file: "styles.css",
    old: ".cooking-db__card-open:focus-visible {\n  outline: 2px solid var(--accent);\n  outline-offset: -2px;\n}",
    replacement: ".cooking-db__card-open:focus-visible {\n  outline: 2px solid var(--accent);\n  outline-offset: -2px;\n}\n\n.cooking-db__card-open:active {\n  transform: scale(0.985);\n}",
  },
  {
    file: "styles.css",
    old: ".kanban-item:active,\n.organiser-card:active {\n  cursor: grabbing;\n}",
    replacement: ".kanban-item:active,\n.organiser-card:active {\n  cursor: grabbing;\n  transform: scale(0.985);\n}",
  },
];

const digest = (value) => createHash("sha256").update(value).digest("hex");
export const instrumentationPlanSha256 = digest(JSON.stringify(edits.map(({ file, old, replacement }) => ({ file, old, replacement }))));

const occurrences = (value, needle) => value.split(needle).length - 1;

export function classifyInstrumentationState(value, edit) {
  const replacementOccurrences = occurrences(value, edit.replacement);
  const withoutReplacements = value.split(edit.replacement).join("");
  const oldOccurrences = occurrences(withoutReplacements, edit.old);
  if (oldOccurrences === 1 && replacementOccurrences === 0) return { mode: "apply", oldOccurrences, replacementOccurrences };
  if (oldOccurrences === 0 && replacementOccurrences === 1) return { mode: "preexisting", oldOccurrences, replacementOccurrences };
  throw new Error(`${edit.file}: instrumentation state old=${oldOccurrences}, replacement=${replacementOccurrences}; expected exactly 1/0 or 0/1`);
}

export async function applyLatencyInstrumentation(root) {
  const documents = new Map();
  const proof = [];
  for (const edit of edits) {
    const filename = path.join(root, edit.file);
    let document = documents.get(filename);
    if (!document) {
      const value = await readFile(filename, "utf8");
      document = { before: value, after: value };
      documents.set(filename, document);
    }
    const before = document.after;
    const classification = classifyInstrumentationState(before, edit);
    const after = classification.mode === "apply" ? before.replace(edit.old, edit.replacement) : before;
    document.after = after;
    proof.push({
      file: edit.file,
      mode: classification.mode,
      oldOccurrences: classification.oldOccurrences,
      replacementOccurrences: classification.replacementOccurrences,
      beforeSha256: digest(before),
      afterSha256: digest(after),
    });
  }

  // No file is mutated until every edit has matched one of the two accepted states.
  for (const [filename, document] of documents) {
    if (document.after !== document.before) await writeFile(filename, document.after);
  }
  const modes = new Set(proof.map((entry) => entry.mode));
  return { schemaVersion: 1, planSha256: instrumentationPlanSha256, mode: modes.size === 1 ? proof[0].mode : "mixed", editCount: edits.length, edits: proof };
}
