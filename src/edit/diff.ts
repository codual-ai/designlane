import type { TextEdit } from "./plan.js";

/** `edit` as a unified diff of the lines it changes, from `text`, the file's text before it. Lines inside the edit that
 * stay the same (an asset's unchanged alpha) are left out. */
export function editDiff(text: string, edit: TextEdit): string {
  const from = text.lastIndexOf("\n", edit.start - 1) + 1;
  const lineEnd = text.indexOf("\n", edit.end);
  const to = lineEnd === -1 ? text.length : lineEnd;
  const before = text.slice(from, to).split("\n");
  const after = `${text.slice(from, edit.start)}${edit.after}${text.slice(edit.end, to)}`.split("\n");
  const hunks = before.length === after.length ? changedRuns(before, after) : [{ at: 0, before, after }];
  return [
    `--- a/${edit.file}`,
    `+++ b/${edit.file}`,
    ...hunks.flatMap((hunk) => {
      const line = edit.line + hunk.at;
      return [
        `@@ -${line},${hunk.before.length} +${line},${hunk.after.length} @@`,
        ...hunk.before.map((text) => `-${text}`),
        ...hunk.after.map((text) => `+${text}`),
      ];
    }),
  ].join("\n");
}

interface Hunk {
  /** Lines after the edit's first. */
  at: number;
  before: string[];
  after: string[];
}

/** The runs of lines that differ between `before` and `after`, which have as many lines. */
function changedRuns(before: string[], after: string[]): Hunk[] {
  const hunks: Hunk[] = [];
  let open: Hunk | undefined;
  before.forEach((line, i) => {
    const changed = after[i] ?? "";
    if (line === changed) {
      open = undefined;
      return;
    }
    if (!open) {
      open = { at: i, before: [], after: [] };
      hunks.push(open);
    }
    open.before.push(line);
    open.after.push(changed);
  });
  return hunks;
}
