/**
 * The colours a Compose theme gives names to: each role of a Material colour scheme (`primary`, `surface`) and each
 * colour of an app's own colour class (`AppColors(brand = …)`, read as `AppTheme.colors.brand`), with its Light value
 * and, from the matching dark scheme or instance, its Dark one.
 */

import type { NamedColor } from "../scan/palette.js";
import { type ColorLookup, colorValue } from "./compose-color-values.js";
import { type Argument, assignedName, callArguments, isDeclared, Spans } from "./kotlin-calls.js";
import type { KotlinSource } from "./kotlin-sources.js";

/** The Material calls that build a colour scheme, and how the code then reads a role from it. */
const SCHEMES: Record<string, { dark: boolean; access: string }> = {
  lightColorScheme: { dark: false, access: "MaterialTheme.colorScheme" },
  darkColorScheme: { dark: true, access: "MaterialTheme.colorScheme" },
  lightColors: { dark: false, access: "MaterialTheme.colors" },
  darkColors: { dark: true, access: "MaterialTheme.colors" },
};
const SCHEME_CALL = /\b(lightColorScheme|darkColorScheme|lightColors|darkColors)\s*\(/g;

/** A class with at least this many colour fields is an app's colour class. */
const MIN_THEME_FIELDS = 3;
const THEME_CLASS = /\bclass\s+(\w+)\s*\(/g;
const COLOR_FIELD =
  /^(?:@\w+\s+)*(?:(?:private|internal|public|override)\s+)?(?:val|var)\s+(\w+)\s*:\s*Color\b/;

/** One call that sets a theme's colours: a scheme, or an instance of the app's colour class. */
interface Palette {
  name: string;
  dark: boolean;
  values: Map<string, Argument>;
  source: KotlinSource;
}

export interface ThemeColors {
  colors: { color: NamedColor; source: KotlinSource }[];
  /** Where each file sets theme colours, chosen or not: a constant used only there is part of the theme. */
  definitions: Map<KotlinSource, Spans>;
}

export function themeColors(sources: KotlinSource[], known: ColorLookup): ThemeColors {
  const definitions = new Map(sources.map((s) => [s, new Spans()]));
  const colors: ThemeColors["colors"] = [];
  const schemes = sources.flatMap((source) =>
    [...source.code.matchAll(SCHEME_CALL)].flatMap((m) => {
      const kind = SCHEMES[m[1] ?? ""];
      if (!kind) return [];
      const at = m.index ?? 0;
      const { args, close } = callArguments(source, at + m[0].length - 1);
      definitions.get(source)?.add(at, close);
      const values = new Map(args.flatMap((a) => (a.name ? [[a.name, a] as const] : [])));
      return [
        { palette: { name: assignedName(source.code, at) ?? "", dark: kind.dark, values, source }, ...kind },
      ];
    }),
  );
  const pair = lightAndDark(schemes.map((s) => s.palette));
  const access = schemes.find((s) => s.palette === pair?.light)?.access;
  if (pair && access) colors.push(...paletteColors(pair, [...pair.light.values.keys()], access, known));
  const classes = colorClasses(sources);
  const instances = classInstances(sources, classes, definitions);
  const accessors = accessorCounts(sources);
  for (const [className, fields] of classes) {
    const readable = (instances.get(className) ?? []).filter((p) =>
      [...p.values.values()].some((a) => colorValue(p.source, a.at, a.at + a.value.length, known)),
    );
    const found = lightAndDark(readable);
    if (!found) continue;
    const access = accessorOf(accessors, fields) ?? (found.light.name || className);
    colors.push(...paletteColors(found, fields, access, known));
  }
  return { colors, definitions };
}

/** `LightDefaultColorScheme` and `DarkDefaultColorScheme` are a pair; so are `BrandLightColors` and `BrandDarkColors`. */
const pairKey = (name: string) => name.toLowerCase().replace(/light|dark|night|day/g, "");

/** The theme's Light palette and its Dark partner. Light is the one with a partner by name, then the one named light,
 * then the fullest; a lone dark palette partners whichever light one there is. */
function lightAndDark(palettes: Palette[]): { light: Palette; dark?: Palette } | undefined {
  const lights = palettes.filter((p) => !p.dark);
  const darks = palettes.filter((p) => p.dark);
  const darkByKey = new Map<string, Palette>();
  for (const d of darks) if (!darkByKey.has(pairKey(d.name))) darkByKey.set(pairKey(d.name), d);
  const partner = (light: Palette) => darkByKey.get(pairKey(light.name));
  const score = (p: Palette) => (partner(p) ? 2 : 0) + (/light|day/i.test(p.name) ? 1 : 0);
  const light = [...lights].sort((a, b) => score(b) - score(a) || b.values.size - a.values.size)[0];
  if (!light) return undefined;
  const dark = partner(light) ?? (darks.length === 1 ? darks[0] : undefined);
  return { light, ...(dark && { dark }) };
}

function paletteColors(
  { light, dark }: { light: Palette; dark?: Palette },
  fields: string[],
  access: string,
  known: ColorLookup,
): ThemeColors["colors"] {
  const colorIn = (palette: Palette | undefined, field: string) => {
    const arg = palette?.values.get(field);
    return arg && palette ? colorValue(palette.source, arg.at, arg.at + arg.value.length, known) : undefined;
  };
  return fields.flatMap((field) => {
    const day = colorIn(light, field);
    if (!day) return [];
    const night = colorIn(dark, field);
    const locations = {
      ...(day.location && { light: day.location }),
      ...(night?.location && { dark: night.location }),
    };
    const color: NamedColor = {
      name: field,
      light: day.hex,
      ...(night && night.hex !== day.hex && { dark: night.hex }),
      source: light.source.rel,
      reference: `${access}.${field}`,
      kind: "code",
      ...((locations.light || locations.dark) && { locations }),
    };
    return [{ color, source: light.source }];
  });
}

/** Each class of the app's own holding colours, with its colour fields in order. */
function colorClasses(sources: KotlinSource[]): Map<string, string[]> {
  const classes = new Map<string, string[]>();
  for (const source of sources) {
    for (const m of source.code.matchAll(THEME_CLASS)) {
      const { args } = callArguments(source, (m.index ?? 0) + m[0].length - 1);
      const fields = args.flatMap((a) => a.value.match(COLOR_FIELD)?.[1] ?? []);
      if (fields.length >= MIN_THEME_FIELDS && m[1]) classes.set(m[1], fields);
    }
  }
  return classes;
}

/** Every call making an instance of one of `classes`, its arguments matched to fields by name or by position, found
 * in one pass over the code. */
function classInstances(
  sources: KotlinSource[],
  classes: Map<string, string[]>,
  definitions: Map<KotlinSource, Spans>,
): Map<string, Palette[]> {
  const found = new Map<string, Palette[]>();
  if (classes.size === 0) return found;
  for (const source of sources) {
    for (const m of source.code.matchAll(/(?<![\w.])([A-Z]\w*)\s*\(/g)) {
      const fields = classes.get(m[1] ?? "");
      const at = m.index ?? 0;
      if (!fields || isDeclared(source.code, at)) continue;
      const { args, close } = callArguments(source, at + m[0].length - 1);
      if (args.length === 0) continue;
      definitions.get(source)?.add(at, close);
      const values = new Map<string, Argument>();
      args.forEach((arg, i) => {
        const field = arg.name ?? fields[i];
        if (field) values.set(field, arg);
      });
      const name = assignedName(source.code, at) ?? "";
      const dark = name ? /dark|night/i.test(name) : inDarkBranch(source.code, at);
      const list = found.get(m[1] ?? "") ?? [];
      list.push({ name, dark, values, source });
      found.set(m[1] ?? "", list);
    }
  }
  return found;
}

/** How far back the `if` choosing between a theme's instances is read. */
const MAX_BRANCH = 400;

/** Whether an unnamed instance is the dark one by the `if` it's in: `if (darkTheme) AppColors(…) else AppColors(…)`. */
function inDarkBranch(code: string, at: number): boolean {
  const before = code.slice(Math.max(0, at - MAX_BRANCH), at);
  const condition = (text: string) => {
    const m = text.match(/\bif\s*\(\s*(!?)\s*([\w.]*?)\s*\)/);
    return m ? /dark|night/i.test(m[2] ?? "") !== (m[1] === "!") : false;
  };
  const then = before.match(/\bif\s*\([^()]*\)\s*\{?\s*$/);
  if (then) return condition(then[0]);
  const otherwise = before.match(/\bif\s*\([^()]*\)[\s\S]*\belse\s*\{?\s*$/);
  return otherwise ? !condition(otherwise[0]) : false;
}

/** For each field name, how often each two-part prefix is put before it: `AppTheme.colors`, `LocalColors.current`. */
function accessorCounts(sources: KotlinSource[]): Map<string, Map<string, number>> {
  const counts = new Map<string, Map<string, number>>();
  for (const { code } of sources) {
    for (const m of code.matchAll(/(?<![\w.])([A-Z]\w*\.\w+)\.(\w+)\b/g)) {
      const [prefix, field] = [m[1] ?? "", m[2] ?? ""];
      if (/^(?:MaterialTheme|R)\./.test(prefix)) continue;
      const byPrefix = counts.get(field) ?? new Map<string, number>();
      byPrefix.set(prefix, (byPrefix.get(prefix) ?? 0) + 1);
      counts.set(field, byPrefix);
    }
  }
  return counts;
}

/** How the code reads a class's colours: the prefix most often put before its fields, preferring the theme's own
 * (`AppTheme.colors`) over the composition local it reads them from (`LocalColors.current`). */
function accessorOf(counts: Map<string, Map<string, number>>, fields: string[]): string | undefined {
  const totals = new Map<string, number>();
  for (const field of fields)
    for (const [prefix, n] of counts.get(field) ?? []) totals.set(prefix, (totals.get(prefix) ?? 0) + n);
  const local = (prefix: string) => (/^Local\w*\./.test(prefix) ? 1 : 0);
  return [...totals].sort((a, b) => local(a[0]) - local(b[0]) || b[1] - a[1])[0]?.[0];
}
