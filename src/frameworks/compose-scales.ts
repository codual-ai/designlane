/**
 * Spacing and corner radius scales declared in Kotlin: `dp` values an object or class of that name declares as its
 * own, `object Spacing { val medium = 12.dp }` or `data class AppSpacing(val medium: Dp = 12.dp)`, the second read
 * through a composition local (`LocalSpacing.current.medium`) or a theme extension (`MaterialTheme.spacing.medium`).
 */

import { countUse, escapeRegExp, type ScaleCandidate, scaleKindOf } from "../scan/scales.js";
import { type KotlinSource, spanIn, treeOf } from "./kotlin-sources.js";
import { valueAt } from "./value-locations.js";

/** `object Spacing`, `data class AppSpacing(`, `class Radii`: a type that may hold a scale. */
const TYPE = /\b(object|class)\s+([A-Z]\w*)/g;
/** `val medium = 12.dp` or `val medium: Dp = 12.dp`, the value ending the declaration. */
const STEP = /\bval\s+(\w+)\s*(?::\s*Dp\s*)?=\s*(\d+(?:\.\d+)?\.dp)(?=\s*(?:[,)};\n]|$))/g;

/** Every scale step the Kotlin code declares, with the files using each by name. */
export function composeScaleCandidates(sources: KotlinSource[]): ScaleCandidate[] {
  const found: ScaleCandidate[] = [];
  for (const source of sources) {
    for (const type of source.code.matchAll(TYPE)) {
      const owner = type[2] ?? "";
      const kind = scaleKindOf(owner);
      if (!kind) continue;
      const body = bodyOf(source, (type.index ?? 0) + type[0].length);
      if (!body) continue;
      const tree = treeOf(source);
      for (const step of source.code.slice(body.open + 1, body.close).matchAll(STEP)) {
        const value = step[2] ?? "";
        const valueStart = body.open + 1 + (step.index ?? 0) + step[0].lastIndexOf(value);
        // Only the type's own values, not one in a function or a nested type inside it.
        if (tree.enclosing[valueStart] !== body.open) continue;
        const span = spanIn(source, valueStart, valueStart + value.length);
        const name = step[1] ?? "";
        found.push({
          kind,
          scale: owner,
          step: {
            name,
            value: Number(value.slice(0, -".dp".length)),
            reference: `${owner}.${name}`,
            source: source.rel,
            line: span.line,
            location: valueAt(span, "expression"),
          },
          usedIn: new Map(),
        });
      }
    }
  }
  countUses(found, sources);
  return found;
}

/** The brackets holding a type's members, from just past its name: an object's or class's `{ … }`, or a class's
 * constructor `( … )`. */
function bodyOf(source: KotlinSource, from: number): { open: number; close: number } | undefined {
  const header = /^[^{}()=;\n]*?([({])/.exec(source.code.slice(from, from + 200));
  if (!header) return undefined;
  const open = from + (header.index ?? 0) + header[0].length - 1;
  const close = treeOf(source).closeOf.get(open);
  return close === undefined ? undefined : { open, close };
}

/** Counts each step's uses: `Spacing.medium`, `LocalSpacing.current.medium`, `MaterialTheme.spacing.medium`, and for
 * `AppSpacing`, also `appSpacing.medium` and the last word's `spacing.medium`. */
function countUses(found: ScaleCandidate[], sources: KotlinSource[]): void {
  for (const candidate of found) {
    const owner = candidate.scale;
    const lastWord = /[A-Z][a-z\d]*$/.exec(owner)?.[0] ?? owner;
    const eitherCase = (word: string) =>
      `[${word.charAt(0).toUpperCase()}${word.charAt(0).toLowerCase()}]${escapeRegExp(word.slice(1))}`;
    const pattern = new RegExp(
      String.raw`\b\w*(?:${eitherCase(owner)}|${eitherCase(lastWord)})(?:\.current)?\.${escapeRegExp(candidate.step.name)}\b`,
      "g",
    );
    for (const source of sources)
      for (const _ of source.code.matchAll(pattern)) countUse(candidate.usedIn, source.rel);
  }
}
