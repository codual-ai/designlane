/** What every notation reader shares: the code's language, a written value's text, and a call's arguments. */

import type { ValueKind } from "../scan/types.js";

/** The language a file is written in, which decides how a notation reads (`0xFF…` is ARGB in Kotlin). */
export type Language = "swift" | "kotlin" | "xml" | "js" | "css" | "json";

const LANGUAGES: Record<string, Language> = {
  swift: "swift",
  kt: "kotlin",
  kts: "kotlin",
  java: "kotlin",
  xml: "xml",
  js: "js",
  jsx: "js",
  ts: "js",
  tsx: "js",
  mjs: "js",
  cjs: "js",
  css: "css",
  json: "json",
};

export function languageOf(file: string): Language | undefined {
  const extension = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  return hasOwn(LANGUAGES, extension) ? LANGUAGES[extension] : undefined;
}

/** A value's text as it's written, and what's around it. */
export interface SpanText {
  text: string;
  kind: ValueKind;
  language: Language;
  /** The whole file, for a notation that takes its style from the rest of it (the case of hex digits). */
  fileText: string;
}

/** A value as the code writes it: what it holds, and the same notation holding another value in its place. */
export interface Written<T> {
  value: T;
  /** The text for `to` in place of `from`, or undefined when this notation can't hold it. */
  write: (to: T, from: T) => string | undefined;
}

/** Longer values are no single literal or call. */
export const MAX_VALUE_LENGTH = 2000;

/** Whether `record` has `key` of its own, not one every object inherits (`constructor`). */
export const hasOwn = (record: object, key: string) =>
  Object.getOwnPropertyDescriptor(record, key) !== undefined;

export interface Argument {
  /** `red` in Swift's `red: 0.2` or Kotlin's `red = 0.2f`. */
  label?: string;
  /** The argument's value, trimmed. */
  value: string;
  /** Where the value starts in the call's text. */
  start: number;
}

const CALLEE = /^\.?[A-Za-z_][\w.]*\(/;
const LABEL = /^([A-Za-z_]\w*)\s*(?::(?!:)|=(?!=))\s*/;
const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);
export const QUOTES = new Set(['"', "'", "`"]);

/** The arguments of `text` when it's one call and nothing else (`Color(red: 1, green: 0, blue: 0)`), so a chained
 * call after it (`.opacity(0.5)`) makes it unreadable rather than half read. */
export function callArguments(text: string): Argument[] | undefined {
  const open = CALLEE.exec(text)?.[0].length;
  if (open === undefined || text.length > MAX_VALUE_LENGTH) return undefined;
  const pieces: [number, number][] = [];
  let depth = 0;
  let from = open;
  for (let i = open; i < text.length; i++) {
    const char = text[i] ?? "";
    if (QUOTES.has(char)) i = stringEnd(text, i);
    else if (OPENERS.has(char)) depth++;
    else if (char === "," && depth === 0) {
      pieces.push([from, i]);
      from = i + 1;
    } else if (CLOSERS.has(char) && depth-- === 0) {
      if (i !== text.length - 1) return undefined;
      pieces.push([from, i]);
      return pieces.flatMap(([start, end]) => argument(text, start, end));
    }
  }
  return undefined;
}

/** The index of the quote closing the string opened at `at`, or the text's end when it never closes. */
function stringEnd(text: string, at: number): number {
  for (let i = at + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === text[at]) return i;
  }
  return text.length;
}

function argument(text: string, start: number, end: number): Argument[] {
  const raw = text.slice(start, end);
  const lead = raw.length - raw.trimStart().length;
  const label = LABEL.exec(raw.slice(lead));
  const valueStart = start + lead + (label?.[0].length ?? 0);
  const value = text.slice(valueStart, end).trimEnd();
  if (!value && !label) return [];
  return [{ ...(label?.[1] ? { label: label[1] } : {}), value, start: valueStart }];
}

/** `text` with each `[start, end)` replaced, the replacements not overlapping. */
export function spliced(text: string, replacements: readonly { start: number; end: number; text: string }[]) {
  let out = "";
  let at = 0;
  for (const { start, end, text: replacement } of [...replacements].sort((a, b) => a.start - b.start)) {
    out += text.slice(at, start) + replacement;
    at = end;
  }
  return out + text.slice(at);
}
