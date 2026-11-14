/**
 * A React Native app's themes beside its light and dark one (`themes.black`, a list of presets, a
 * `darkContrastTheme` in a file of its own): told apart from the colours the app keeps as its default theme, and
 * read as themes of their own, each with its Light and Dark values.
 */

import type { NamedColor, ThemeColor, ThemeFindings } from "../scan/palette.js";
import type { ValueLocation } from "../scan/types.js";
import { type JsSource, renderPath } from "./js-sources.js";

/** A key or variable naming a colour scheme: `light`, `darkTheme`, `LightColors`, `themeDark`. */
export const MODE =
  /^(?:(light|dark)(?:mode|theme|colou?rs?|palette)?|(?:theme|colou?rs?|palette)(light|dark))$/i;
/** A parent holding the app's themes: `themes`, `THEMES`, `INVITE_THEMES`. */
export const THEMES = /(?:^|_)themes?$/i;
/** `light` or `dark` anywhere in a name: `darkContrastTheme`, `highContrastLight`. */
const SCHEME_WORD = /light|dark/i;
/** What's left around a name once its `light` or `dark` is taken out (`high_Contrast_`). */
const EDGE_SEPARATORS = /^[_-]+|[_-]+$/g;

/** A colour a theme object names, with its value. */
export interface ThemedEntry {
  name: string;
  /** The path the code reaches it by: `themes.black.surface`. */
  path: string[];
  source: JsSource;
  line: number;
  value: string;
  /** Where its value is written, through any names it's given by on the way. */
  location: ValueLocation;
}

/** The scheme a path part names (`light` for `lightTheme`), if it names one. */
export function modeOf(part: string): "light" | "dark" | undefined {
  const m = part.match(MODE);
  const mode = (m?.[1] ?? m?.[2])?.toLowerCase();
  return mode === "light" || mode === "dark" ? mode : undefined;
}

/** A colour of the app as the code names it, with its dark value when that differs, and where each is written. */
export const namedColor = (e: ThemedEntry, dark?: ThemedEntry): NamedColor => ({
  name: e.name,
  light: e.value,
  ...(dark && dark.value !== e.value ? { dark: dark.value } : {}),
  source: e.source.rel,
  reference: renderPath(e.path),
  line: e.line,
  kind: "code",
  locations: { light: e.location, ...(dark && { dark: dark.location }) },
});

/** Where an entry's theme is named in its path: the part under a `themes` parent, or a `light` or `dark` part, which
 * may be a module-level variable (`const light = { … }; const black = { … }`). */
function themeAt(parts: string[]): number {
  for (let i = 0; i < parts.length - 1; i++) {
    if ((i > 0 && THEMES.test(parts[i - 1] ?? "")) || MODE.test(parts[i] ?? "")) return i;
  }
  return -1;
}

/** An entry of a theme beside the kept ones: the theme it's in, where its theme sits, and its place in the theme
 * (`bg`, with `light` taken out of `light.bg` as its scheme). */
interface Placed<T> {
  entry: T;
  theme: string;
  parent: string;
  member: string;
  mode?: "light" | "dark";
  /** A colour with its own two values (`bg: { light, dark }`), named by its object as the default theme's are. */
  ownPair?: true;
}

/** A theme named with its scheme in it (`darkContrastTheme`): the theme it's a version of, and that scheme. */
function variantOf(theme: string): { theme: string; mode: "light" | "dark" } | undefined {
  const word = MODE.test(theme) ? undefined : theme.match(SCHEME_WORD)?.[0].toLowerCase();
  if (word !== "light" && word !== "dark") return undefined;
  return { theme: theme.replace(SCHEME_WORD, "").replace(EDGE_SEPARATORS, "") || theme, mode: word };
}

/** `entry`'s place in its theme, from the path after the theme's own part: a scheme may be in the theme's name, the
 * part after it (`day.light.qr`), or the last part (`black.bg.dark`). */
function place<T extends ThemedEntry>(entry: T, named: string, parent: string, at: number): Placed<T> {
  const variant = variantOf(named);
  const theme = variant?.theme ?? named;
  let rest = entry.path.slice(at + 1);
  let mode = variant?.mode ?? modeOf(named);
  const inner = rest.length > 1 ? modeOf(rest[0] ?? "") : undefined;
  if (inner) {
    mode = inner;
    rest = rest.slice(1);
  }
  const last = rest.length > 1 ? rest[rest.length - 1]?.toLowerCase() : undefined;
  const ownPair = last === "light" || last === "dark" ? last : undefined;
  if (ownPair) {
    mode = ownPair;
    rest = rest.slice(0, -1);
  }
  return {
    entry,
    theme,
    parent,
    member: rest.join("\0"),
    ...(mode ? { mode } : {}),
    ...(ownPair && { ownPair: true as const }),
  };
}

/**
 * When an app keeps several themes with the same colours (`themes.light`, `themes.dark`, `themes.black`; an app's
 * presets), the colours of its light and dark themes, or of the first theme when none is named so, and every other
 * theme apart, each with its own colours. Siblings that aren't themes (a palette's `primary` and `secondary` roles)
 * are left as they are: only a parent named `themes`, or one holding a `light` or `dark`, counts.
 */
