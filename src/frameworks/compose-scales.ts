/**
 * Spacing and corner radius scales declared in Kotlin: `dp` values an object or class of that name declares as its
 * own, `object Spacing { val medium = 12.dp }` or `data class AppSpacing(val medium: Dp = 12.dp)`, the second read
 * through a composition local (`LocalSpacing.current.medium`) or a theme extension (`MaterialTheme.spacing.medium`).
 */

import {
  countChains,
  countUse,
  indexBy,
  type ScaleCandidate,
  scaleKindOf,
  stepKindOf,
} from "../scan/scales.js";
import { type KotlinSource, nearestTo, spanIn, treeOf } from "./kotlin-sources.js";
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
  const named = namedConstants(sources);
  countUses(found, sources);
  countNamedUses(named, sources);
  return [...found, ...named.map((d) => d.candidate)];
}

/** `val ThumbnailCornerRadius = 3.dp`, `val CardShape = RoundedCornerShape(12.dp)`: a constant whose value is a size
 * written whole, not continued (`.times(2)`, `?:`) or computed by a getter on the next line. */
const NAMED =
  /\bval\s+(\w+)\s*(?::\s*(?:Dp|Shape|RoundedCornerShape|CornerBasedShape|CornerSize)\s*)?=\s*((\d+(?:\.\d+)?)\.dp|(?:RoundedCornerShape|CornerSize)\(\s*(?:size\s*=\s*)?(\d+(?:\.\d+)?)\.dp\s*\))(?=[ \t]*(?:[,)};]|\n(?!\s*(?:[.?]|(?:@[\w.]+(?:\([^)\n]*\))?\s*)*get\b))|$))/g;
/** `companion object`, named or not: its members are read as its class's (`Theme.CardPadding`). */
const COMPANION = /\bcompanion\s+object\b(?:\s+\w+)?/g;
const PACKAGE = /^\s*package\s+([\w.]+)/m;
/** What a file imports: `import a.b.CardPadding`, `import a.b.*`. */
const IMPORT = /^\s*import\s+([\w.]+(?:\.\*)?)\s*$/gm;
/** A name being declared or given to a parameter or argument, not read: `val CardPadding = 4.dp`,
 * `CardPadding: Dp`, `Row(CardPadding = 2.dp)`. */
