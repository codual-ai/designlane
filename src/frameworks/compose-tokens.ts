/** A Compose app's design tokens: colours, type scale and fonts, spacing and corner radii. */

import { byNumber, mostCommon } from "../scan/counting.js";
import { palette } from "../scan/palette.js";
import { namedScales, withScales } from "../scan/scales.js";
import { appFirst } from "../scan/targets.js";
import { typeScale } from "../scan/type-scale.js";
import type { DesignTokens } from "../scan/types.js";
import { RESOURCE_FILE, resourceColors } from "./android-resources.js";
import { textAppearances } from "./android-text-appearances.js";
import { composeColors } from "./compose-colors.js";
import { composeScaleCandidates } from "./compose-scales.js";
import { composeType } from "./compose-type.js";
import { callArguments, Spans } from "./kotlin-calls.js";
import type { KotlinSource } from "./kotlin-sources.js";
import { SYSTEM } from "./material-type.js";
import type { ScanContext } from "./plugin.js";

/** Calls whose `dp` values are spacing: padding, the gaps between items, and spacers' sizes. */
export const SPACING_CALL = /(?<!\w)(?:padding|spacedBy|Spacer|PaddingValues)\s*\(/g;
/** Resource files holding colours, text appearances or the dimensions they read. */
const READ_RESOURCES = /<(?:color|style|dimen)\b/;
export const RADIUS_CALL = /(?<!\w)RoundedCornerShape\s*\(/g;
const DP = /(?<![\w.])(\d+(?:\.\d+)?)\.dp\b/g;
/** Generic families stand for a platform font, not one a designer installs. */
const GENERIC_FAMILY = /^(?:Serif|Monospace|Cursive)$/;

/** Each `dp` number inside a call `pattern` finds in one file, with where it's written (`16.dp`); a number inside
 * nested calls counts once. */
export function* dpInCallsOf(
  source: KotlinSource,
  pattern: RegExp,
): Generator<{ value: number; start: number; end: number }> {
  const calls = new Spans();
  for (const m of source.code.matchAll(pattern)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const { close } = callArguments(source, open);
    if (close > open) calls.add(open, close);
  }
  calls.start();
  for (const dp of source.code.matchAll(DP)) {
    const value = Number(dp[1]);
    const start = dp.index ?? 0;
    if (value > 0 && calls.contains(start)) yield { value, start, end: start + dp[0].length };
  }
}

/** The `dp` numbers inside the calls `pattern` finds, most common first. */
function dpInCalls(sources: KotlinSource[], pattern: RegExp): number[] {
  const values = sources.flatMap((source) => [...dpInCallsOf(source, pattern)].map((dp) => dp.value));
  return mostCommon(values, byNumber).map(({ value }) => value);
}

export async function composeTokens(ctx: ScanContext, all: KotlinSource[]): Promise<DesignTokens> {
  // Where a colour or style is declared twice, the app's own copy comes first, over a Wear or TV module's.
  const sources = appFirst(all, (s) => s.rel);
  const xml: { rel: string; text: string }[] = [];
  for (const f of ctx.files.filter((f) => RESOURCE_FILE.test(f.rel))) {
    const text = await ctx.read(f);
    if (text && READ_RESOURCES.test(text)) xml.push({ rel: f.rel, text });
  }
  const ui = sources.filter((s) => s.compose);
  const appearances = textAppearances(
    xml,
    sources.map((s) => s.code),
  );
  const type = composeType(sources);
  const inline = typeScale(type);
  const fonts = [
    ...new Set([...[...type.named, ...appearances].map((s) => s.family), ...inline.fonts]),
  ].filter((f) => f && f !== SYSTEM && !GENERIC_FAMILY.test(f));
  return {
    ...palette(composeColors(sources, resourceColors(xml))),
    typeStyles: [...type.named, ...appearances, ...inline.typeStyles].sort(
      (a, b) => b.uses - a.uses || a.name.localeCompare(b.name),
    ),
    fonts,
    spacing: dpInCalls(ui, SPACING_CALL),
    radii: dpInCalls(ui, RADIUS_CALL),
    ...withScales(namedScales(composeScaleCandidates(sources))),
  };
}
