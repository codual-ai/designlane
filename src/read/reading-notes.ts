/**
 * What the readers note about a layout as they read it: why one couldn't be read whole, and what in one that was may
 * be wrong, where in the view's file. `layoutIssues` gives them with their spans.
 */

import type { LayoutIssueKind, UnreadableReason } from "./schema.js";

/** A layout that couldn't be read whole: why, and where in its file. */
export interface Unread {
  reason: UnreadableReason;
  at: number;
}

/** One issue, written from `start` to `end` in the view's file, with what it's about (`detail`: an element's name). */
export interface Issue {
  kind: LayoutIssueKind;
  start: number;
  end: number;
  detail?: string;
}

/** What a reader notes: its issues, and the first reason it stopped short, if it did. */
export class ReadingNotes {
  readonly issues: Issue[] = [];
  stopped: Unread | undefined;
  /** The issues noted, so one read again (a view property placed twice) is noted once. */
  private readonly noted = new Set<string>();
  /** Code the layout leaves out (what a leaf holds: a button's label), whose issues aren't the layout's. */
  private readonly dropped: [number, number][] = [];

  issue(issue: Issue): void {
    const key = `${issue.kind} ${issue.start} ${issue.end} ${issue.detail ?? ""}`;
    if (this.noted.has(key)) return;
    this.noted.add(key);
    this.issues.push(issue);
  }

  /** Records code the layout leaves out, from `start` to `end`. */
  drop(start: number, end: number): void {
    this.dropped.push([start, end]);
  }

  /** The issues about what the layout holds. What it builds from elements isn't noted inside a leaf at all; an `#if`
   * is noted as its code is read, before the layout knows a leaf holds it, so one inside what a leaf holds is left
   * out here. */
  kept(): Issue[] {
    if (this.dropped.length === 0) return this.issues;
    return this.issues.filter(
      (i) =>
        i.kind !== "if-as-written" || !this.dropped.some(([start, end]) => i.start >= start && i.end <= end),
    );
  }

  /** Records why the reading stopped short, keeping the first reason. */
  stop(reason: UnreadableReason, at: number): void {
    this.stopped ??= { reason, at };
  }
}

export const isUnread = (value: unknown): value is Unread =>
  typeof value === "object" && value !== null && "reason" in value && "at" in value;
