/** An Android app's text appearances: `<style name="TextAppearance.App.Title" parent="TextAppearance.Material3.TitleLarge">`
 * in `res/values`, with what it sets over its parent's values, as `R.style.TextAppearance_App_Title`. */

import { COMPUTED } from "../scan/type-scale.js";
import type { CodeSpan, TypeLocations, TypeStyle, ValueLocation } from "../scan/types.js";
import {
  elementText,
  resourcePriority,
  valuesFolder,
  type Written,
  withoutComments,
} from "./android-resources.js";
import { familyFromFile } from "./compose-fonts.js";
import { MATERIAL_DEFAULTS, SYSTEM, weightByHundred } from "./material-type.js";
import { type Locator, locator } from "./source-text.js";
import { followNames, through, valueAt, withLocations } from "./value-locations.js";

/** A size the style sets but that can't be read (`?attr/…`) is undefined, replacing its parent's. */
interface Font {
  family?: string;
  size?: number | undefined;
  weight?: string;
  locations: TypeLocations;
}

interface StyleResource {
  /** Its parent's name, given or implied by its own (`TextAppearance.App.Title` is `TextAppearance.App`'s child). */
  parent?: string;
  /** Where the parent is named: its `parent` attribute, or for one implied, the style's own name. */
  parentAt: CodeSpan;
  items: Map<string, Written>;
}

const STYLE = /<style\b([^<>]*?)(\/?)>/g;
const ATTRIBUTE = /\b(name|parent)\s*=\s*"([^"]*)"/g;
const ITEM = /<item\s+name\s*=\s*"([\w:.]+)"\s*>\s*([^<]*?)\s*<\/item>/g;
const DIMEN = /<dimen\s+name\s*=\s*"([\w.]+)"\s*>\s*([^<]*?)\s*<\/dimen>/g;
const SIZE = /^(\d+(?:\.\d+)?)(?:sp|dp|dip)$/;
const STYLE_USE = /\bR\.style\.(\w+)|@style\/([\w.]+)/g;
/** Material's own text appearances, whose sizes and weights are Material's type scale (`Material3.BodySmall`,
 * `MaterialComponents.Headline6`). */
const MATERIAL_PARENT = /^TextAppearance\.(?:Material3|MaterialComponents)\.(\w+)$/;
const STYLE_LINK = /^@(?:android:)?style\//;
const FONT_FILE = /^@font\/(\w+)$/;
const DIMEN_LINK = /^@dimen\/([\w.]+)$/;
/** Android's generic families, named as Compose names them. */
const GENERIC_FAMILIES: Record<string, string> = {
  serif: "Serif",
  monospace: "Monospace",
  cursive: "Cursive",
};
const SANS_SERIF = /^sans-serif(?:-(thin|light|medium|black))?$/;
/** Parents, or dimensions pointing at dimensions, followed this many times over are a loop. */
const MAX_LINKS = 8;

/** The text appearances an app defines, each with how many times its code and resources reach it; `code` is the
 * Kotlin the app is written in. */
export function textAppearances(files: { rel: string; text: string }[], code: string[]): TypeStyle[] {
  const styles = new Map<string, StyleResource>();
  const dimens = new Map<string, Written>();
  for (const file of [...files].sort((a, b) => resourcePriority(a.rel) - resourcePriority(b.rel))) {
    if (valuesFolder(file.rel) !== "values") continue;
    const text = withoutComments(file.text);
    const span = locator(file.rel, text);
    for (const [name, style] of stylesIn(text, span)) if (!styles.has(name)) styles.set(name, style);
    for (const m of text.matchAll(DIMEN))
      if (m[1] && !dimens.has(m[1])) dimens.set(m[1], elementText(m, m[2] ?? "", span));
  }
  const uses = styleUses([...files.map((f) => withoutComments(f.text)), ...code]);
  return [...styles].flatMap(([name, style]): TypeStyle[] => {
    if (!isTextAppearance(name, style)) return [];
    const font = fontOf(name, styles, dimens);
    if (!font) return [];
    const codeName = name.replaceAll(".", "_");
    return [
      {
        name,
        kind: "app",
        family: font.family ?? "",
        ...(font.size === undefined ? {} : { size: font.size }),
        weight: font.weight ?? COMPUTED,
        reference: `R.style.${codeName}`,
        uses: uses.get(codeName) ?? 0,
        ...withLocations(font.locations),
      },
    ];
  });
}

const isTextAppearance = (name: string, style: StyleResource) =>
  name.startsWith("TextAppearance.") || (style.parent?.startsWith("TextAppearance.") ?? false);

