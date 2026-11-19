/**
 * Spacing and corner radius scales declared in Kotlin: `dp` values an object or class of that name declares as its
 * own, `object Spacing { val medium = 12.dp }` or `data class AppSpacing(val medium: Dp = 12.dp)`, the second read
 * through a composition local (`LocalSpacing.current.medium`) or a theme extension (`MaterialTheme.spacing.medium`).
 */

import { countChains, indexBy, type ScaleCandidate, scaleKindOf } from "../scan/scales.js";
import { type KotlinSource, spanIn, treeOf } from "./kotlin-sources.js";
import { valueAt } from "./value-locations.js";

/** `object Spacing`, `data class AppSpacing(`, `class Radii`: a type that may hold a scale. */
const TYPE = /\b(object|class)\s+([A-Z]\w*)/g;
/** `val medium = 12.dp` or `val medium: Dp = 12.dp`, with the modifiers and annotations before it, the value ending
 * the declaration: not continued on the next line by `.` or `?:`. */
const STEP =
  /((?:@[\w.]+(?:\([^)\n]*\))?\s*|\b(?:private|protected|internal|public|override)\s+)*)\bval\s+(\w+)\s*(?::\s*Dp\s*)?=\s*(\d+(?:\.\d+)?\.dp)(?=[ \t]*(?:[,)};]|\n(?!\s*[.?])|$))/g;
/** Modifiers and annotations that keep a step out of the scale: private to its type, or deprecated. */
const HIDDEN = /\b(?:private|protected)\b|@Deprecated\b/;

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
        if (HIDDEN.test(step[1] ?? "")) continue;
        const value = step[3] ?? "";
        const valueStart = body.open + 1 + (step.index ?? 0) + step[0].lastIndexOf(value);
        // Only the type's own values, not one in a function or a nested type inside it.
        if (tree.enclosing[valueStart] !== body.open) continue;
        const span = spanIn(source, valueStart, valueStart + value.length);
        const name = step[2] ?? "";
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

const lowerFirst = (word: string) => word.charAt(0).toLowerCase() + word.slice(1);

/** Counts each step's uses: `Spacing.medium`, `LocalSpacing.current.medium`, and a theme's extension named for the
 * type or its last word, `MaterialTheme.spacing.medium` or `.appSpacing.medium` for `AppSpacing`. */
function countUses(found: ScaleCandidate[], sources: KotlinSource[]): void {
  if (found.length === 0) return;
  const index = indexBy(found, ({ scale: owner, step }) => {
    const lastWord = /[A-Z][a-z\d]*$/.exec(owner)?.[0] ?? owner;
    const named = [owner, lowerFirst(owner), lowerFirst(lastWord)].map((form) => `${form}|${step.name}`);
    return [...new Set([...named, `Local${owner}.current|${step.name}`])];
  });
  countChains(sources, (parts) => {
    const name = parts.at(-1) ?? "";
    const before = parts.at(-2) === "current" ? `${parts.at(-3)}.current` : parts.at(-2);
    return index.get(`${before}|${name}`);
  });
}
