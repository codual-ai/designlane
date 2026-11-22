/**
 * The colours a Compose theme gives names to: each role of a Material colour scheme (`primary`, `surface`) and each
 * colour of an app's own colour class (`AppColors(brand = …)`, read as `AppTheme.colors.brand`), with its Light value
 * and, from the matching dark scheme or instance, its Dark one.
 */

import type { NamedColor } from "../scan/palette.js";
import { type ColorLookup, colorValue } from "./compose-color-values.js";
import { type Argument, assignedName, callArguments, isDeclared, Spans } from "./kotlin-calls.js";
import type { KotlinSource } from "./kotlin-sources.js";
import { withLocations } from "./value-locations.js";

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
  /** The objects or classes holding it, outermost first, as an app with a theme per object writes it
   * (`TachiyomiColorScheme` for its `lightScheme`). */
  owner?: string;
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
  const schemes = sources.flatMap((source) => {
    const calls = [...source.code.matchAll(SCHEME_CALL)];
    const owners =
      calls.length > 0
        ? ownersAt(
            typeBodies(source.code),
            calls.map((m) => m.index ?? 0),
          )
        : [];
    return calls.flatMap((m, i) => {
      const kind = SCHEMES[m[1] ?? ""];
      if (!kind) return [];
      const at = m.index ?? 0;
      const { args, close } = callArguments(source, at + m[0].length - 1);
      definitions.get(source)?.add(at, close);
      const values = new Map(args.flatMap((a) => (a.name ? [[a.name, a] as const] : [])));
      const owner = owners[i];
      const name = assignedName(source.code, at) ?? "";
      return [{ palette: { name, ...(owner && { owner }), dark: kind.dark, values, source }, ...kind }];
    });
  });
  const pair = lightAndDark(
    schemes.map((s) => s.palette),
    defaultsNamed(sources),
  );
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

/** An object's or class's body: where its `{` and `}` are. */
interface TypeBody {
  name: string;
  open: number;
  close: number;
}

/** A type's declaration, not a class literal (`String::class`): its name on the same line. */
const TYPE_NAME = /(?<!::)\b(?:object|class)[ \t]+(\w+)/g;
/** What starts a declaration of its own, so a type before it has no body: `class Marker` then `object Brand {`. */
const DECLARATION =
  /^\s*(?:[@}]|(?:(?:private|internal|public|protected|data|enum|sealed|abstract|open|inner|override|companion)\s+)*(?:class|object|interface|val|var|fun)\b)/;
/** How far a type's header is read for its body's `{`. */
const MAX_HEADER = 2000;

/** Each object's and class's body in `code`, whose strings and comments are blanked: its braces matched once. */
function typeBodies(code: string): TypeBody[] {
  const closes = new Map<number, number>();
  const open: number[] = [];
  for (let i = 0; i < code.length; i++) {
    if (code[i] === "{") open.push(i);
    else if (code[i] === "}") {
      const from = open.pop();
      if (from !== undefined) closes.set(from, i);
    }
  }
  const bodies: TypeBody[] = [];
  for (const m of code.matchAll(TYPE_NAME)) {
    const brace = bodyOpen(code, (m.index ?? 0) + m[0].length);
    const close = brace === undefined ? undefined : closes.get(brace);
    if (brace !== undefined && close !== undefined) bodies.push({ name: m[1] ?? "", open: brace, close });
  }
  return bodies;
}

/** Where the body of the type whose header starts at `from` opens: past its constructor and supertypes, none when a
 * declaration of its own or a `;` comes first. */
function bodyOpen(code: string, from: number): number | undefined {
  let depth = 0;
  for (let i = from; i < Math.min(code.length, from + MAX_HEADER); i++) {
    const c = code[i];
    if (c === "(" || c === "<" || c === "[") depth++;
    // A function type's `->` closes nothing: `class Brand(val onTap: () -> Unit = {})`.
    else if (c === ")" || (c === ">" && code[i - 1] !== "-") || c === "]") depth--;
    else if (depth > 0) continue;
    else if (c === "{") return i;
    else if (c === ";" || c === "}" || c === "=") return undefined;
    else if (c === "\n" && DECLARATION.test(code.slice(i + 1, i + 200))) return undefined;
  }
  return undefined;
}

/** For each of `positions`, in order, the objects and classes holding it, outermost first (`Aurora.Palette`): one
 * sweep over the bodies, which nest as their braces do. */
function ownersAt(bodies: TypeBody[], positions: number[]): (string | undefined)[] {
  const sorted = [...bodies].sort((a, b) => a.open - b.open);
  const holding: TypeBody[] = [];
  let next = 0;
  return positions.map((at) => {
    while (next < sorted.length && (sorted[next]?.open ?? at) < at) {
      const body = sorted[next++];
      if (!body) break;
      while (holding.length > 0 && (holding.at(-1)?.close ?? 0) < body.open) holding.pop();
      holding.push(body);
    }
    while (holding.length > 0 && (holding.at(-1)?.close ?? 0) < at) holding.pop();
    return holding.length > 0 ? holding.map((b) => b.name).join(".") : undefined;
  });
}

