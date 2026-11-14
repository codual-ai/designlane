/** Tailwind's CSS: whether a stylesheet brings Tailwind in, and the colours and font families its `@theme` names. */

import type { NamedColor } from "../scan/palette.js";
import { appFirst } from "../scan/targets.js";
import type { ValueLocation } from "../scan/types.js";
import { colorOf } from "./css-color.js";
import type { ScanContext } from "./plugin.js";
import { locator } from "./source-text.js";
import { valueAt } from "./value-locations.js";

const CSS = /\.css$/;
/** A colour variable in a CSS `@theme`: `--color-charcoal-500: #7d7d7d;`. */
const CSS_COLOR = /--color-([\w-]+)\s*:\s*([^;]+);/g;
/** A block whose variables are the dark scheme's. */
const DARK_BLOCK =
  /(?:@media[^{]*prefers-color-scheme:\s*dark[^{]*|\.dark\b[^{]*|\[data-theme=["']?dark["']?\][^{]*|@variant\s+dark[^{]*)\{/g;
const CSS_COMMENT = /\/\*[\s\S]*?\*\//g;
/** A font family in a CSS `@theme`: `--font-inter: "Inter", sans-serif;`, or v3-style `--font-family-sans`. */
const CSS_FONT = /--font-(?:family-)?([\w-]+)\s*:\s*([^;]+);/g;

/** Whether a stylesheet brings Tailwind in (`@import "tailwindcss"`, `@tailwind base`), and the families its
 * `@theme` names. */
export async function readCss(
  ctx: ScanContext,
): Promise<{ imports: boolean; fonts: Record<string, string> }> {
  let imports = false;
  const fonts: Record<string, string> = {};
  for (const file of appFirst(ctx.files, (f) => f.rel).filter((f) => CSS.test(f.rel))) {
    const text = (await ctx.read(file))?.replace(CSS_COMMENT, "");
    if (!text) continue;
    if (/@import\s+["']tailwindcss|@tailwind\s/.test(text)) imports = true;
    for (const m of text.matchAll(CSS_FONT)) if (m[1] && m[2] && !(m[1] in fonts)) fonts[m[1]] = m[2].trim();
  }
  return { imports, fonts };
}

/** The colours CSS `@theme` blocks name, `--color-*`, with the values a dark block gives them; commented-out
 * declarations aren't read. */
export async function cssColors(ctx: ScanContext): Promise<NamedColor[]> {
  const out = new Map<string, NamedColor>();
  const darkValues = new Map<string, { value: string; location: ValueLocation }>();
  for (const file of appFirst(ctx.files, (f) => f.rel).filter((f) => CSS.test(f.rel))) {
    const raw = await ctx.read(file);
    if (!raw?.includes("--color-")) continue;
    // Comments blanked to spaces, keeping every offset and line where it was.
    const text = raw.replace(CSS_COMMENT, (c) => c.replace(/[^\n]/g, " "));
    const dark = darkSpans(text);
    const span = locator(file.rel, text);
    for (const m of text.matchAll(CSS_COLOR)) {
      const [name, written] = [m[1] ?? "", m[2] ?? ""];
      const value = colorOf(written, true);
      const at = m.index ?? 0;
      if (!value) continue;
      // The value runs from after the `:` and its spaces to the `;`, less the spaces before it.
      const start = at + m[0].length - 1 - written.length;
      const location = valueAt(span(start, start + written.trimEnd().length), "literal");
      if (dark.some(([open, close]) => at > open && at < close)) {
        if (!darkValues.has(name)) darkValues.set(name, { value, location });
        continue;
      }
      if (!out.has(name))
        out.set(name, {
          name,
          light: value,
          source: file.rel,
          reference: name,
          line: location.line,
          kind: "code",
          locations: { light: location },
        });
    }
  }
  return [...out.values()].map((c) => {
    const dark = darkValues.get(c.name);
    if (!dark) return c;
    return {
      ...c,
      ...(dark.value !== c.light && { dark: dark.value }),
      locations: { ...c.locations, dark: dark.location },
    };
  });
}

/** The spans of the blocks in a stylesheet that hold the dark scheme's values. */
function darkSpans(text: string): [number, number][] {
  return [...text.matchAll(DARK_BLOCK)].map((m) => {
    const open = (m.index ?? 0) + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) return [open, i] as [number, number];
    }
    return [open, text.length] as [number, number];
  });
}
