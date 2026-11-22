/** The catalog's reading of Compose views: a composable function's parameters, and the calls placing it. */

import { bodyAfter, CALL, PREVIEW } from "../frameworks/compose-functions.js";
import { type KotlinSource, treeOf } from "../frameworks/kotlin-sources.js";
import {
  type CallSyntax,
  type ComponentReader,
  callPlacements,
  type Declaration,
  lineIndex,
  onLine,
  perSource,
  type Range,
  splitParameters,
} from "./reader.js";

/** A function whose name starts with a capital, with optional type parameters and receiver, up to its `(`. */
const FUNCTION = /\bfun\s+(?:<[^<>\n]{0,200}>\s*)?(?:[\w.<>?]{1,200}\.)?([A-Z]\w*)\s*\(/g;
/** How far before `fun` its annotations are read, for telling a preview. */
const MAX_ANNOTATIONS = 300;
/** `Row(` placed; `fun Row(` or `class Row(` declared, not called. */
const KOTLIN_CALLS: CallSyntax = {
  call: CALL,
  declared: /\b(?:fun|class|interface|object|typealias)\s+(?:<[^<>\n]*>\s*)?(?:[\w.?]+\.)?$/,
  declarationChars: 40,
};
/** An annotation and a default value, which a parameter is shown without. */
const ANNOTATION = /^(?:@[\w.]+(?:\([^()]*\))?\s+)*/;
const DEFAULT = /\s*=[\s\S]*$/;

interface KotlinFunction {
  name: string;
  start: number;
  open: number;
  close: number;
  body: [number, number];
  preview: boolean;
}

// Shared by every reader of the same sources: the catalog and the drift report.
const functionsOf = perSource(functions);
const previewsOf = perSource((source: KotlinSource): Range[] =>
  functionsOf(source)
    .filter((f) => f.preview)
    .map((f) => [f.start, f.body[1] + 1]),
);

/** The reader of `files`' composables. A preview (`@Preview fun CardPreview()`) isn't a component of the catalog's, so
 * it has no declaration, unless `previews`: a layout reads one the scan lists as the view it is. */
export function kotlinReader(files: KotlinSource[], { previews = false } = {}): ComponentReader {
  const byFile = new Map(files.map((f) => [f.rel, f]));
  const linesOf = perSource((source: KotlinSource) => lineIndex(source.text));
  return {
    declaration(view) {
      const source = byFile.get(view.file);
      if (!source) return undefined;
      const named = functionsOf(source).filter((f) => f.name === view.name);
      const find = (candidates: KotlinFunction[]) =>
        onLine(candidates, view, linesOf(source), (f) => [f.start, f.body[0]]);
      // A function that isn't a preview first, so a preview of the same name never stands in for it.
      const fn =
        find(named.filter((f) => !f.preview)) ??
        (previews ? find(named.filter((f) => f.preview)) : undefined);
      return fn && declarationOf(source, fn);
    },
    placements(names) {
      return files.flatMap((source) => callPlacements(source, previewsOf(source), names, KOTLIN_CALLS));
    },
    previews(rel) {
      const source = byFile.get(rel);
      return source ? previewsOf(source) : [];
    },
  };
}

function functions(source: KotlinSource): KotlinFunction[] {
  const { code } = source;
  const { closeOf } = treeOf(source);
  const out: KotlinFunction[] = [];
  // The ends of the functions read so far that `start` may still be inside, innermost last.
  const enclosing: number[] = [];
  let previous = -1;
  for (const m of code.matchAll(FUNCTION)) {
    const start = m.index ?? 0;
    const open = start + m[0].length - 1;
    const close = closeOf.get(open);
    const body = close === undefined ? undefined : bodyAfter(source, close + 1);
    if (close === undefined || !body) continue;
    // Its annotations start after the function before it ends, an expression body having no `}` to stop at.
    for (let end = enclosing.at(-1); end !== undefined && end < start; end = enclosing.at(-1)) {
      previous = Math.max(previous, end);
      enclosing.pop();
    }
    const before = code.slice(Math.max(0, start - MAX_ANNOTATIONS, previous + 1), start);
    // Nor past another `fun`: a lowercase one this reader skips still owns the annotations above it.
    const lastFun = [...before.matchAll(/\bfun\b/g)].at(-1)?.index ?? -1;
    const annotations = before.slice(Math.max(before.lastIndexOf("}"), lastFun) + 1);
    out.push({ name: m[1] ?? "", start, open, close, body, preview: PREVIEW.test(annotations) });
    enclosing.push(body[1]);
  }
  return out;
}

function declarationOf(source: KotlinSource, fn: KotlinFunction): Declaration {
  // Split in the blanked code, so a comma in a default string doesn't split a parameter; defaults are dropped.
  const params = splitParameters(source.code.slice(fn.open + 1, fn.close))
    .map((p) => p.replace(ANNOTATION, "").replace(DEFAULT, "").trim())
    .filter(Boolean);
  return { start: fn.start, end: fn.body[1] + 1, params };
}
