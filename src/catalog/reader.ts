/** What the catalog reads from each framework's code: where a view is declared, and where views are placed. */

import type { ScreenRef } from "../scan/types.js";

/** A view's declaration in its file: its offsets, and its parameters as the code writes them. */
export interface Declaration {
  start: number;
  /** Exclusive. */
  end: number;
  params: string[];
}

/** A view placed in code, by name, at an offset of a file. */
export interface Placement {
  name: string;
  rel: string;
  at: number;
}

/** `[start, end)` offsets of a file. */
export type Range = readonly [number, number];

export interface ComponentReader {
  declaration(view: ScreenRef): Declaration | undefined;
  /** Every placement of a view named in `names`, leaving out previews. */
  placements(names: ReadonlySet<string>): Placement[];
  /** Where the file's previews are, which show views in the IDE and aren't part of the app. */
  previews(rel: string): readonly Range[];
}

/** How a language's code builds a view by name, and the keywords before a name it declares instead. */
export interface CallSyntax {
  call: RegExp;
  declared: RegExp;
  /** How far back `declared` is looked for. */
  declarationChars: number;
}

/** Each call in `file`'s code building a view named in `names`, outside `previews` and declarations. */
export function callPlacements(
  file: { rel: string; code: string },
  previews: readonly Range[],
  names: ReadonlySet<string>,
  syntax: CallSyntax,
): Placement[] {
  const out: Placement[] = [];
  for (const m of file.code.matchAll(syntax.call)) {
    const name = m[1] ?? "";
    const at = m.index ?? 0;
    if (!names.has(name) || inRanges(previews, at)) continue;
    if (syntax.declared.test(file.code.slice(Math.max(0, at - syntax.declarationChars), at))) continue;
    out.push({ name, rel: file.rel, at });
  }
  return out;
}

/** Of a name's declarations in a file, the one on the view's line, else the first: a scan's line is where the
 * declaration starts or where its body opens. */
export function onLine<T>(
  candidates: T[],
  view: ScreenRef,
  lineAt: (offset: number) => number,
  offsets: (item: T) => number[],
): T | undefined {
  return candidates.find((c) => offsets(c).some((offset) => lineAt(offset) === view.line)) ?? candidates[0];
}

/** The 1-based line of any offset in `text`, found by binary search over its line starts. */
export function lineIndex(text: string): (offset: number) => number {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((starts[mid] ?? 0) <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}

/** `compute`, worked out once per source. */
export function perSource<S extends object, T>(compute: (source: S) => T): (source: S) => T {
  const known = new WeakMap<S, T>();
  return (source) => {
    if (known.has(source)) return known.get(source) as T;
    const value = compute(source);
    known.set(source, value);
    return value;
  };
}

/** `items` by a key, each key's in order: for finding a file's declarations of a name without reading them all. */
export function indexed<T>(items: T[], key: (item: T) => string | number): Map<string | number, T[]> {
  const index = new Map<string | number, T[]>();
  for (const item of items) {
    const k = key(item);
    const same = index.get(k);
    if (same) same.push(item);
    else index.set(k, [item]);
  }
  return index;
}

/** Whether `at` falls in one of `ranges`, each `[start, end)`. */
export const inRanges = (ranges: readonly Range[], at: number) =>
  ranges.some(([start, end]) => at >= start && at < end);

/** Parameters split at their own commas, not those inside brackets or generics, with whitespace collapsed. */
export function splitParameters(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < list.length; i++) {
    const c = list[i] ?? "";
    // The `>` of a function type's `->` doesn't close a bracket.
    if (c === "-" && list[i + 1] === ">") {
      current += "->";
      i++;
      continue;
    }
    if ("([{<".includes(c)) depth++;
    else if (")]}>".includes(c)) depth--;
    if (c === "," && depth === 0) {
      out.push(current);
      current = "";
    } else current += c;
  }
  out.push(current);
  return out.map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
}
