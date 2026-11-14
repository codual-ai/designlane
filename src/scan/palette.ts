/**
 * Turns every colour a framework plugin found into the app's palette, built for apps whose palette was never
 * written down: colours are ranked by how often the code uses them, near-identical shades are merged, and pasted
 * copies of a named colour count as uses of that colour.
 */

import { byText, mostCommon } from "./counting.js";
import type { ColorLocations, ColorToken, DesignTokens } from "./types.js";

/** A colour the app gives a name: an asset catalog entry or a constant in code. */
export interface NamedColor {
  name: string;
  light: string;
  dark?: string;
  /** The file it was defined in. */
  source: string;
  /** How the code refers to it: `Theme.surface`, `Color("Brand")`. */
  reference: string;
  /** The line it's declared on, for a colour declared in code. */
  line?: number;
  kind: "asset" | "code";
  locations?: ColorLocations;
}

export interface ColorFindings {
  named: NamedColor[];
  /** Each place the code uses a named colour: its name, and how the code referred to it when that says which colour
   * (`Color("Brand")`, `Theme.brand`) rather than just a name (`.brand`). */
  references: { name: string; reference?: string }[];
  /** Each colour value written without a name, as `#rrggbb[aa]`, with the file it's in. */
  literals: { hex: string; file: string }[];
  /** Each use of a platform colour (`.red`, `.systemBackground`) by name. */
  system: string[];
  /** The app's themes beside the default one, whose colours are in `named`. */
  themes?: ThemeFindings[];
}

/** A colour of a theme beside the default one. */
export interface ThemeColor extends NamedColor {
  /** The reference of the default theme's colour in the same place (`themes.light.bg` for `themes.black.bg`), whose
   * uses it shares, since the code reaches whichever theme is chosen the same way; missing when that's its own
   * reference (`ColorSet.tint` in every SwiftUI theme), or there's none. */
  role?: string;
}

export interface ThemeFindings {
  name: string;
  colors: ThemeColor[];
}

/** Colours this close (distance between their RGBA values, out of 255) are one colour written twice. */
const SAME_COLOR = 8;
type Palette = Pick<DesignTokens, "colors" | "systemColors" | "themes">;

export function palette(found: ColorFindings): Palette {
  const named = distinctNamed(found.named).map((c): ColorToken => ({ ...c, uses: 0 }));
  const byName = new Map<string, ColorToken[]>();
  for (const color of named) {
    const sameName = byName.get(nameKey(color.name)) ?? [];
    byName.set(nameKey(color.name), sameName);
    sameName.push(color);
  }
  const { exact, partial } = referenceIndex(named);
  for (const { name, reference } of found.references) {
    // `Theme.surface` names its colour exactly; `Dark.edge` names `Palette.Dark.edge` by its end; a bare `.edge` goes
    // to the first colour of that name.
    const meant = reference ? (exact.get(reference) ?? partial.get(reference)) : undefined;
    const color = meant ?? byName.get(nameKey(name))?.[0];
    if (color) color.uses++;
  }
  const firstFile = new Map<string, string>();
  for (const { hex, file } of found.literals) if (!firstFile.has(hex)) firstFile.set(hex, file);
  const namedGrid = new ColorGrid(named);
  const unnamed = new ColorGrid([]);
  for (const { value: hex, count } of mostCommon(
    found.literals.map((l) => l.hex),
    byText,
  )) {
    const match = namedGrid.closest(hex) ?? unnamed.closest(hex);
    if (match) match.uses += count;
    else
      unnamed.add({ name: hex, light: hex, source: firstFile.get(hex) ?? "", kind: "inline", uses: count });
  }
  const ranked = [...named, ...unnamed.colors].sort((a, b) => b.uses - a.uses);
  const themes = (found.themes ?? [])
    .filter((theme) => theme.colors.length > 0)
    .map(({ name, colors }) => ({
      name,
      colors: distinctNamed(colors)
        .map(
          ({ role, ...color }): ColorToken => ({
            ...color,
            uses: exact.get(role ?? color.reference)?.uses ?? 0,
          }),
        )
        .sort((a, b) => b.uses - a.uses),
    }));
  return {
    colors: ranked,
    systemColors: mostCommon(found.system, byText).map(({ value, count }) => ({ name: value, uses: count })),
    ...(themes.length > 0 ? { themes } : {}),
  };
}

