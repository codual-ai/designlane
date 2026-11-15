/** The code edits for the Figma changes a designer ticked, planned with Designmap's edit engine, and the files they
 * make. */

import { valueLabel } from "../../src/edit/edit-tokens.js";
import { applyEdit, type EditPlan, planEdit, type TextEdit } from "../../src/edit/plan.js";
import { type ReadSource, sourceOf } from "../../src/edit/read-source.js";
import type { FigmaChange } from "./messages.js";

/** How the designer knows a change: `color/brand`, or `color/brand's dark colour`. */
export const changeLabel = ({ name, property }: FigmaChange) =>
  property === "light" ? name : valueLabel(name, property);

/** Each change's edit, from `tokensFile` and the files `read` gives, or why there's none: from the code's value now,
 * also for a value the code changed too. No two edits overlap: the engine refuses an edit wherever another token's
 * value is written. */
export async function planCodeEdits(
  tokensFile: unknown,
  read: ReadSource,
  changes: FigmaChange[],
): Promise<Map<FigmaChange, EditPlan>> {
  const plans = new Map<FigmaChange, EditPlan>();
  for (const change of changes) {
    const { token, property, to: value } = change;
    plans.set(change, await planEdit(tokensFile, read, { token, property, value }));
  }
  return plans;
}

/** Each file `edits` change, with its edits made, last first so the earlier ones' offsets still hold. */
export async function editedFiles(read: ReadSource, edits: TextEdit[]): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const file of new Set(edits.map((edit) => edit.file))) {
    const source = await sourceOf(read, file);
    if ("reason" in source) throw new Error(source.reason);
    const inFile = edits.filter((edit) => edit.file === file).sort((a, b) => b.start - a.start);
    files.set(file, inFile.reduce(applyEdit, source.source));
  }
  return files;
}
