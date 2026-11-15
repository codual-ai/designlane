/** Small scanners over a file's text that the edit planner's safety checks share: what comes before and after a
 * value, whole words, and how far a declaration runs. */

import type { CodeSpan } from "../scan/types.js";
import { QUOTES } from "./notation.js";

export const WORD = /[\w$]/;
export const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
/** The last part of a name: `blue0` of `colors.blue0`, `500` of `colors.brand[500]`, `blue600` of `@color/blue600`. */
export const LAST_PART = /([\w$-]+)["'\]]*$/;
/** Lines one declaration may run over, at most. */
const MAX_STATEMENT_LINES = 20;
const CONTINUES = /[=(,[{+\-*/.:?|&]$/;
const OPERATORS = new Set(["+", "-", "*", "/", "%"]);

/** `span` with the quotes around it when it's a quoted literal's contents. */
export function quotedSpan(text: string, span: CodeSpan): { start: number; end: number } {
  const opening = text[span.start - 1] ?? "";
  return QUOTES.has(opening) && text[span.end] === opening
    ? { start: span.start - 1, end: span.end + 1 }
    : span;
}

/** The index of the first character at or after `from` that isn't white space or in a comment. */
export function nextCode(text: string, from: number): number {
  let at = from;
  while (at < text.length) {
    if (/\s/.test(text[at] ?? "")) at++;
    else if (text.startsWith("//", at)) at = lineEnd(text, at);
    else if (text.startsWith("/*", at)) {
      const close = text.indexOf("*/", at + 2);
      at = close === -1 ? text.length : close + 2;
    } else break;
  }
  return at;
}

function lineEnd(text: string, from: number): number {
  const end = text.indexOf("\n", from);
  return end === -1 ? text.length : end;
}

/** Whether an arithmetic operator follows `end`, past white space and comments. */
export function isOperatorAfter(text: string, end: number): boolean {
  return OPERATORS.has(text[nextCode(text, end)] ?? "");
}

/** Whether an arithmetic operator comes before `start`, past white space and comments. A line comment's start can't
 * be told from `//` in a string going backwards, so an operator before either counts. */
export function isOperatorBefore(text: string, start: number): boolean {
  let at = start;
  for (;;) {
    const previous = text[at - 1] ?? "";
    if (/\s/.test(previous)) {
      at--;
      if (previous !== "\n") continue;
      const lineStart = text.lastIndexOf("\n", at - 1) + 1;
      const comment = text.slice(lineStart, at).indexOf("//");
      if (comment === -1) continue;
      if (OPERATORS.has(text.slice(lineStart, at).trimEnd().slice(-1))) return true;
      at = lineStart + comment;
    } else if (text.startsWith("*/", at - 2)) {
      const open = text.lastIndexOf("/*", at - 3);
      if (open === -1) return true;
      at = open;
    } else return OPERATORS.has(previous);
  }
}

export function hasWord(text: string, word: string): boolean {
  for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) {
    if (!WORD.test(text[at - 1] ?? "") && !WORD.test(text[at + word.length] ?? "")) return true;
  }
  return false;
}

/** Whether `text` names `name` as a value, not as an argument's label (`primary = …`). */
export function namesWord(text: string, name: string): boolean {
  for (let at = text.indexOf(name); at !== -1; at = text.indexOf(name, at + 1)) {
    const after = text.slice(at + name.length);
    const isWord = !WORD.test(text[at - 1] ?? "") && !WORD.test(after[0] ?? "");
    if (isWord && !/^\s*(?::|=(?!=))/.test(after)) return true;
  }
  return false;
}

/** The declaration starting on `line`, through the lines it runs on to: while a bracket is open, a line ends in an
 * operator, or the next starts with a call (`.copy(…)`). */
export function statementAt(text: string, line: number): string {
  const lines = text.split("\n").slice(line - 1, line - 1 + MAX_STATEMENT_LINES);
  let depth = 0;
  let end = 0;
  while (end < lines.length) {
    const current = lines[end] ?? "";
    for (const char of current) depth += "([{".includes(char) ? 1 : ")]}".includes(char) ? -1 : 0;
    end++;
    const runsOn = depth > 0 || CONTINUES.test(current.trimEnd()) || /^\s*\??\./.test(lines[end] ?? "");
    if (!runsOn) break;
  }
  return lines.slice(0, end).join("\n");
}
