/**
 * A coding agent's map of an app's design system: every token, and every component, with the place in the code it's
 * written. Designlane checks each one where the map says, with its own readers, and the tokens it bears out are the
 * app's design system: the map decides what the design system is, and the code what each value is.
 */

import { z } from "zod";
import { type Color, showColor } from "../edit/color-value.js";
import { languageOf } from "../edit/notation.js";
import { colorOf } from "../frameworks/css-color.js";
import { readText, realPathInside } from "./files.js";
import {
  colorValue,
  type Definition,
  definitionAt as definitionOnLine,
  holdsColor,
  lineAt,
  numberValue,
  textStyleValue,
  valueAfter,
  withoutComments,
} from "./map-values.js";
import type {
  CodeSpan,
  ColorTheme,
  ColorToken,
  DesignTokens,
  FrameworkScan,
  ScaleStep,
  ScanResult,
  TypeLocations,
  TypeStyle,
  ValueLocation,
} from "./types.js";

/** Where the map says something is written: a file, relative to the app's folder, and a 1-based line. */
const PlaceSchema = z
  .string()
  .regex(/^[^:]+:\d+$/, "a place is written `file:line`, like `Shared/Theme.swift:12`");

const ColorValueSchema = z.object({ value: z.string(), at: PlaceSchema });

const ColorSchema = z.object({
  light: ColorValueSchema,
  dark: ColorValueSchema.optional(),
});

const NumberSchema = z.object({ value: z.number().nonnegative(), at: PlaceSchema });

export const AGENT_WEIGHTS = [
  "thin",
  "ultraLight",
  "light",
  "regular",
  "medium",
  "semibold",
  "bold",
  "heavy",
  "black",
] as const;

const TextStyleSchema = z.object({
  family: z.string().optional(),
  size: z.number().positive().optional(),
  weight: z.enum(AGENT_WEIGHTS).optional(),
  at: PlaceSchema,
});

const ComponentSchema = z.object({
  category: z.string(),
  parameters: z.array(z.string()).default([]),
  at: PlaceSchema,
});

/** Version 1 of the map: the shape `designlane prompt` asks an agent to write. */
export const AgentMapSchema = z.object({
  version: z.literal(1),
  /** The app's themes beside its default one (`Sepia`), whose colors `themes` gives. */
  themes: z.record(z.string(), z.record(z.string(), ColorSchema)).default({}),
  colors: z.record(z.string(), ColorSchema).default({}),
  textStyles: z.record(z.string(), TextStyleSchema).default({}),
  spacing: z.record(z.string(), NumberSchema).default({}),
  radii: z.record(z.string(), NumberSchema).default({}),
  components: z.record(z.string(), ComponentSchema).default({}),
});
export type AgentMap = z.infer<typeof AgentMapSchema>;

/** Whether `json` is a map, version 1 or later, rather than the first, unversioned agent file. */
export const isMap = (json: unknown): boolean =>
  typeof json === "object" && json !== null && "version" in json;

/** A place the map gives: the file and the line. */
export function placeOf(at: string): { file: string; line: number } {
  const colon = at.lastIndexOf(":");
  return { file: at.slice(0, colon), line: Number(at.slice(colon + 1)) };
}

/** A map's entry Designlane couldn't confirm where the map says it's written, and why. */
export interface Unconfirmed {
  /** How the code refers to it (`Theme.surface`), with its theme (`Sepia: Theme.surface`) for a theme's color. */
  reference: string;
  at: string;
  why: string;
}

export interface MapReading {
  scan: ScanResult;
  confirmed: number;
  unconfirmed: Unconfirmed[];
}

/** What a map's entries are checked against: each file's text, read once, from inside the app's folder only. */
type Texts = (file: string) => Promise<string | undefined>;

/** The scan with the map's design system in place of what Designlane found of the same kinds: its colors and themes,
 * text styles, spacing and corner radii, each one the code bears out where the map says it's written. A kind the map
 * gives none of is left as Designlane read it. */