/** How strongly the code names a theme as its default: `AppTheme.DEFAULT to Brand` and `DEFAULT -> Brand` say so,
 * `getOrDefault(theme, Brand)` and `else -> Brand` only suggest it. */
const NAMED_DEFAULT = [/\bDEFAULT\s+to\s+([\w.]+)/g, /\bDEFAULT\s*->\s*([\w.]+)/g];
const SUGGESTED_DEFAULT = /\belse\s*->\s*([\w.]+)/g;
const STRONG = 3;
const WEAK = 1;

/** Each theme the code names as its default, as the code refers to it (`Brand`, `Themes.Brand`), with how strongly. */
function defaultsNamed(sources: KotlinSource[]): Map<string, number> {
  const named = new Map<string, number>();
  const note = (reference: string | undefined, strength: number) => {
    if (reference) named.set(reference, Math.max(named.get(reference) ?? 0, strength));
  };
  for (const { code } of sources) {
    for (const pattern of NAMED_DEFAULT) for (const m of code.matchAll(pattern)) note(m[1], STRONG);
    for (const m of code.matchAll(SUGGESTED_DEFAULT)) note(m[1], WEAK);
    const calls = [...code.matchAll(/\bgetOrDefault\(/g)];
    if (calls.length === 0) continue;
    const args = callCommas(code);
    for (const m of calls) note(lastArgument(code, args, (m.index ?? 0) + m[0].length - 1), WEAK);
  }
  return named;
}

/** Each bracket's close and the commas directly in it, by where it opens: read in one pass over the code. */
function callCommas(code: string): Map<number, { close: number; commas: number[] }> {
  const calls = new Map<number, { close: number; commas: number[] }>();
  const open: { at: number; commas: number[] }[] = [];
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") open.push({ at: i, commas: [] });
    else if (c === ")" || c === "]" || c === "}") {
      const call = open.pop();
      if (call) calls.set(call.at, { close: i, commas: call.commas });
    } else if (c === ",") open.at(-1)?.commas.push(i);
  }
  return calls;
}

/** The reference a call's last argument starts with: `Brand` in `getOrDefault(read(), Brand)` and in
 * `getOrDefault(read(), Brand,)`. */
function lastArgument(
  code: string,
  calls: Map<number, { close: number; commas: number[] }>,
  open: number,
): string | undefined {
  const call = calls.get(open);
  if (!call) return undefined;
  const ends = [open, ...call.commas, call.close];
  for (let k = ends.length - 1; k > 1; k--) {
    const text = code.slice((ends[k - 1] ?? 0) + 1, ends[k]);
    if (text.trim() !== "") return /^\s*([\w.]+)/.exec(text)?.[1];
  }
  return undefined;
}

/** `LightDefaultColorScheme` and `DarkDefaultColorScheme` are a pair; so are `BrandLightColors` and `BrandDarkColors`,
 * and an object's `lightScheme` and `darkScheme`, never another object's. */
const pairKey = (p: Palette) =>
  `${p.owner ?? ""}|${p.name.toLowerCase().replace(/light|dark|night|day/g, "")}`;

/** The theme's Light palette and its Dark partner. Light is the one the code names as its default theme, then one
 * named default, then one with a partner by name, then one named light, then the fullest; a lone dark palette
 * partners whichever light one there is. */
function lightAndDark(
  palettes: Palette[],
  defaults = new Map<string, number>(),
): { light: Palette; dark?: Palette } | undefined {
  const lights = palettes.filter((p) => !p.dark);
  const darks = palettes.filter((p) => p.dark);
  const darkByKey = new Map<string, Palette>();
  for (const d of darks) if (!darkByKey.has(pairKey(d))) darkByKey.set(pairKey(d), d);
  const partner = (light: Palette) => darkByKey.get(pairKey(light));
  // A reference names a theme by its whole path or the end of it: `Themes.Brand` and `Brand` are `Brand`'s;
  // `Brand.Palette` isn't `Aurora.Palette`'s.
  const names = (reference: string, path: string) =>
    path === reference || path.endsWith(`.${reference}`) || reference.endsWith(`.${path}`);
  const named = (p: Palette) =>
    Math.max(
      0,
      ...[...defaults].filter(([r]) => (p.owner && names(r, p.owner)) || r === p.name).map(([, n]) => n),
    );
  const score = (p: Palette) =>
    named(p) * 8 +
    (/default/i.test(`${p.owner ?? ""}.${p.name}`) ? 4 : 0) +
    (partner(p) ? 2 : 0) +
    (/light|day/i.test(p.name) ? 1 : 0);
  const light = [...lights].sort((a, b) => score(b) - score(a) || b.values.size - a.values.size)[0];
  if (!light) return undefined;
  // A lone dark palette is the light one's only if it isn't another theme's.
  const lone = darks.length === 1 ? darks[0] : undefined;
  const dark = partner(light) ?? (lone && lone.owner === light.owner ? lone : undefined);
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
    const color: NamedColor = {
      name: field,
      light: day.hex,
      ...(night && night.hex !== day.hex && { dark: night.hex }),
      source: light.source.rel,
      reference: `${access}.${field}`,
      kind: "code",
      ...withLocations({
        ...(day.location && { light: day.location }),
        ...(night?.location && { dark: night.location }),
      }),
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
