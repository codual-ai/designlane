/**
 * Text reading that every language reader shares: blanking comments and strings (keeping newlines and offsets, so
 * positions still match the file), matching brackets, and line numbers. Each language supplies only where its
 * comments and strings end.
 */

import { firstAtOrAfter } from "../scan/sorted.js";
import type { CodeSpan } from "../scan/types.js";

/** `code` with each `[start, end)` of `ranges` replaced by spaces, keeping newlines and offsets. */
export function blankRanges(code: string, ranges: Iterable<readonly [number, number]>): string {
  const out = code.split("");
  // Each character once, however the ranges nest or overlap.
  let done = 0;
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    for (let k = Math.max(start, done); k < end; k++) if (out[k] !== "\n") out[k] = " ";
    done = Math.max(done, end);
  }
  return out.join("");
}

/** Where the comment or string starting at `i` ends, or undefined when none starts there. */
export type CommentOrStringEnd = (text: string, i: number) => number | undefined;

/** The text with every comment and string `endOf` finds replaced by spaces, so only code is left. */
export function blankCommentsAndStrings(text: string, endOf: CommentOrStringEnd): string {
  const out = text.split("");
  let i = 0;
  while (i < text.length) {
    const end = endOf(text, i);
    if (end === undefined) {
      i++;
      continue;
    }
    for (let k = i; k < end; k++) if (out[k] !== "\n") out[k] = " ";
    i = end;
  }
  return out.join("");
}

/** Turns offsets of `text`, the text of `file`, into spans of it, finding each line by binary search over the line
 * starts, which are found once. */
export function locator(file: string, text: string): (start: number, end: number) => CodeSpan {
  const lineStarts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lineStarts.push(i + 1);
  return (start, end) => ({ file, line: firstAtOrAfter(lineStarts, start + 1), start, end });
}

/** 1-based line numbers of ascending offsets, in one pass over the text. */
export function lineNumbers(text: string, offsets: number[]): number[] {
  let line = 1;
  let at = 0;
  return offsets.map((offset) => {
    for (; at < offset; at++) if (text[at] === "\n") line++;
    return line;
  });
}

/** The offset just after the last non-space character before `end`. */
export const skipSpaceBack = (code: string, end: number) => {
  let j = end;
  while (j > 0 && /\s/.test(code[j - 1] ?? "")) j--;
  return j;
};

/** The word just before `end`, ignoring whitespace: `sheet` in `.sheet (`. */
export function identifierBefore(code: string, end: number): string {
  const stop = skipSpaceBack(code, end);
  let start = stop;
  while (start > 0 && /\w/.test(code[start - 1] ?? "")) start--;
  return code.slice(start, stop);
}

export interface BracketTree {
  /** For every offset, the `(` or `{` it sits directly inside, or -1. */
  enclosing: Int32Array;
  closeOf: Map<number, number>;
  openOf: Map<number, number>;
}

/** Every `(` and `{` with its matching close, and for every offset the bracket it sits directly inside. A close
 * only pairs with its own kind of open, so an unbalanced `(` can't swallow a struct's `}`. */
export function bracketTree(code: string): BracketTree {
  const enclosing = new Int32Array(code.length).fill(-1);
  const closeOf = new Map<number, number>();
  const openOf = new Map<number, number>();
  const stack: number[] = [];
  for (let j = 0; j < code.length; j++) {
    const c = code[j];
    enclosing[j] = stack.at(-1) ?? -1;
    if (c === "(" || c === "{") {
      stack.push(j);
    } else if (c === ")" || c === "}") {
      const match = matchingOpen(code, stack, c === ")" ? "(" : "{");
      if (match === -1) continue;
      const open = stack[match] ?? -1;
      stack.length = match;
      closeOf.set(open, j);
      openOf.set(j, open);
    }
  }
  return { enclosing, closeOf, openOf };
}

/** How many unclosed brackets a close may skip to find its own kind; real code skips one or two at most. */
const MAX_SKIPPED = 32;

/** The stack index of the nearest open of kind `opener`, looking past at most `MAX_SKIPPED` others, or -1. */
function matchingOpen(code: string, stack: number[], opener: string): number {
  for (let k = stack.length - 1; k >= 0 && k >= stack.length - 1 - MAX_SKIPPED; k--) {
    if (code[stack[k] ?? -1] === opener) return k;
  }
  return -1;
}