export async function applyMap(scan: ScanResult, json: unknown): Promise<MapReading> {
  const parsed = AgentMapSchema.safeParse(json);
  if (!parsed.success)
    throw new Error(`the agent's map isn't in the expected shape: ${z.prettifyError(parsed.error)}`);
  const map = parsed.data;
  const [framework, ...others] = scan.frameworks;
  if (!framework) throw new Error("no app code to read the agent's map against");
  if (others.length)
    throw new Error("this repo has more than one app: run designlane and the agent in one app's folder");
  const cache = new Map<string, Promise<string | undefined>>();
  const texts: Texts = (file) => {
    let text = cache.get(file);
    if (!text) {
      // Read once, its comments blanked once: each of the file's entries reads the same code.
      const language = languageOf(file);
      text = realPathInside(scan.root, file)
        .then((real) => (real ? readText(real) : undefined))
        .then((read) => (read !== undefined && language ? withoutComments(read, language) : read));
      cache.set(file, text);
    }
    return text;
  };
  const unconfirmed: Unconfirmed[] = [];
  let confirmed = 0;
  const known = framework.tokens;
  const usesOf = (reference: string, from: { reference?: string; uses: number }[]) =>
    from.find((t) => t.reference === reference)?.uses ?? 0;

  // Each color read, by how the code refers to it, so a color written as another's name (`primary = Purple40`) is
  // read through it: Designlane's own first, then the map's as each is confirmed.
  const base = new Names();
  for (const c of known.colors) {
    const light = c.locations?.light;
    if (c.reference && light)
      base.add(c.reference, {
        light: { value: c.light, location: light },
        dark:
          c.dark && c.locations?.dark
            ? { value: c.dark, location: c.locations.dark }
            : { value: c.light, location: light },
      });
  }

  const colorsOf = async (
    entries: Record<string, z.infer<typeof ColorSchema>>,
    names: Names,
    theme?: string,
  ) => {
    const out: ColorToken[] = [];
    const label = (reference: string) => (theme ? `${theme}: ${reference}` : reference);
    let pending = Object.entries(entries);
    // Read until a pass confirms no more: a color may be written as the name of one later in the map, which is read
    // first, before one of the same name read already (a theme's own `accent` before the default theme's).
    let waiting = true;
    while (pending.length > 0) {
      const later: typeof pending = [];
      const unread = new Set(waiting ? pending.flatMap(([r]) => [r, nameOf(r)]) : []);
      for (const [reference, color] of pending) {
        const light = await colorAt(texts, reference, color.light, names, "light", unread);
        const dark = color.dark && (await colorAt(texts, reference, color.dark, names, "dark", unread));
        const failed = [light, dark].find((r) => r !== undefined && "why" in r);
        if (failed && "why" in failed) {
          if ("waiting" in failed) later.push([reference, color]);
          else unconfirmed.push({ reference: label(reference), at: failed.at, why: failed.why });
          continue;
        }
        if ("why" in light || (dark && "why" in dark)) continue;
        const { file, line } = placeOf(color.light.at);
        out.push({
          name: nameOf(reference),
          light: light.value,
          ...(dark && { dark: dark.value }),
          source: file,
          reference,
          line,
          kind: file.endsWith(".json") ? "asset" : "code",
          uses: usesOf(reference, known.colors),
          locations: { light: light.location, ...(dark && { dark: dark.location }) },
        });
        // A color given one value is that in both appearances; one given a light and a dark, the dark only if read.
        names.add(reference, { light, ...((dark || !light.pair) && { dark: dark || light }) });
        confirmed++;
      }
      if (later.length === pending.length && waiting) {
        waiting = false;
        continue;
      }
      if (later.length === pending.length) {
        for (const [reference, color] of later)
          unconfirmed.push({
            reference: label(reference),
            at: color.light.at,
            why: "it's written as the name of a color Designlane couldn't confirm",
          });
        break;
      }
      pending = later;
      waiting = true;
    }
    return out;
  };

  const colors = await colorsOf(map.colors, base);
  const themes: ColorTheme[] = [];
  // A theme's colors are read through its own, then the default theme's.
  for (const [name, entries] of Object.entries(map.themes))
    themes.push({ name, colors: await colorsOf(entries, new Names(base), name) });

  const typeStyles: TypeStyle[] = [];
  for (const [reference, style] of Object.entries(map.textStyles)) {
    const read = await textStyleAt(texts, reference, style);
    if ("why" in read) {
      unconfirmed.push({ reference, at: style.at, why: read.why });
      continue;
    }
    typeStyles.push({
      name: nameOf(reference),
      kind: "app",
      family: style.family && PLATFORM_FONT.test(style.family) ? "System" : (style.family ?? ""),
      ...(style.size !== undefined && { size: style.size }),
      weight: style.weight ?? "regular",
      ...(style.weight === undefined && { inherits: ["weight" as const] }),
      reference,
      uses: usesOf(reference, known.typeStyles),
      locations: read.locations,
    });
    confirmed++;
  }

  const stepsOf = async (entries: Record<string, z.infer<typeof NumberSchema>>, scanned: ScaleStep[]) => {
    const out: ScaleStep[] = [];
    for (const [reference, step] of Object.entries(entries)) {
      const read = await numberAt(texts, reference, step);
      if ("why" in read) {
        unconfirmed.push({ reference, at: step.at, why: read.why });
        continue;
      }
      const { file, line } = placeOf(step.at);
      out.push({
        name: nameOf(reference),
        value: step.value,
        reference,
        source: file,
        line,
        uses: usesOf(reference, scanned),
        location: read.location,
      });
      confirmed++;
    }
    return out.sort((a, b) => a.value - b.value);
  };
  const spacing = await stepsOf(map.spacing, known.scales?.spacing ?? []);
  const radii = await stepsOf(map.radii, known.scales?.radii ?? []);

  // The map leads where it gives a kind: Designlane's named tokens of that kind give way to it, and values written
  // without a name, which the map doesn't list, stay for drift.
  const tokens: DesignTokens = {
    ...known,
    colors:
      Object.keys(map.colors).length > 0
        ? [...colors, ...known.colors.filter((c) => c.kind === "inline")]
        : known.colors,
    ...(Object.keys(map.themes).length > 0 && { themes }),
    typeStyles:
      Object.keys(map.textStyles).length > 0
        ? [...typeStyles, ...known.typeStyles.filter((s) => s.kind !== "app")]
        : known.typeStyles,
  };
  const scales = {
    spacing: Object.keys(map.spacing).length > 0 ? spacing : (known.scales?.spacing ?? []),
    radii: Object.keys(map.radii).length > 0 ? radii : (known.scales?.radii ?? []),
  };
  if (scales.spacing.length > 0 || scales.radii.length > 0) tokens.scales = scales;
  else delete tokens.scales;
  const merged: FrameworkScan = { ...framework, tokens };
  return { scan: { ...scan, frameworks: [merged] }, confirmed, unconfirmed };
}