function stylesIn(text: string, span: Locator): Map<string, StyleResource> {
  const styles = new Map<string, StyleResource>();
  const opens = [...text.matchAll(STYLE)];
  let close = 0;
  for (const [i, m] of opens.entries()) {
    const tagStart = (m.index ?? 0) + "<style".length;
    const attributes = new Map(
      [...(m[1] ?? "").matchAll(ATTRIBUTE)].map((a) => {
        const start = tagStart + (a.index ?? 0) + a[0].indexOf('"') + 1;
        return [a[1], { value: a[2] ?? "", location: span(start, start + (a[2] ?? "").length) }];
      }),
    );
    const named = attributes.get("name");
    const name = named?.value;
    if (!named || !name) continue;
    const given = attributes.get("parent");
    const implied = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : undefined;
    const parent = (given === undefined ? implied : given.value.replace(STYLE_LINK, "")) || undefined;
    const items = new Map<string, Written>();
    if (!m[2]) {
      const start = (m.index ?? 0) + m[0].length;
      // Each stretch is read once: a style ends where it closes, or where the next opens if it doesn't close first.
      if (close >= 0 && close < start) close = text.indexOf("</style>", start);
      const body = close < 0 ? "" : text.slice(start, Math.min(close, opens[i + 1]?.index ?? close));
      for (const item of body.matchAll(ITEM))
        items.set((item[1] ?? "").replace(/^android:/, ""), elementText(item, item[2] ?? "", span, start));
    }
    styles.set(name, { ...(parent ? { parent } : {}), parentAt: (given ?? named).location, items });
  }
  return styles;
}

/** What a style sets over its parents; undefined when neither it nor any parent sets a family or size. */
function fontOf(
  name: string,
  styles: Map<string, StyleResource>,
  dimens: Map<string, Written>,
): Font | undefined {
  const chain: StyleResource[] = [];
  let font: Font = { locations: {} };
  for (let at: string | undefined = name; at && chain.length <= MAX_LINKS; ) {
    const style = styles.get(at);
    if (!style) {
      const role = at.match(MATERIAL_PARENT)?.[1];
      const material = role && MATERIAL_DEFAULTS[materialRole(role)];
      if (material) font = { family: SYSTEM, ...material, locations: {} };
      break;
    }
    chain.push(style);
    at = style.parent;
  }
  if (chain.length > MAX_LINKS) return undefined;
  for (let depth = chain.length - 1; depth >= 0; depth--) {
    const style = chain[depth];
    if (!style) continue;
    const { locations, set, ...values } = itemsFont(style.items, dimens);
    // A value a parent sets is reached through each style's parent on the way up to it.
    const via = chain.slice(0, depth).map((child) => child.parentAt);
    for (const key of set) {
      const location = locations[key];
      if (location) font.locations[key] = through(location, via);
      else delete font.locations[key];
    }
    Object.assign(font, values);
  }
  return font.family === undefined && font.size === undefined ? undefined : font;
}

/** `BodySmall` as Material 3's `bodySmall`, `Headline6` as Material 2's `h6`. */
const materialRole = (role: string) =>
  role.replace(/^Headline(\d)$/, "h$1").replace(/^\w/, (c) => c.toLowerCase());

/** A style's own font, with which of its values its items set, read or not. */
type ItemsFont = Font & { set: Set<keyof TypeLocations> };

/** What a style's own items set, where, and which of its values they set, read or not. */
function itemsFont(items: Map<string, Written>, dimens: Map<string, Written>): ItemsFont {
  const font: ItemsFont = { locations: {}, set: new Set() };
  const place = (key: keyof TypeLocations, location: ValueLocation | undefined) => {
    font.set.add(key);
    if (location) font.locations[key] = location;
  };
  const size = items.get("textSize");
  if (size !== undefined) {
    const read = sizeOf(size, dimens);
    font.size = read?.size;
    place("fontSize", read?.location);
  }
  const family = items.get("fontFamily");
  if (family !== undefined) {
    const sans = family.value.match(SANS_SERIF);
    const file = family.value.match(FONT_FILE)?.[1];
    font.family = sans ? SYSTEM : file ? familyFromFile(file) : (GENERIC_FAMILIES[family.value] ?? "");
    const named = valueAt(family.location, file ? "identifier" : sans?.[1] ? "family-name" : "literal");
    place("fontFamily", named);
    if (sans?.[1]) {
      font.weight = sans[1];
      place("fontWeight", named);
    }
  }
  const style = items.get("textStyle");
  if (style !== undefined) {
    font.weight = style.value.split("|").includes("bold") ? "bold" : "regular";
    place("fontWeight", valueAt(style.location, "literal"));
  }
  const weight = items.get("textFontWeight");
  if (weight && Number(weight.value)) {
    font.weight = weightByHundred(Number(weight.value));
    place("fontWeight", valueAt(weight.location, "literal"));
  }
  return font;
}

/** `14sp`, or a `@dimen/…` holding it, in points, and where the number is written, through each link to it. */
function sizeOf(
  value: Written,
  dimens: Map<string, Written>,
): { size: number; location: ValueLocation } | undefined {
  const found = followNames(
    value,
    (at) => {
      const dimen = at.value.match(DIMEN_LINK)?.[1];
      return dimen ? dimens.get(dimen) : null;
    },
    (at) => at.location,
    MAX_LINKS,
  );
  const points = found?.target.value.match(SIZE)?.[1];
  if (!found || points === undefined) return undefined;
  return { size: Number(points), location: through(valueAt(found.target.location, "literal"), found.via) };
}

/** How many times each style is reached, by its code name (`TextAppearance_App_Title`). */
function styleUses(texts: string[]): Map<string, number> {
  const uses = new Map<string, number>();
  for (const text of texts)
    for (const m of text.matchAll(STYLE_USE)) {
      const name = m[1] ?? (m[2] ?? "").replaceAll(".", "_");
      uses.set(name, (uses.get(name) ?? 0) + 1);
    }
  return uses;
}