/** Each colour by its reference, and by every dotted end of it (`Dark.edge` for `Palette.Dark.edge`), first come
 * first served, so crediting a use is one lookup however many colours share a name. */
function referenceIndex(colors: ColorToken[]) {
  const exact = new Map<string, ColorToken>();
  const partial = new Map<string, ColorToken>();
  for (const color of colors) {
    if (!color.reference) continue;
    if (!exact.has(color.reference)) exact.set(color.reference, color);
    // Only a member path (`Palette.Dark.edge`) has ends a use can name; `Color("a.b")` is one name.
    if (color.reference.includes("(")) continue;
    const parts = color.reference.split(".");
    for (let i = 1; i < parts.length - 1; i++) {
      const end = parts.slice(i).join(".");
      if (!partial.has(end)) partial.set(end, color);
    }
  }
  return { exact, partial };
}

/** `Brand`, `brand` and `brand-color` are one name; generated accessors change the case of asset names. */
export const nameKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/** One entry per reference and value: `Theme.surface` and `Color("surface")` stay two colours even with one value. */
function distinctNamed<T extends NamedColor>(colors: T[]): T[] {
  const seen = new Set<string>();
  return colors.filter((c) => {
    const key = `${c.reference}|${c.light}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface Entry {
  color: ColorToken;
  rgba: number[];
  order: number;
}

/**
 * Colours bucketed by their channels, so finding the closest colour within `SAME_COLOR` only checks neighbouring
 * buckets. Each bucket keeps one colour per value (the first), so thousands of identical colours stay fast too.
 */
class ColorGrid {
  readonly colors: ColorToken[] = [];
  private readonly buckets = new Map<string, Map<string, Entry>>();

  constructor(colors: ColorToken[]) {
    for (const color of colors) this.add(color);
  }

  add(color: ColorToken): void {
    const rgba = channels(color.light);
    const key = bucketOf(rgba).join(",");
    const bucket = this.buckets.get(key) ?? new Map<string, Entry>();
    if (!bucket.has(color.light)) bucket.set(color.light, { color, rgba, order: this.colors.length });
    this.buckets.set(key, bucket);
    this.colors.push(color);
  }

  /** The closest colour within `SAME_COLOR` of `hex`; on a tie, the one added first. */
  closest(hex: string): ColorToken | undefined {
    const target = channels(hex);
    let best: (Entry & { distance: number }) | undefined;
    for (const key of neighbours(bucketOf(target))) {
      for (const entry of this.buckets.get(key)?.values() ?? []) {
        const d = distance(entry.rgba, target);
        if (d > SAME_COLOR) continue;
        if (!best || d < best.distance || (d === best.distance && entry.order < best.order)) {
          best = { ...entry, distance: d };
        }
      }
    }
    return best?.color;
  }
}

const bucketOf = (rgba: number[]) => rgba.map((v) => Math.floor(v / SAME_COLOR));

/** The bucket keys within one step of `bucket` on every channel: 3⁴ of them. */
function neighbours(bucket: number[]): string[] {
  let keys: number[][] = [[]];
  for (const v of bucket) keys = keys.flatMap((k) => [v - 1, v, v + 1].map((n) => [...k, n]));
  return keys.map((k) => k.join(","));
}

const distance = (a: number[], b: number[]) => Math.hypot(...a.map((v, i) => v - (b[i] ?? 0)));

/** `#rrggbb[aa]` as [r, g, b, a], 0–255. */
const channels = (hex: string) =>
  [1, 3, 5, 7].map((i) => (i === 7 && hex.length < 9 ? 255 : Number.parseInt(hex.slice(i, i + 2), 16)));