/** The last name in a reference: `surface` in `Theme.surface`, `md` in `spacing.md`. */
const nameOf = (reference: string) => namesOf(reference).at(-1) ?? reference;

/** A reference's names, a bracket's string as one: `textSizes['10pt']` is `textSizes`, `10pt`. */
const namesOf = (reference: string) =>
  [...reference.matchAll(/\[\s*["']([^"']+)["']\s*\]|[A-Za-z_$][\w$-]*/g)].map((m) => m[1] ?? m[0]);

type Read<T> = T | { why: string; at: string };

/** The definition the map's entry is at, its file's text with comments blanked, or why there's none. */
async function definitionAt(
  texts: Texts,
  reference: string,
  at: string,
  appearance?: "light" | "dark",
): Promise<Read<{ file: string; line: number; code: string; definition: Definition }>> {
  const { file, line } = placeOf(at);
  const text = await texts(file);
  if (text === undefined) return { why: "the file isn't in the app's folder", at };
  const language = languageOf(file);
  if (!language) return { why: "Designlane doesn't read this kind of file", at };
  const code = text;
  const span = lineAt(code, line);
  if (!span) return { why: `the file has no line ${line}`, at };
  // An asset catalog's color is the entry opening at the line, not a name.
  if (language === "json") return { file, line, code, definition: { name: nameOf(reference), ...span } };
  const names = namesOf(reference).slice(-2).reverse();
  const definition = definitionOnLine(code, line, language, names, appearance);
  if (!definition) return { why: `no ${nameOf(reference)} is defined there`, at };
  return { file, line, code, definition };
}

