/** What every MCP tool shares: reading the app a call names, and answering in text. */

import path from "node:path";
import { isFolder, readGaps } from "../scan/files.js";
import { scanRepo } from "../scan/index.js";
import { scanNotes } from "../scan/notes.js";
import { type ScanResult, SUPPORTED_FRAMEWORKS } from "../scan/types.js";

/** How many items a tool lists; a narrower query shows the rest. */
export const MAX_LISTED = 40;

export type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

export const text = (t: string): Result => ({ content: [{ type: "text", text: t }] });
export const failure = (t: string): Result => ({ isError: true, ...text(t) });

/** A tool's answer, or a failure the agent can act on (no such component, a picture breaking a rule). */
export type Answer = string | Result;

/** Every tool's one way in: reads the app the call names, notes when only part of it could be read, and turns any
 * failure into a message the agent can act on. */
export async function withApp(
  root: string,
  answer: (scan: ScanResult) => Answer | Promise<Answer>,
): Promise<Result> {
  try {
    if (!(await isFolder(root))) return failure(`Not a folder: ${root}. Pass the app's folder as repo.`);
    const scan = await scanRepo(root);
    const gaps = [readGaps(scan), ...scanNotes(scan)].filter(Boolean).join(" ");
    if (!scan.frameworks.length)
      return failure([`No ${SUPPORTED_FRAMEWORKS} code found in ${root}.`, gaps].filter(Boolean).join(" "));
    const answered = await answer(scan);
    if (typeof answered !== "string") return answered;
    return text(`${gaps ? `${gaps}\n\n` : ""}${answered}`);
  } catch (e) {
    return failure(`Designlane couldn't read ${root}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** `file` as the scan writes paths: relative to the app's folder, with forward slashes. */
export const appPath = (root: string, file: string) =>
  path.relative(root, path.resolve(root, file)).split(path.sep).join("/");
