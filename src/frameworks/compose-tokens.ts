/** A Compose app's design tokens: colours, type scale and fonts, spacing and corner radii. */

import { byNumber, mostCommon } from "../scan/counting.js";
import { palette } from "../scan/palette.js";
import { appFirst } from "../scan/targets.js";
import { typeScale } from "../scan/type-scale.js";
import type { DesignTokens } from "../scan/types.js";
import { RESOURCE_FILE, resourceColors } from "./android-resources.js";
import { textAppearances } from "./android-text-appearances.js";
import { composeColors } from "./compose-colors.js";
import { composeType } from "./compose-type.js";
import { callArguments, Spans } from "./kotlin-calls.js";
import type { KotlinSource } from "./kotlin-sources.js";
import { SYSTEM } from "./material-type.js";
import type { ScanContext } from "./plugin.js";

/** Calls whose `dp` values are spacing: padding, the gaps between items, and spacers' sizes. */
const SPACING_CALL = /(?<!\w)(?:padding|spacedBy|Spacer|PaddingValues)\s*\(/g;
/** Resource files holding colours, text appearances or the dimensions they read. */
const READ_RESOURCES = /<(?:color|style|dimen)\b/;
const RADIUS_CALL = /(?<!\w)RoundedCornerShape\s*\(/g;
const DP = /(?<![\w.])(\d+(?:\.\d+)?)\.dp\b/g;
/** Generic families stand for a platform font, not one a designer installs. */
const GENERIC_FAMILY = /^(?:Serif|Monospace|Cursive)$/;

/** The `dp` numbers inside the calls `pattern` finds, most common first; a number inside nested calls counts once. */
function dpInCalls(sources: KotlinSource[], pattern: RegExp): number[] {
  const values: number[] = [];
  for (const source of sources) {
    const calls = new Spans();
    for (const m of source.code.matchAll(pattern)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      const { close } = callArguments(source, open);
      if (close > open) calls.add(open, close);
    }
    calls.start();
    for (const dp of source.code.matchAll(DP)) {
      const n = Number(dp[1]);
      if (n > 0 && calls.contains(dp.index ?? 0)) values.push(n);
    }
  }
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
  };
}