const locationOf = (
  file: string,
  line: number,
  found: { start: number; end: number; kind: ValueLocation["kind"] },
): ValueLocation => ({ file, line, start: found.start, end: found.end, kind: found.kind });

/** A color read, and where its value is written: one of a light and a dark given together, for `pair`. */
interface Located {
  value: string;
  location: ValueLocation;
  pair?: boolean;
}

interface ReadColor {
  light: Located;
  dark?: Located;
}

/** The colors read so far, by how the code refers to each, so another written as its name is read through it: by
 * its whole reference (`Theme.surface`), or, for a name written bare (`surface`), by its last name when only one
 * color has it. */
class Names {
  private readonly byReference = new Map<string, ReadColor>();
  private readonly byName = new Map<string, Set<string>>();
  constructor(private readonly parent?: Names) {}

  add(reference: string, read: ReadColor) {
    this.byReference.set(reference, read);
    const name = nameOf(reference);
    this.byName.set(name, (this.byName.get(name) ?? new Set()).add(reference));
  }

  /** Whether `name` is of a color read here, not in a theme this one's read through. */
  has(name: string): boolean {
    return this.byReference.has(name) || this.byName.has(name);
  }

  get(name: string): ReadColor | undefined {
    const own = this.byReference.get(name);
    if (own) return own;
    if (!name.includes(".")) {
      const references = this.byName.get(name);
      if (references?.size === 1) return this.byReference.get([...references][0] ?? "");
      if (references && references.size > 1) return undefined;
    }
    return this.parent?.get(name);
  }
}

async function colorAt(
  texts: Texts,
  reference: string,
  given: { value: string; at: string },
  names: Names,
  appearance: "light" | "dark",
  unread: Set<string>,
): Promise<Read<Located> | { why: string; at: string; waiting: true }> {
  const value = colorOf(given.value);
  if (!value) return { why: `${given.value} isn't a color`, at: given.at };
  const at = await definitionAt(texts, reference, given.at, appearance);
  if ("why" in at) return at;
  const written = colorValue(at.file, at.code, at.definition, appearance);
  if (!written) return { why: "no color is written there", at: given.at };
  if ("name" in written) {
    // A color written as another's name: its value is where that one's is, reached through this name.
    const self = written.name === reference || written.name === nameOf(reference);
    const target =
      unread.has(written.name) && !self && !names.has(written.name) ? undefined : names.get(written.name);
    if (!target) return { why: `${written.name} isn't a color Designlane read`, at: given.at, waiting: true };
    const through = appearance === "dark" ? target.dark : target.light;
    if (!through) return { why: `${written.name}'s dark color isn't one Designlane read`, at: given.at };
    if (through.value !== value)
      return { why: `${written.name} is ${through.value} there, not ${value}`, at: given.at };
    const via: CodeSpan = { file: at.file, line: at.line, start: written.start, end: written.end };
    return { value, location: { ...through.location, via: [via, ...(through.location.via ?? [])] } };
  }
  const found = "colors" in written ? written.colors : written[appearance];
  const match = found.find((f) => holdsColor(f.value, value));
  if (match)
    return {
      value,
      location: locationOf(at.file, at.line, match),
      ...(!("colors" in written) && { pair: true }),
    };
  const there = found[0];
  return there
    ? { why: `the code there writes ${showColor(there.value as Color)}, not ${value}`, at: given.at }
    : { why: "no color is written there", at: given.at };
}

async function numberAt(
  texts: Texts,
  reference: string,
  given: { value: number; at: string },
): Promise<Read<{ location: ValueLocation }>> {
  const at = await definitionAt(texts, reference, given.at);
  if ("why" in at) return at;
  const found = numberValue(at.code, at.definition, nameOf(reference));
  if (found?.value === given.value) return { location: locationOf(at.file, at.line, found) };
  return {
    why: found
      ? `the code there writes ${found.value}, not ${given.value}`
      : "no number is written there whole",
    at: given.at,
  };
}

/** Where a Compose family's font is written: in its value (`FontFamily(Font(R.font.inter))`), or in the value of
 * the family it names, defined in the same file (`fontFamily = appFontFamily`). */
