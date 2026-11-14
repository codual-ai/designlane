/** An Android app's colour resources: `<color name="brand">#FF6650A4</color>` in `res/values`, with the Dark value
 * from `res/values-night`, and colours that point at others (`@color/brand`) followed. */

import { isOtherTarget } from "../scan/targets.js";
import type { CodeSpan, ColorLocations, ValueLocation } from "../scan/types.js";
import { androidHex } from "./compose-color-values.js";
import { blankRanges, type Locator, locator } from "./source-text.js";
import { followNames, through, valueAt } from "./value-locations.js";

export interface ResourceColor {
  name: string;
  light: string;
  dark?: string;
  source: string;
  locations: ColorLocations;
}

/** Where colour resources live: `res/values/colors.xml`, `res/values-night/themes.xml` and the like. */
export const RESOURCE_FILE = /(?:^|\/)res\/values[\w-]*\/[^/]+\.xml$/;
const RESOURCE = /<color\s+name\s*=\s*"([\w.]+)"\s*>\s*([^<]*?)\s*<\/color>/g;
const VALUES_FOLDER = /(?:^|\/)res\/(values[\w-]*)\//;
/** A colour resource naming another: `@color/brand`. */
const COLOR_LINK = /^@color\/([\w.]+)$/;
/** Colours pointing at colours this many times over are a loop, not a palette. */
const MAX_LINKS = 8;

/** The app's own resources come before a build variant's (`src/debug/res`) and another target's (a Wear module's),
 * and `values-night` before a qualified one (`values-night-v31`), so the first value found for a colour is the one
 * the app ships with by default. */
export const resourcePriority = (rel: string) =>
  (/(?:^|\/)src\/main\//.test(rel) ? 0 : 2) +
  (isOtherTarget(rel) ? 4 : 0) +
  (/\/values-night\//.test(rel) ? 0 : 1);

/** The resource folder a file is in (`values`, `values-night-v31`), if it's one of the `values` folders. */
export const valuesFolder = (rel: string) => rel.match(VALUES_FOLDER)?.[1];

/** A resource's value as written, and where. */
export interface Written {
  value: string;
  location: CodeSpan;
}

/** An element's text, `value` as a pattern read it from `m`, and where it's written: after the element's `>` and any
 * spaces, `m` having matched in the text from `offset` on. */
export function elementText(m: RegExpMatchArray, value: string, span: Locator, offset = 0): Written {
  const inner = m[0].slice(m[0].indexOf(">") + 1);
  const start = offset + (m.index ?? 0) + m[0].length - inner.trimStart().length;
  return { value, location: span(start, start + value.length) };
}

/** XML with its comments blanked, keeping every offset, so a resource commented out isn't read; one left open runs to
 * the end. */
export function withoutComments(text: string): string {
  const comments: [number, number][] = [];
  for (let open = text.indexOf(COMMENT_OPEN); open >= 0; ) {
    const close = text.indexOf(COMMENT_CLOSE, open + COMMENT_OPEN.length);
    const end = close < 0 ? text.length : close + COMMENT_CLOSE.length;
    comments.push([open, end]);
    open = text.indexOf(COMMENT_OPEN, end);
  }
  return blankRanges(text, comments);
}

const COMMENT_OPEN = "<!--";
const COMMENT_CLOSE = "-->";

export function resourceColors(files: { rel: string; text: string }[]): ResourceColor[] {
  const light = new Map<string, Written>();
  const dark = new Map<string, Written>();
  for (const { rel, text: raw } of [...files].sort(
    (a, b) => resourcePriority(a.rel) - resourcePriority(b.rel),
  )) {
    const folder = valuesFolder(rel);
    const night = folder ? /-night\b/.test(folder) : false;
    if (folder !== "values" && !night) continue;
    const table = night ? dark : light;
    const text = withoutComments(raw);
    const span = locator(rel, text);
    for (const m of text.matchAll(RESOURCE)) {
      const name = m[1] ?? "";
      if (!table.has(name)) table.set(name, elementText(m, m[2] ?? "", span));
    }
  }
  const darkOf = (name: string) => dark.get(name) ?? light.get(name);
  return [...light].flatMap(([name, written]) => {
    const day = resolve(written, (link) => light.get(link));
    if (!day) return [];
    // A colour pointing at another is dark wherever that one is.
    const night = resolve(dark.get(name) ?? written, darkOf);
    const nightAt = night && !sameLocation(night.location, day.location) ? { dark: night.location } : {};
    return [
      {
        name,
        light: day.hex,
        ...(night && night.hex !== day.hex && { dark: night.hex }),
        source: written.location.file,
        locations: { light: day.location, ...nightAt },
      },
    ];
  });
}

const sameLocation = (a: ValueLocation, b: ValueLocation) => JSON.stringify(a) === JSON.stringify(b);

/** The colour a resource's value comes to, following `@color/…` links, and where it's written: the colour's own
 * value, with each link on the way to it. */
function resolve(
  first: Written,
  table: (name: string) => Written | undefined,
): { hex: string; location: ValueLocation } | undefined {
  const link = (at: Written) => at.value.match(COLOR_LINK)?.[1];
  const found = followNames(
    first,
    (at) => {
      const name = link(at);
      return name ? table(name) : null;
    },
    (at) => at.location,
    MAX_LINKS,
  );
  const hex = found && androidHex(found.target.value);
  return hex ? { hex, location: through(valueAt(found.target.location, "literal"), found.via) } : undefined;
}
