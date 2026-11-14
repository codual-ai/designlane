import { z } from "zod";
import type { NamedColor } from "../scan/palette.js";
import { rgbToHex } from "../scan/tokens.js";
import type { ValueLocation } from "../scan/types.js";
import { locator } from "./source-text.js";
import { valueAt } from "./value-locations.js";

const COLORSET = /([^/]+)\.colorset\/Contents\.json$/;

export const isColorset = (rel: string) => COLORSET.test(rel);

const Colorset = z.object({
  colors: z
    .array(
      z.object({
        appearances: z.array(z.object({ appearance: z.string(), value: z.string() })).optional(),
        color: z.object({ components: z.record(z.string(), z.string()).optional() }).optional(),
      }),
    )
    .optional(),
});

/** Asset-catalog components (RGB channels, or a grayscale `white` value) as `#rrggbb[aa]`, or undefined when a
 * channel can't be read (empty, `0x` with no digits, text). */
function componentsToHex(c: Record<string, string>): string | undefined {
  // Xcode always writes opacity as a decimal (`1.000`), whatever format the colour channels use.
  const alpha = c.alpha === undefined ? 1 : Number(c.alpha);
  const channels =
    c.white !== undefined && c.red === undefined
      ? [c.white, c.white, c.white].map(component)
      : [c.red, c.green, c.blue].map((v) => component(v ?? "0"));
  const [r, g, b] = channels;
  if (r === undefined || g === undefined || b === undefined || !Number.isFinite(alpha)) return undefined;
  return rgbToHex(r, g, b, alpha);
}

/** A channel in one of Xcode's three input formats, as 0–1: hexadecimal (`0xFF`), floating point (`1.000`), or
 * 8-bit (`255`, a whole number). The format, not the size, decides: `1` is 8-bit, so 1/255. */
function component(value: string): number | undefined {
  const n = /^0x[0-9a-f]+$/i.test(value) ? Number.parseInt(value, 16) / 255 : readNumber(value);
  return Number.isFinite(n) ? n : undefined;
}

/** A decimal (`1.000`) as itself, a whole number (`255`) as 8-bit; anything else is not a number. */
const readNumber = (value: string) =>
  /^-?\d+$/.test(value) ? Number(value) / 255 : /^-?\d*\.\d+$/.test(value) ? Number(value) : Number.NaN;

/** An Xcode asset-catalog colour (`Name.colorset/Contents.json`), with its dark variant when it has one. */
export function parseColorset(rel: string, text: string | undefined): NamedColor | undefined {
  const name = rel.match(COLORSET)?.[1];
  if (!name || !text) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = Colorset.safeParse(json);
  if (!parsed.success) return undefined;
  // Xcode's "Any, Light, Dark" appearances give a colour for any appearance plus explicit light and dark ones. The
  // app shows the explicit one for its mode, and the "any" one where there's none. Each takes its first readable entry.
  const entries = (parsed.data.colors ?? []).filter((entry) => entry.color?.components);
  // Each entry's components are where its value is written, when every one of them was found in the text.
  const found = componentSpans(text);
  const spans = found.length === entries.length ? found : [];
  const span = locator(rel, text);
  const written = new Map<"any" | "light" | "dark", { hex: string; location?: ValueLocation }>();
  for (const [i, entry] of entries.entries()) {
    const components = entry.color?.components;
    if (!components) continue;
    const at = spans[i];
    const appearances = entry.appearances ?? [];
    if (appearances.some((a) => a.value !== "dark" && a.value !== "light")) continue;
    const luminosity = appearances.find((a) => a.appearance === "luminosity")?.value;
    const mode = luminosity === "dark" || luminosity === "light" ? luminosity : "any";
    const hex = written.has(mode) ? undefined : componentsToHex(components);
    if (hex) written.set(mode, { hex, ...(at ? { location: valueAt(span(...at), "components") } : {}) });
  }
  const light = written.get("light") ?? written.get("any");
  if (!light) return undefined;
  const dark = written.get("dark") ?? written.get("any");
  const locations = {
    ...(light.location && { light: light.location }),
    ...(dark !== light && dark?.location && { dark: dark.location }),
  };
  return {
    name,
    light: light.hex,
    ...(dark && dark.hex !== light.hex ? { dark: dark.hex } : {}),
    source: rel,
    reference: `Color("${name}")`,
    kind: "asset",
    ...(locations.light || locations.dark ? { locations } : {}),
  };
}

/** The spans of every `"components"` object in a colour set, in the order they're written, each from its `{` to just
 * after its `}`; none when a string or brace never closes. */
function componentSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  let open = -1;
  let depth = 0;
  let openDepth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const close = stringEnd(text, i);
      if (close === -1) return [];
      if (open === -1 && text.slice(i, close + 1) === '"components"') open = COMPONENTS_PENDING;
      i = close;
    } else if (c === "{") {
      depth++;
      if (open === COMPONENTS_PENDING) [open, openDepth] = [i, depth];
    } else if (c === "}") {
      if (open >= 0 && depth === openDepth) {
        spans.push([open, i + 1]);
        open = -1;
      }
      depth--;
    } else if (open === COMPONENTS_PENDING && c !== ":" && !SPACE.test(c ?? "")) open = -1;
  }
  return open === -1 ? spans : [];
}

/** `open` once a `"components"` key is read and before its object starts. */
const COMPONENTS_PENDING = -2;
const SPACE = /\s/;

/** The index of the quote closing the JSON string opened at `start`, or -1 when it never closes. */
function stringEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"') return i;
  }
  return -1;
}
