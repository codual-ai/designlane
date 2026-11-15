/** The code edits for the Figma changes a designer ticked, planned with Designmap's edit engine, and the files they
 * make. */

import { PROPERTY_NAMES } from "../../src/edit/edit-tokens.js";
import { applyEdit, type EditPlan, planEdit, type TextEdit } from "../../src/edit/plan.js";
import { type ReadSource, sourceOf } from "../../src/edit/read-source.js";
import type { FigmaChange } from "./messages.js";

const IN_CODE_TOO =
  "The code changed this too since Figma and the code last agreed. Press Apply to take the code's value, or change it in the code by hand.";

/** How the designer knows a change: `color/brand`, or `color/brand's dark colour`. */
export const changeLabel = ({ name, property }: FigmaChange) =>
  property === "light" ? name : `${name}'s ${PROPERTY_NAMES[property]}`;

/** Each change's edit, from `tokensFile` and the files `read` gives, or why there's none. No two edits overlap: the
 * engine refuses an edit wherever another token's value is written. */
export async function planCodeEdits(
  tokensFile: unknown,
  read: ReadSource,
  changes: FigmaChange[],
): Promise<Map<FigmaChange, EditPlan>> {
  const plans = new Map<FigmaChange, EditPlan>();
  for (const change of changes) {
    const { token, property, to: value } = change;
    plans.set(
      change,
      change.inCodeToo
        ? { ok: false, reason: IN_CODE_TOO }
        : await planEdit(tokensFile, read, { token, property, value }),
    );
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