export function themesApart<T extends ThemedEntry>(entries: T[]): { kept: T[]; themes: ThemeFindings[] } {
  // A file whose module-level objects include a light or dark theme: its other objects may be themes too
  // (`lightContrastTheme` beside `lightTheme`, `blackIOS` beside `light`).
  const themeFiles = new Set(
    entries.filter((e) => e.path.length > 1 && MODE.test(e.path[0] ?? "")).map((e) => e.source),
  );
  const byParent = new Map<string, Map<string, { entry: T; at: number }[]>>();
  for (const e of entries) {
    const found = themeAt(e.path);
    const at = found === -1 && e.path.length > 1 && themeFiles.has(e.source) ? 0 : found;
    if (at === -1) continue;
    const parent = `${e.source.rel}\0${e.path.slice(0, at).join("\0")}`;
    const themes = byParent.get(parent) ?? new Map<string, { entry: T; at: number }[]>();
    const list = themes.get(e.path[at] ?? "");
    if (list) list.push({ entry: e, at });
    else themes.set(e.path[at] ?? "", [{ entry: e, at }]);
    byParent.set(parent, themes);
  }
  const apart: Placed<T>[] = [];
  const kept: Placed<T>[] = [];
  for (const [parent, themes] of byParent) {
    const names = [...themes.keys()];
    if (names.length < 2) continue;
    const modes = names.filter((n) => MODE.test(n));
    const keep = new Set(modes.length > 0 ? modes : names.slice(0, 1));
    const placed = new Map(
      [...themes].map(([name, list]) => [name, list.map(({ entry, at }) => place(entry, name, parent, at))]),
    );
    const keptMembers = new Set([...keep].flatMap((n) => (placed.get(n) ?? []).map((p) => p.member)));
    for (const [name, list] of placed) {
      if (keep.has(name)) kept.push(...list);
      // A theme repeats the kept one's colours; a sibling naming others (`common: { accent }`) isn't a theme.
      else if (list.filter((p) => keptMembers.has(p.member)).length * 2 >= list.length) apart.push(...list);
    }
  }
  apart.push(...variants(entries, new Set(apart.map((p) => p.entry))));
  const dropped = new Set(apart.map((p) => p.entry));
  return { kept: entries.filter((e) => !dropped.has(e)), themes: themeColors(apart, roles(kept)) };
}

/** Variants of a light or dark theme, each in a file of its own (`lightContrastTheme`, `highContrastDark`): one theme
 * for each name once its scheme is taken out (`ContrastTheme`), with that scheme. */
function variants<T extends ThemedEntry>(entries: T[], taken: Set<T>): Placed<T>[] {
  if (!entries.some((e) => e.path.slice(0, -1).some((part) => MODE.test(part)))) return [];
  return entries.flatMap((entry) => {
    const root = entry.path[0] ?? "";
    if (entry.path.length < 2 || !variantOf(root) || taken.has(entry)) return [];
    return [place(entry, root, "", 0)];
  });
}

/** For each place in the kept themes (by parent and member), the reference the default theme's colour there has: its
 * light one's, as `pairModes` names a pair. */
function roles<T extends ThemedEntry>(kept: Placed<T>[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const { entry, parent, member, mode, ownPair } of kept) {
    const key = `${parent}\0${member}`;
    const path = ownPair ? entry.path.slice(0, -1) : entry.path;
    if (!found.has(key) || mode === "light") found.set(key, renderPath(path));
  }
  return found;
}

/** Each theme's colours, a light and a dark value at the same place paired into one, in the order the code has
 * them. */
function themeColors<T extends ThemedEntry>(
  apart: Placed<T>[],
  roleAt: Map<string, string>,
): ThemeFindings[] {
  const byTheme = new Map<string, Map<string, { light?: T; dark?: T; ownPair?: true }>>();
  for (const { entry, theme, parent, member, mode, ownPair } of apart) {
    const places = byTheme.get(theme) ?? new Map<string, { light?: T; dark?: T; ownPair?: true }>();
    byTheme.set(theme, places);
    const key = `${parent}\0${member}`;
    const pair = places.get(key) ?? {};
    places.set(key, pair);
    if (ownPair) pair.ownPair = ownPair;
    if (mode === "dark") pair.dark ??= entry;
    else pair.light ??= entry;
  }
  return [...byTheme].map(([name, places]) => ({
    name,
    colors: [...places].flatMap(([key, { light, dark, ownPair }]): ThemeColor[] => {
      const first = light ?? dark;
      if (!first) return [];
      const paired = namedColor(first, light && dark);
      const at = first.path.slice(0, -1);
      const color = ownPair
        ? { ...paired, name: at[at.length - 1] ?? paired.name, reference: renderPath(at) }
        : paired;
      const role = roleAt.get(key);
      return [role ? { ...color, role } : color];
    }),
  }));
}
