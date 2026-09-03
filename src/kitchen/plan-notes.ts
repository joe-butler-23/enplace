import { parsePlan, serializePlan } from "../core";
import { updateText } from "../host-client/browser-storage";

export async function setDayNote(date: string, note: string): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid plan date: ${date}`);
  await updateText("Plan.md", (markdown) => {
    const plan = parsePlan(markdown);
    const next = note.replace(/\s*\r?\n\s*/g, " ").trim();
    if (next) plan.notes.set(date, next);
    else plan.notes.delete(date);
    return serializePlan(plan);
  });
}
