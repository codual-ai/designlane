/**
 * The spacing and corner radius scales an app's code names (`enum AppSpacing { static let large: CGFloat = 16 }`,
 * `export const spacing = { md: 12 }`), which every framework's reader finds as candidates and this file keeps or
 * drops by one set of rules. Values written in place (`.padding(16)`) never make a scale: they change whenever a
 * screen's layout does, so they stay in DESIGN.md.
 */

import type { NamedScales, ScaleStep } from "./types.js";

export type ScaleKind = "spacing" | "radius";

/** One step a reader found, and the files using it by name with how many times each. */
export interface ScaleCandidate {
  kind: ScaleKind;
  /** The scale it belongs to (`AppSpacing`, `theme.spacing`): steps are kept or dropped a whole scale at a time. */
  scale: string;
  step: Omit<ScaleStep, "uses">;
  usedIn: Map<string, number>;
  /** Its kind is its own name's (`ThumbnailCornerRadius`, `layoutPadding`), not its container's: it's kept on its own
   * when code outside its file uses it, however few steps its container has. */
  named?: boolean;
}

/** A name holding a corner radius scale: `CornerRadius`, `AppCornerRadius`, `radii`, `borderRadius`, `Corners`. */
const RADIUS_NAME = /(?:radius|radii|radiuses|corners?|rounded|rounding)$/i;
/** A name holding a spacing scale: `Spacing`, `AppSpacing`, `space`, `Padding`, `Insets`, `Margins`, `Gaps`. */
const SPACING_NAME = /(?:spacings?|spaces?|paddings?|insets?|margins?|gaps?|gutters?)$/i;
/** Names ending like a scale that aren't one. */
const NOT_A_SCALE = /(?:namespace|workspace|colou?rspace|keyspace|whitespace)$/i;

/** The kind of scale a container's name holds, `CornerRadius` a radius one and `Spacing` a spacing one, or none. */
export function scaleKindOf(name: string): ScaleKind | undefined {
  // `CARD_PADDING` is one screen's constant, not a scale a design system names.
  if (NOT_A_SCALE.test(name) || name.includes("_")) return undefined;
  if (RADIUS_NAME.test(name)) return "radius";
  if (SPACING_NAME.test(name)) return "spacing";
  return undefined;
}

/** The words of a name that say what a constant is: `ThumbnailCornerRadius`, `layoutPadding`, `ROW_PADDING_HORIZONTAL`. */
const SPACING_WORDS = new Set([
  "padding",
  "paddings",
  "spacing",
  "spacings",
  "margin",
  "margins",
  "gap",
  "gaps",
  "inset",
  "insets",
  "gutter",
]);
const RADIUS_WORDS = new Set(["radius", "radii", "corner", "corners"]);

/** A name's words, lowercase: `FABPadding` is `fab padding`, `ROW_PADDING_HORIZONTAL` is `row padding horizontal`.
 * Read a letter at a time, so a long name costs its length. */
function wordsOf(name: string): string[] {
  const words: string[] = [];
  let word = "";
  const upper = (c: string | undefined) => c !== undefined && c >= "A" && c <= "Z";
  const lower = (c: string | undefined) =>
    c !== undefined && ((c >= "a" && c <= "z") || (c >= "0" && c <= "9"));
  for (let i = 0; i < name.length; i++) {
    const c = name[i] ?? "";
    // A new word at `_`, at `aB`, and at `ABc`'s `B`: `FABPadding`'s `P`.
    const starts =
      c === "_" || (upper(c) && (lower(name[i - 1]) || (upper(name[i - 1]) && lower(name[i + 1]))));
    if (starts && word) words.push(word.toLowerCase());
    if (starts) word = "";
    if (c !== "_") word += c;
  }
  if (word) words.push(word.toLowerCase());
  return words;
}

/** A size's word in a constant's name: `rowHeight`, `iconSize`, `shadowRadius`, but not `OutlinedButtonPadding`. */
const SIZE_WORDS = new Set([
  "height",
  "width",
  "size",
  "shadow",
  "blur",
  "offset",
  "opacity",
  "alpha",
  "duration",
  "scale",
  "line",
  "border",
  // A time or a ratio named like a margin or gap: `playbackRangeMarginSeconds`, `driftScoreDominanceGap`.
  "seconds",
  "second",
  "ms",
  "millis",
  "interval",
  "delay",
  "time",
  "score",
  "ratio",
  "percent",
  "factor",
]);

/** Whether a constant named for its kind is a size of another sort, by its words: `borderRadius` is a corner's. */
function namesAnotherSize(name: string): boolean {
  const words = wordsOf(name);
  return words.some((w) => SIZE_WORDS.has(w) && !(w === "border" && words.includes("radius")));
}

/** A round thing's radius, which a name alone can't tell from a corner's: `currentTimeDotRadius`, `rippleRadius`. A
 * scale may still have a `circle` step: this is for a constant named on its own. */
const NOT_A_CORNER = /dot|circle|ripple|glow|knob/i;

/** The kind of size a constant's own name says it is, or none: `ThumbnailCornerRadius` a radius, `TabTopPadding`
 * a spacing, `rowHeight` or `shadowRadius` neither. */
