/** What tokens.json and DESIGN.md call each value, worked out once so both files name every token the same way. */

import { byCode } from "../scan/counting.js";
import { isOtherTarget } from "../scan/targets.js";
import type { ColorTheme, ColorToken, Platform, TypeStyle } from "../scan/types.js";

/** A token's key: the app's own name, or `hex-33a854` for a colour the code never names. Anything but letters,
 * digits, `_` and `-` becomes `-`, since keys can't contain `.`, `{` or `}` in either format. */
export function tokenKey(name: string): string {
  const key = name.startsWith("#") ? `hex-${name.slice(1)}` : name;
  return key.replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed";
}

/** Keys handed out so far, and the next free number for each one taken: so two names that read the same (`a.b` and
 * `a-b`, or `x`'s dark `x-dark` and a real `x-dark`) never overwrite each other, and a thousand of one name take a
 * thousand steps, not a million. */
interface Claimed {
  taken: Set<string>;
  next: Map<string, number>;
}

const claimed = (): Claimed => ({ taken: new Set(), next: new Map() });

function claim({ taken, next }: Claimed, key: string): string {
  let unique = key;
  let n = next.get(key) ?? 2;
  while (taken.has(unique)) unique = `${key}-${n++}`;
  next.set(key, n);
  taken.add(unique);
  return unique;
}

export interface KeyedColor {
  color: ColorToken;
  key: string;
  /** The key of its dark value, when it has one. */
  darkKey?: string;
}

/**
 * Each item with its key: its own name, or, when several items share one, the way the code refers to each
 * (`Theme-surface`, `Color-surface`). Suffixes go out in an order fixed by the items themselves (`identity`), so the
 * same code gives the same keys on every machine and in every ranking.
 */
function keysOf<T>(
  items: T[],
  name: (item: T) => string,
  reference: (item: T) => string,
  identity: (item: T) => string,
  taken: Claimed,
) {
  const shared = new Map<string, number>();
  for (const item of items) shared.set(name(item), (shared.get(name(item)) ?? 0) + 1);
  const wanted = (item: T) => ((shared.get(name(item)) ?? 0) > 1 ? tokenKey(reference(item)) : name(item));
  const order = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => byCode(wanted(a.item), wanted(b.item)) || byCode(identity(a.item), identity(b.item)));
  const keyed: { item: T; key: string }[] = [];
  for (const { item, index } of order) keyed[index] = { item, key: claim(taken, wanted(item)) };
  return keyed;
}

export function keyedColors(colors: ColorToken[]): KeyedColor[] {
  const taken = claimed();
  const reference = (c: ColorToken) => c.reference ?? c.name;
  // Of colours sharing a reference, the app's own copy takes the plain key, before a widget's or a watch app's.
  const identity = (c: ColorToken) =>
    `${isOtherTarget(c.source) ? 1 : 0}|${reference(c)}|${c.source}|${c.light}`;
  const keyed = keysOf(colors, (c) => tokenKey(c.name), reference, identity, taken);
  // A dark key is its colour's key, already unique, plus `-dark`; claimed after every light key, it gets a suffix
  // only when the app has a colour named that already.
  const withDark = keyed.filter(({ item }) => item.dark);
  const darkKeys = new Map(withDark.map(({ item, key }) => [item, claim(taken, `${key}-dark`)]));
  return keyed.map(({ item: color, key }) => {
    const darkKey = darkKeys.get(color);
    return { color, key, ...(darkKey ? { darkKey } : {}) };
  });
}

/** Each theme with a key of its own (`ice-cube` for `Ice Cube`), in the order the code has them. */
export function keyedThemes(themes: ColorTheme[]): { theme: ColorTheme; key: string }[] {
  const taken = claimed();
  return themes.map((theme) => ({ theme, key: claim(taken, tokenKey(theme.name)) }));
}

/** A text style's values that the code sets: a size or weight it computes is left out. */
export interface TypeValues {
  fontFamily?: string;
  /** In points. */
  fontSize?: number;
  fontWeight?: number;
}

export interface KeyedStyle {
  style: TypeStyle;
  key: string;
  values: TypeValues;
}

/** Font weights as the numbers both formats use. */
const WEIGHT_NUMBERS: Record<string, number> = {
  thin: 100,
  ultraLight: 200,
  light: 300,
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
  heavy: 800,
  black: 900,
};

/** A style the code names: a platform text style (`headline`) or the app's own helper (`Font.brand`), not one
 * written in place. */
export const isNamedStyle = (style: TypeStyle) => style.kind === "app" || style.kind === "text-style";

/** A text style's key: the app's own name (`brandCaption`, `headline`), or a description made into one
 * (`System 15 semibold` is `system-15-semibold`; `System, computed size semibold` is `system-semibold`). */
function typeStyleKey(style: TypeStyle): string {
  if (isNamedStyle(style)) return tokenKey(style.name);
  const words =
    style.name
      .toLowerCase()
      .replace(/computed (?:size|weight)/g, "")
      .match(/[a-z0-9.]+/g) ?? [];
  return tokenKey(words.join("-"));
}

/** The font each platform draws its system text in; React Native's is each phone's own, shown as iOS's. */
const SYSTEM_FONT: Record<Platform, string> = { ios: "SF Pro", android: "Roboto", "react-native": "SF Pro" };

export function keyedStyles(styles: TypeStyle[], platform: Platform = "ios"): KeyedStyle[] {
  const reference = (s: TypeStyle) => s.reference ?? s.name;
  const identity = (s: TypeStyle) => `${reference(s)}|${s.name}`;
  return keysOf(styles, typeStyleKey, reference, identity, claimed()).map(({ item: style, key }) => {
    const weight = WEIGHT_NUMBERS[style.weight];
    // An empty family (a helper mixing several) has none.
    const family = style.family === "System" ? SYSTEM_FONT[platform] : style.family;
    const values: TypeValues = {
      ...(family ? { fontFamily: family } : {}),
      ...(style.size !== undefined ? { fontSize: style.size } : {}),
      ...(weight !== undefined ? { fontWeight: weight } : {}),
    };
    return { style, key, values };
  });
}

/** A number in a token's name: `1_5` for 1.5, since a `.` reads as a path in token and design file names alike. */
export const numberLabel = (value: number) => String(value).replace(".", "_");

/** A dimension's key, `space-16` or `radius-0_5`: never a bare number, which JavaScript would reorder. */
export const dimensionKey = (prefix: string, value: number) => `${prefix}-${numberLabel(value)}`;
