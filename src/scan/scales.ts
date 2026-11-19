/**
 * The spacing and corner radius scales an app's code names (`enum WMFSpacing { static let large: CGFloat = 16 }`,
 * `export const spacing = { md: 12 }`), which every framework's reader finds as candidates and this file keeps or
 * drops by one set of rules. Values written in place (`.padding(16)`) never make a scale: they change whenever a
 * screen's layout does, so they stay in DESIGN.md.
 */

import type { NamedScales, ScaleStep } from "./types.js";

export type ScaleKind = "spacing" | "radius";

/** One step a reader found, and the files using it by name with how many times each. */
export interface ScaleCandidate {
  kind: ScaleKind;
  /** The scale it belongs to (`WMFSpacing`, `theme.spacing`): steps are kept or dropped a whole scale at a time. */
  scale: string;
  step: Omit<ScaleStep, "uses">;
  usedIn: Map<string, number>;
}

/** A name holding a corner radius scale: `CornerRadius`, `WMFCornerRadius`, `radii`, `borderRadius`, `Corners`. */
const RADIUS_NAME = /(?:radius|radii|radiuses|corners?|rounded|rounding)$/i;
/** A name holding a spacing scale: `Spacing`, `AppSpacing`, `space`, `Padding`, `Insets`, `Margins`, `Gaps`. */
const SPACING_NAME = /(?:spacings?|spaces?|paddings?|insets?|margins?|gaps?|gutters?)$/i;
/** Names ending like a scale that aren't one. */
const NOT_A_SCALE = /(?:namespace|workspace|colou?rspace|keyspace|whitespace)$/i;

/** The kind of scale a container's name holds, `CornerRadius` a radius one and `Spacing` a spacing one, or none. */
export function scaleKindOf(name: string): ScaleKind | undefined {
  // `HOME_PADDING` is one screen's constant, not a scale a design system names.
  if (NOT_A_SCALE.test(name) || name.includes("_")) return undefined;
  if (RADIUS_NAME.test(name)) return "radius";
  if (SPACING_NAME.test(name)) return "spacing";
  return undefined;
}

/** A step's name that says the code no longer wants it used: `'15px (Deprecated)'`, `legacyLarge`. */
const RETIRED = /deprecated|legacy|unused/i;

/** A step's name that says it's a size, not a spacing or radius: `buttonHeight`, `cardShadowRadius`, `iconSize`. */
const NOT_A_STEP = /height|width|size|shadow|blur|offset|opacity|alpha|duration|scale|line|border(?!radius)/i;

/** Fewer steps than this is a pair of constants, not a scale. */
const MIN_STEPS = 2;

/**
 * The scales among `candidates`, each smallest first. A scale is kept when it has at least two steps and code outside
 * the file declaring it uses one of them by name: that's what tells a design system's scale from one screen's own
 * constants (`struct UX { static let padding = 16 }` inside a view). A step the code marks deprecated is left out.
 */
export function namedScales(candidates: ScaleCandidate[]): NamedScales | undefined {
  const byScale = new Map<string, ScaleCandidate[]>();
  for (const candidate of candidates) {
    const { name, value } = candidate.step;
    if (RETIRED.test(name) || NOT_A_STEP.test(name) || value < 0) continue;
    const id = `${candidate.kind}|${candidate.step.source}|${candidate.scale}`;
    const steps = byScale.get(id) ?? [];
    byScale.set(id, steps);
    // The same name declared twice in one scale (`#if os(iOS)` branches) is the first one.
    if (!steps.some((s) => s.step.name === candidate.step.name)) steps.push(candidate);
  }
  const found: NamedScales = { spacing: [], radii: [] };
  for (const steps of byScale.values()) {
    const [first] = steps;
    if (!first || steps.length < MIN_STEPS) continue;
    const usedElsewhere = steps.some((s) => [...s.usedIn.keys()].some((file) => file !== s.step.source));
    if (!usedElsewhere) continue;
    const kept = steps.map(({ step, usedIn }) => ({
      ...step,
      uses: [...usedIn.values()].reduce((sum, n) => sum + n, 0),
    }));
    (first.kind === "radius" ? found.radii : found.spacing).push(...kept);
  }
  // Two scales declaring the same reference (an app's and its widget's copy) are one: the first found stays.
  const distinct = (steps: ScaleStep[]) =>
    steps
      .filter((step, i) => steps.findIndex((s) => s.reference === step.reference) === i)
      .sort((a, b) => a.value - b.value || a.reference.localeCompare(b.reference));
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

/** `text` safe to put in a regular expression as it is. */
export const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