const DECLARED_AFTER = /\s*(?::|=(?!=))/y;
/** A name as code reads it, for counting uses of top-level constants. */
const WORD = /(?<![\w$.])[A-Za-z_]\w*(?![\w(])/g;

/** A constant, and the file and package it's declared in. */
interface Declared {
  candidate: ScaleCandidate;
  source: KotlinSource;
  pkg: string;
}

/** The constants whose own names say they're a spacing or a corner radius, at the top of a file or in an object's or
 * class's body, nested or a companion's, but not in a function, a scale's own type, or private. */
function namedConstants(sources: KotlinSource[]): Declared[] {
  const found: Declared[] = [];
  for (const source of sources) {
    if (!/\bval\b/.test(source.code)) continue;
    const tree = treeOf(source);
    const types = typeBodies(source);
    const pkg = PACKAGE.exec(source.code)?.[1] ?? "";
    for (const m of source.code.matchAll(NAMED)) {
      const declared = m.index ?? 0;
      if (HIDDEN.test(modifiersBefore(source, declared))) continue;
      const name = m[1] ?? "";
      const written = m[2] ?? "";
      const shape = m[4] !== undefined;
      const kind = shape ? "radius" : stepKindOf(name);
      if (!kind) continue;
      const owner = ownerPath(tree.enclosing[declared] ?? -1, tree, types);
      // In a function or a block, or in a type already read as a scale.
      if (owner === undefined || (owner !== "" && scaleKindOf(owner.split(".").at(-1) ?? ""))) continue;
      const valueStart = declared + m[0].lastIndexOf(written);
      const span = spanIn(source, valueStart, valueStart + written.length);
      const candidate: ScaleCandidate = {
        kind,
        scale: owner || source.rel,
        named: true,
        step: {
          name,
          value: Number(m[3] ?? m[4]),
          reference: owner ? `${owner}.${name}` : name,
          source: source.rel,
          line: span.line,
          location: valueAt(span, "expression"),
        },
        usedIn: new Map(),
      };
      found.push({ candidate, source, pkg });
    }
  }
  return found;
}

/** The modifiers and annotations a declaration at `at` has, and nothing of the one before it:
 * `@Deprecated("…")\nprivate` before `val`. Read backwards over just those words, so it costs their length. */
function modifiersBefore(source: KotlinSource, at: number): string {
  const { code } = source;
  let start = at;
  for (let words = 0; words < MAX_MODIFIERS; words++) {
    let i = start;
    while (i > 0 && /\s/.test(code[i - 1] ?? "")) i--;
    // An annotation's arguments: `@Deprecated("use another")`.
    if (code[i - 1] === ")") {
      const open = treeOf(source).openOf.get(i - 1);
      if (open === undefined) break;
      i = open;
    }
    let j = i;
    while (j > 0 && /[\w.]/.test(code[j - 1] ?? "")) j--;
    const word = code.slice(j, i);
    if (code[j - 1] === "@") j--;
    else if (!MODIFIERS.has(word)) break;
    start = j;
  }
  return code.slice(start, at);
}

/** The most modifiers and annotations a declaration is read with. */
const MAX_MODIFIERS = 12;
const MODIFIERS = new Set([
  "private",
  "protected",
  "internal",
  "public",
  "override",
  "const",
  "inline",
  "lateinit",
]);

/** Each object's and class's body by where its `{` opens, with the name its members are read through: a companion's
 * is its class's, so it has none of its own. */
function typeBodies(source: KotlinSource): Map<number, string> {
  const bodies = new Map<number, string>();
  for (const type of source.code.matchAll(TYPE)) {
    const open = braceOf(source, (type.index ?? 0) + type[0].length);
    if (open !== undefined) bodies.set(open, type[2] ?? "");
  }
  for (const companion of source.code.matchAll(COMPANION)) {
    const open = braceOf(source, (companion.index ?? 0) + companion[0].length);
    if (open !== undefined) bodies.set(open, "");
  }
  return bodies;
}

/** Where a type's `{` body opens, past a constructor and supertypes, over lines too: `class Metrics() {`,
 * `object M :\n  Base() {`. None when a declaration of its own, a `=` or a `;` comes first. */
function braceOf(source: KotlinSource, from: number): number | undefined {
  const { code } = source;
  const { closeOf } = treeOf(source);
  for (let i = from; i < Math.min(code.length, from + MAX_HEADER); i++) {
    const c = code[i];
    if (c === "{") return i;
    if (c === "(") i = closeOf.get(i) ?? i;
    else if (c === "=" || c === ";" || c === "}") return undefined;
    else if (c === "\n" && TYPE_DECLARATION.test(code.slice(i + 1, i + 120))) return undefined;
  }
  return undefined;
}

/** How far a type's header is read for its body. */
const MAX_HEADER = 1000;
/** What starts a declaration of its own after a bodyless type: `class Marker` then `object Brand {`. */
const TYPE_DECLARATION =
  /^\s*(?:@|(?:(?:private|internal|public|protected|data|enum|sealed|abstract|open|inner|override|companion)\s+)*(?:class|object|interface|val|var|fun)\b)/;

/** The objects and classes a declaration at the bracket `container` is in, outermost first (`Theme.Metrics`, `""` at
 * the top of the file), or none when one of the brackets around it is a function's or a block's. */
function ownerPath(
  container: number,
  tree: ReturnType<typeof treeOf>,
  types: Map<number, string>,
): string | undefined {
  const names: string[] = [];
  for (let open = container; open !== -1; open = tree.enclosing[open] ?? -1) {
    const name = types.get(open);
    if (name === undefined) return undefined;
    if (name) names.unshift(name);
  }
  return names.join(".");
}

/** Counts uses of named constants, in code without its imports: an object's member by its whole reference
 * (`Theme.Metrics.CardPadding`), and a top-level constant, or an imported member, by its name alone. Of several of a
 * name, the one in the reading file's package and module, else the one it imports. */
function countNamedUses(found: Declared[], sources: KotlinSource[]): void {
  if (found.length === 0) return;
  const byReference = new Map<string, Declared[]>();
  const byName = new Map<string, Declared[]>();
  for (const d of found) {
    const { reference, name } = d.candidate.step;
    byReference.set(reference, [...(byReference.get(reference) ?? []), d]);
    byName.set(name, [...(byName.get(name) ?? []), d]);
  }
  for (const source of sources) {
    const pkg = PACKAGE.exec(source.code)?.[1] ?? "";
    const imports = new Set([...source.code.matchAll(IMPORT)].map((m) => m[1] ?? ""));
    // Imports blanked: `import Metrics.CardPadding` says where a name is, it doesn't use it.
    const code = source.code.replace(IMPORT, (line) => " ".repeat(line.length));
    const use = (declared: Declared[] | undefined, imported: (d: Declared) => boolean) => {
      const target = declared && readFrom(declared, source, pkg, imported);
      if (target) countUse(target.candidate.usedIn, source.rel);
    };
    countChains([{ rel: source.rel, code }], (parts) => {
      const reference = parts.join(".");
      const declared = byReference.get(reference)?.filter((d) => d.candidate.step.reference.includes("."));
      if (!declared?.length) return undefined;
      use(declared, (d) => imports.has(`${d.pkg}.${parts[0]}`) || imports.has(`${d.pkg}.*`));
      return [];
    });
    for (const word of code.matchAll(WORD)) {
      const declared = byName.get(word[0]);
      if (!declared) continue;
      DECLARED_AFTER.lastIndex = (word.index ?? 0) + word[0].length;
      if (DECLARED_AFTER.test(code)) continue;
      // A member is read by its name alone where it's imported (`import a.Metrics.CardPadding`).
      const readable = declared.filter(
        (d) => !d.candidate.step.reference.includes(".") || imports.has(qualified(d)),
      );
      use(
        readable,
        (d) =>
          imports.has(qualified(d)) ||
          (!d.candidate.step.reference.includes(".") && imports.has(`${d.pkg}.*`)),
      );
    }
  }
}

/** A constant's whole name: `a.Metrics.CardPadding`, or `CARD_PADDING` in no package. */
const qualified = (d: Declared) =>
  d.pkg ? `${d.pkg}.${d.candidate.step.reference}` : d.candidate.step.reference;

/** Of the constants of a reference, the one a file reads: its own package's, nearest by module, then the one it
 * imports. */
function readFrom(
  declared: Declared[],
  source: KotlinSource,
  pkg: string,
  imported: (d: Declared) => boolean,
): Declared | undefined {
  // An app's phone and TV modules may share a package: the reading file's own module's.
  const own = nearestTo(
    declared.filter((d) => d.pkg === pkg),
    source,
    (d) => d.source,
  );
  if (own) return own;
  const from = declared.filter(imported);
  return from.length === 1 ? from[0] : undefined;
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