export function stepKindOf(name: string): ScaleKind | undefined {
  // A retired or a size-named one (`shadowRadius`, `rowHeight`) is left out with every scale's.
  const words = wordsOf(name);
  if (words.some((w) => RADIUS_WORDS.has(w))) return NOT_A_CORNER.test(name) ? undefined : "radius";
  if (words.some((w) => SPACING_WORDS.has(w))) return "spacing";
  return undefined;
}

/** A step's name that says the code no longer wants it used: `'lg (Deprecated)'`, `legacyLarge`. */
const RETIRED = /deprecated|legacy|unused/i;

/** A step's name that says it's a size, not a spacing or radius: `rowHeight`, `shadowRadius`, `iconSize`. */
const NOT_A_STEP = /height|width|size|shadow|blur|offset|opacity|alpha|duration|scale|line|border(?!radius)/i;

/** Fewer steps than this is a pair of constants, not a scale. */
const MIN_STEPS = 2;

/**
 * The scales among `candidates`, each smallest first. A scale is kept when it has at least two steps and code outside
 * the file declaring it uses one of them by name: that's what tells a design system's scale from one screen's own
 * constants (`struct CardLayout { static let padding = 16 }` inside a view). A step the code marks deprecated is left out.
 */
export function namedScales(candidates: ScaleCandidate[]): NamedScales | undefined {
  const byScale = new Map<string, ScaleCandidate[]>();
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const { name, value } = candidate.step;
    // A constant named on its own is a size in points or pixels, whole or half: `1.1` or `0.25` is a factor or an em.
    const another = candidate.named
      ? namesAnotherSize(name) || !Number.isInteger(value * 2)
      : NOT_A_STEP.test(name);
    if (RETIRED.test(name) || another || value < 0) continue;
    const id = `${candidate.kind}|${candidate.step.source}|${candidate.scale}`;
    const steps = byScale.get(id) ?? [];
    byScale.set(id, steps);
    // The same name declared twice in one scale (`#if os(iOS)` branches) is the first one.
    const key = `${id}|${name}`;
    if (!seen.has(key)) {
      seen.add(key);
      steps.push(candidate);
    }
  }
  const found: NamedScales = { spacing: [], radii: [] };
  for (const steps of byScale.values()) {
    const [first] = steps;
    if (!first) continue;
    const elsewhere = (s: ScaleCandidate) => [...s.usedIn.keys()].some((file) => file !== s.step.source);
    // A constant named for its kind stands on its own; a container's steps are a scale together.
    const chosen = first.named
      ? steps.filter(elsewhere)
      : steps.length >= MIN_STEPS && steps.some(elsewhere)
        ? steps
        : [];
    const kept = chosen.map(({ step, usedIn }) => ({
      ...step,
      uses: [...usedIn.values()].reduce((sum, n) => sum + n, 0),
    }));
    (first.kind === "radius" ? found.radii : found.spacing).push(...kept);
  }
  // Two scales declaring the same reference (an app's and its widget's copy) are one: the first found stays.
  const distinct = (steps: ScaleStep[]) => {
    const references = new Set<string>();
    return steps
      .filter((step) => !references.has(step.reference) && references.add(step.reference))
      .sort((a, b) => a.value - b.value || a.reference.localeCompare(b.reference));
  };
  const scales = { spacing: distinct(found.spacing), radii: distinct(found.radii) };
  return scales.spacing.length || scales.radii.length ? scales : undefined;
}

/** `{ scales }` to spread into an app's tokens, or nothing when the code names no scale. */
export const withScales = (scales: NamedScales | undefined): { scales?: NamedScales } =>
  scales ? { scales } : {};

/** Adds one use of a step in `file`. */
export function countUse(usedIn: Map<string, number>, file: string): void {
  usedIn.set(file, (usedIn.get(file) ?? 0) + 1);
}

/** The most names of a chain a step's use is looked for in: a use is a few names long (`Theme.CornerRadius.card`),
 * and looking further would make a long chain (`a.b.c…`, thousands long) cost its length squared. */
const MAX_CHAIN_PARTS = 6;

/** A chain of names, `AppSpacing.large` or `LocalSpacing.current.medium`, not one continuing another (`a.b`'s `b`). */
const CHAIN = /(?<![\w$.])[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+/g;

/**
 * Counts uses of steps in one pass over each file: every chain of names in `code` (comments and strings blanked), and
 * each of its leading parts of two names or more, is given to `stepsAt`, and the steps the first part it knows names
 * get one use each. Linear in the code's length, however many steps there are.
 */
export function countChains(
  sources: { rel: string; code: string }[],
  stepsAt: (parts: string[]) => ScaleCandidate[] | undefined,
): void {
  for (const source of sources) {
    for (const chain of source.code.matchAll(CHAIN)) {
      const parts = chain[0].split(".", MAX_CHAIN_PARTS);
      for (let length = parts.length; length >= 2; length--) {
        const steps = stepsAt(parts.slice(0, length));
        if (!steps) continue;
        for (const step of steps) countUse(step.usedIn, source.rel);
        break;
      }
    }
  }
}

/** Candidates grouped by a key, for `countChains` to look up. */
export function indexBy(
  candidates: ScaleCandidate[],
  keys: (candidate: ScaleCandidate) => string[],
): Map<string, ScaleCandidate[]> {
  const index = new Map<string, ScaleCandidate[]>();
  for (const candidate of candidates) {
    for (const key of keys(candidate)) {
      const same = index.get(key);
      if (same) same.push(candidate);
      else index.set(key, [candidate]);
    }
  }
  return index;
}
