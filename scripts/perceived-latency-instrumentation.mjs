import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Every mark, element-timing identifier, and press-feedback rule the harness needs is
// permanent in the product now, so no source edit is applied at build time. The empty
// plan keeps the admission digest stable and the apply path honest.
const edits = [];

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
  return { schemaVersion: 1, planSha256: instrumentationPlanSha256, mode: modes.size === 0 ? "preexisting" : modes.size === 1 ? proof[0].mode : "mixed", editCount: edits.length, edits: proof };
}