function fontOf(
  code: string,
  family: { value: string; start: number; end: number },
): { start: number; end: number } {
  if (!/^[A-Za-z_]\w*$/.test(family.value)) return family;
  const defined = new RegExp(`\\bval\\s+${family.value}\\s*(?::[^=\\n]+)?=\\s*`).exec(code);
  const value = defined && valueAfter(code, defined.index + defined[0].length);
  return value ?? family;
}

/** Whether a font resource's name (`roboto_regular_mono`) is of `family` (`roboto mono`): its words, in order,
 * starting with the first. */
function namesFont(resource: string, family: string): boolean {
  const words = family
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean);
  const parts = resource.toLowerCase().split("_");
  if (words[0] !== parts[0]) return false;
  let at = 0;
  for (const part of parts) if (part === words[at]) at++;
  return at === words.length;
}

/** How an agent names the platform's font. */
const PLATFORM_FONT = /^(?:system|default)$/i;

/** The weights an agent names, by the hundreds the code gives them. */
const WEIGHT_VALUES: Record<(typeof AGENT_WEIGHTS)[number], number> = {
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

async function textStyleAt(
  texts: Texts,
  reference: string,
  style: z.infer<typeof TextStyleSchema>,
): Promise<Read<{ locations: TypeLocations }>> {
  if (style.size === undefined && !style.family)
    return { why: "it gives neither a size nor a family", at: style.at };
  const at = await definitionAt(texts, reference, style.at);
  if ("why" in at) return at;
  const written = textStyleValue(at.file, at.code, at.definition);
  const locations: TypeLocations = {};
  if (style.size !== undefined) {
    if (written.size?.value !== style.size)
      return {
        why: written.size
          ? `its size there is ${written.size.value}, not ${style.size}`
          : `no size is written there`,
        at: style.at,
      };
    locations.fontSize = locationOf(at.file, at.line, written.size);
  }
  if (style.family && PLATFORM_FONT.test(style.family)) {
    // The platform's font is one no name is written for (`.system(size: 17)`): one that is, isn't it.
    // Compose names the platform's font too: `FontFamily.Default`, `FontFamily.SansSerif`.
    if (written.family && !/^FontFamily\.(?:Default|SansSerif)$/.test(written.family.value))
      return { why: `its family there is ${written.family.value}, not the platform's`, at: style.at };
  } else if (style.family) {
    const family = written.family;
    const wanted = style.family.toLowerCase();
    const named = family?.kind === "literal" ? family.value.toLowerCase() : undefined;
    // Compose's font is a resource the family names: `FontFamily(Font(R.font.inter_variable))` for Inter.
    const font = family?.kind === "identifier" ? fontOf(at.code, family) : undefined;
    const resource = font && /\bR\.font\.(\w+)/.exec(at.code.slice(font.start, font.end));
    if (family && font && resource && namesFont(resource[1] ?? "", wanted)) {
      const start = font.start + resource.index + resource[0].length - (resource[1] ?? "").length;
      locations.fontFamily = locationOf(at.file, at.line, {
        start,
        end: start + (resource[1] ?? "").length,
        kind: "family-name",
      });
    } else {
      // A font's file name names its family and weight: `Inter-SemiBold`.
      const kind = named === wanted ? "literal" : named?.startsWith(`${wanted}-`) ? "family-name" : undefined;
      if (!family || !kind) return { why: `the family ${style.family} isn't written there`, at: style.at };
      locations.fontFamily = locationOf(at.file, at.line, { ...family, kind });
    }
  }
  if (style.weight) {
    const wanted = WEIGHT_VALUES[style.weight];
    // Text given no weight is regular, so a regular style's weight needn't be written, and has no place.
    if (
      written.weight?.value !== wanted &&
      (written.weight || written.weighted || style.weight !== "regular")
    )
      return {
        why: written.weight
          ? `its weight there is ${written.weight.value}, not ${style.weight}`
          : `the weight ${style.weight} isn't written there`,
        at: style.at,
      };
    if (written.weight) locations.fontWeight = locationOf(at.file, at.line, written.weight);
  }
  return { locations };
}
