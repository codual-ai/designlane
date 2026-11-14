/** What a React Native style object sets: its font, read through the named styles it spreads and the constants it
 * names, with where each value is written, and its spacing and radii. */

import ts from "typescript";
import type { TypeLocations, ValueLocation } from "../scan/types.js";
import {
  accessPath,
  type JsSource,
  nodeSpan,
  platformBranch,
  platformBranches,
  propertyName,
} from "./js-sources.js";
import { WEIGHTS } from "./rn-fonts.js";
import { FONT_FIELD, type Font, inherit, isFontKey, type Named, UNKNOWN } from "./rn-named.js";
import type { Values } from "./rn-values.js";
import { through } from "./value-locations.js";

const SPACING =
  /^(?:(?:padding|margin)(?:Top|Right|Bottom|Left|Horizontal|Vertical|Start|End|Block|Inline)?|gap|rowGap|columnGap)$/;
const RADIUS = /^border(?:Top|Bottom)?(?:Left|Right|Start|End)?Radius$/;

/** What a style object sets: its font, if it sets one, and its spacing and radii. */
export interface Style {
  font?: Font;
  /** Sets a family or size itself, not only through a named style it spreads. */
  ownFont: boolean;
  /** Takes a font from a named style it spreads. */
  spreadFont: boolean;
  /** The spread expressions giving it a font. */
  spreads: ts.Expression[];
  /** Values read from a named style (`fontSize: typography.title.fontSize`), counted as this style's, not the named
   * one's. */
  fromNamed: ts.Expression[];
  /** The `Platform.select` branches it reads, which aren't styles of their own. */
  branches: ts.ObjectLiteralExpression[];
  spacing: number[];
  radii: number[];
}

export type Spreads = (parts: string[], from: JsSource) => Named | undefined;

export function styleOf(
  object: ts.ObjectLiteralExpression,
  source: JsSource,
  values: Values,
  spreads: Spreads,
): Style {
  const style: Style = {
    ownFont: false,
    spreadFont: false,
    spreads: [],
    fromNamed: [],
    branches: [],
    spacing: [],
    radii: [],
  };
  let font: Font = {};
  let locations: TypeLocations = {};
  let touched = false;
  for (const property of object.properties) {
    // A named style spread in (`...fonts.BRAND_SANS, fontSize: 15`) gives what it sets; later properties replace it.
    if (ts.isSpreadAssignment(property)) {
      // `...Platform.select({ ios: { fontFamily: "Inter" }, android: … })`: iOS's values, as the design shows them.
      const platform = platformBranch(property.expression);
      if (platform) {
        style.branches.push(...platformBranches(property.expression));
        const inner = styleOf(platform, source, values, spreads);
        if (inner.font) {
          font = { ...font, ...inner.font };
          locations = inherit(locations, inner.font);
          touched = true;
          style.ownFont ||= inner.ownFont;
          style.spreadFont ||= inner.spreadFont;
        }
        continue;
      }
      const parts = accessPath(property.expression);
      const base = parts && spreads(parts, source)?.font;
      if (base) {
        font = { ...font, ...base };
        locations = inherit(locations, base, nodeSpan(source, property.expression));
        touched = style.spreadFont = true;
        style.spreads.push(property.expression);
      } else if (parts?.some((p) => /font|typo|text/i.test(p))) {
        // A font style the code can't read (`...fontFamilyScale.strong`) leaves family and weight unknown.
        font = { ...font, family: UNKNOWN, weight: UNKNOWN };
        locations = inherit(locations, { family: UNKNOWN, weight: UNKNOWN });
        touched = true;
      }
      continue;
    }
    let key: string | undefined;
    let written: ts.Expression | undefined;
    if (ts.isShorthandPropertyAssignment(property)) [key, written] = [property.name.text, property.name];
    else if (ts.isPropertyAssignment(property))
      [key, written] = [propertyName(property.name), property.initializer];
    if (key === undefined || written === undefined) continue;
    const read = values.read(written, source);
    let value = read?.value;
    let location = read?.location;
    // `fontSize: typography.title.fontSize`: the named style's own value, a use of this style rather than of it.
    if (isFontKey(key)) {
      const parts = accessPath(written);
      const from =
        parts && parts.length > 2 && parts.at(-1) === key ? spreads(parts.slice(0, -1), source) : undefined;
      const field = from?.font[FONT_FIELD[key]];
      const fieldAt = from?.font.locations?.[key];
      if (from) style.fromNamed.push(written);
      if (field !== undefined && field !== UNKNOWN) {
        if (key === "fontWeight") font.weight = field as string;
        else value = field;
        location = fieldAt && through(fieldAt, [nodeSpan(source, written)]);
      }
    }
    if (key === "fontFamily" && location && typeof value === "string")
      location = firstFamilyAt(location, value);
    const placed = (fontLocation: keyof TypeLocations, isRead: boolean) => {
      if (isRead && location) locations[fontLocation] = location;
      else delete locations[fontLocation];
    };
    if (SPACING.test(key) && typeof value === "number" && value > 0) style.spacing.push(value);
    else if (RADIUS.test(key) && typeof value === "number" && value > 0) style.radii.push(value);
    else if (key === "fontSize" || key === "fontFamily") {
      // A value the code works out replaces one a spread gave.
      if (key === "fontSize") font.size = typeof value === "number" ? value : UNKNOWN;
      else font.family = typeof value === "string" ? value : UNKNOWN;
      placed(key, font[key === "fontSize" ? "size" : "family"] !== UNKNOWN);
      touched = style.ownFont = true;
    } else if (key === "fontWeight") {
      if (!style.fromNamed.includes(written))
        font.weight = value === undefined ? UNKNOWN : (WEIGHTS[String(value)] ?? UNKNOWN);
      placed(key, font.weight !== UNKNOWN);
      touched = true;
    }
  }
  // A weight alone (`{ fontWeight: "bold" }`) changes a style rather than making one.
  if (touched && (style.ownFont || style.spreadFont)) style.font = { ...font, locations };
  return style;
}

/** Where the first family of a font stack is written (`Inter` in `"Inter, sans-serif"`), the one the style takes, so
 * replacing it keeps the rest; none when the string's escapes keep its text from matching the code. */
function firstFamilyAt(location: ValueLocation, family: string): ValueLocation | undefined {
  if (location.end - location.start !== family.length) return undefined;
  const first = family.split(",")[0] ?? "";
  const name = first.trim();
  const quote = /^(["']).+\1$/.test(name) ? 1 : 0;
  if (name.length - 2 * quote <= 0) return undefined;
  const start = location.start + first.length - first.trimStart().length + quote;
  return { ...location, start, end: start + name.length - 2 * quote };
}
