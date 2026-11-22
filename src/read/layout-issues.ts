/** Where Designlane falls short on a screen: why its layout couldn't be read whole, and what in one that was may be
 * wrong, each where it's written. */

import type { CodeSpan, ScreenRef } from "../scan/types.js";
import type { LayoutReading } from "./layout-of.js";
import { type Issue, isUnread, type Unread } from "./reading-notes.js";
import type { LayoutIssues, LayoutNode } from "./schema.js";
import type { PartsReading } from "./screen-parts.js";

/** What a view reads on the way to its layouts and parts. */
export interface Readings {
  /** The view `screen` names, and its layout's reading: the layout with its issues, or why it couldn't be read. */
  layout(screen: string | ScreenRef): { view: ScreenRef; reading: LayoutReading };
  /** `screenParts`'s reading of `screen`: its parts and which are unnamed, or the view on the way it couldn't read. */
  parts(screen: string | ScreenRef): PartsReading;
  /** Where `start` to `end` is in the file `rel`. */
  span(rel: string, start: number, end: number): CodeSpan;
}

/** The layout issues of `screen`, from what `readings` reads of it. Throws as `layoutOf` does. */
export function layoutIssues(readings: Readings, screen: string | ScreenRef): LayoutIssues {
  const { view, reading } = readings.layout(screen);
  if (isUnread(reading))
    return { screen: view.id, unreadable: unreadable(readings, view, reading), issues: [] };
  const issues = issuesIn(readings, view, reading);
  const parts = readings.parts(view.id);
  // The views the parts are found in are part of the screen too: what may be wrong in them is the screen's, each view
  // once, though one placing itself is followed again.
  const read = new Set([view.id]);
  for (const placed of parts.views) {
    if (read.has(placed)) continue;
    read.add(placed);
    const followed = readings.layout(placed);
    if (!isUnread(followed.reading)) issues.push(...issuesIn(readings, followed.view, followed.reading));
  }
  if ("unread" in parts) {
    const stopped = readings.layout(parts.unread);
    return {
      screen: view.id,
      ...(isUnread(stopped.reading) && { unreadable: unreadable(readings, stopped.view, stopped.reading) }),
      issues,
    };
  }
  for (const part of parts.unnamed)
    issues.push({ kind: "unnamed-part", span: part.span, detail: part.label });
  if (parts.parts.length === 0 && view.kind === "screen")
    issues.push({ kind: "no-parts", span: reading.layout.span });
  return { screen: view.id, issues };
}

/** Why `view`'s layout couldn't be read, where in its file. */
function unreadable(
  readings: Readings,
  view: ScreenRef,
  why: Unread,
): NonNullable<LayoutIssues["unreadable"]> {
  return { reason: why.reason, view: view.id, span: readings.span(view.file, why.at, why.at) };
}

/** What may be wrong in `view`'s layout: what its readers noted, and any place it places itself. */
function issuesIn(
  readings: Readings,
  view: ScreenRef,
  reading: Exclude<LayoutReading, Unread>,
): LayoutIssues["issues"] {
  const issues = reading.issues.map((i) => spanned(readings, view.file, i));
  for (const node of nodesOf(reading.layout))
    if (node !== reading.layout && node.kind === "view-ref" && node.ref === view.id)
      issues.push({ kind: "self-placed", span: node.span });
  return issues;
}

/** An issue noted in the file `rel`, with its span. */
function spanned(readings: Readings, rel: string, issue: Issue): LayoutIssues["issues"][number] {
  return {
    kind: issue.kind,
    span: readings.span(rel, issue.start, issue.end),
    ...(issue.detail !== undefined && { detail: issue.detail }),
  };
}

/** `node` and every node under it. */
function nodesOf(node: LayoutNode): LayoutNode[] {
  return [node, ...node.children.flatMap(nodesOf)];
}
