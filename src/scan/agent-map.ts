/**
 * A coding agent's map of an app's design system: every token, and every component, with the place in the code it's
 * written. Designlane checks each one where the map says, with its own readers, and the tokens it bears out are the
 * app's design system: the map decides what the design system is, and the code what each value is.
 */

import path from "node:path";
import { z } from "zod";
import { type Color, showColor } from "../edit/color-value.js";
import { languageOf } from "../edit/notation.js";
import { colorOf } from "../frameworks/css-color.js";
import { lineNumbers } from "../frameworks/source-text.js";
import { withOpacityRounded } from "../frameworks/swiftui-colors.js";
import { listFiles, readText, realPathInside } from "./files.js";
import {
  colorValue,
  type Definition,
  definitionAt as definitionOnLine,
  definitionsAt,
  type Found,
  holdsColor,
  isAssetCatalog,
  lineAt,
  numberValue,
  openBrackets,
  sizeName,
  type TextStyleValue,
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

/** Why a map's entry wasn't confirmed, as a kind that stays the same release to release: what an agent fixing its
 * map, or a tool grouping them, goes by. */
export const UNCONFIRMED_KINDS = {
  "outside-app": "the file isn't in the app's folder",
  "unread-file": "Designlane doesn't read this kind of file",
  "no-line": "the file has no such line",
  "no-definition": "nothing of that name is defined at the line",
  "invalid-value": "the map's value isn't a color",
  "other-value": "the code there gives another value",
  "no-color": "no color is written there whole",
  "no-number": "no number is written there whole",
  "no-size": "no size is written there",
  "no-family": "the family isn't written there",
  "no-weight": "the weight isn't written there",
  "no-size-or-family": "the map gives neither a size nor a family",
  "unread-name": "it's written as a name Designlane couldn't read",
  "no-component": "no view of that name is declared there",
  "no-parameter": "the component doesn't take that parameter",
} as const;
export type UnconfirmedKind = keyof typeof UNCONFIRMED_KINDS;

/** A map's entry Designlane couldn't confirm where the map says it's written, and why. */
export interface Unconfirmed {
  /** How the code refers to it (`Theme.surface`), with its theme (`Sepia: Theme.surface`) for a theme's color. */
  reference: string;
  at: string;
  kind: UnconfirmedKind;
  why: string;
}

export type MapComponent = z.infer<typeof ComponentSchema>;

export interface MapReading {
  scan: ScanResult;
  /** The map's components, by name, for the catalog to check: its readers read a view's declaration. */
  components: Record<string, MapComponent>;
  confirmed: number;
  unconfirmed: Unconfirmed[];
}

/** What a map's entries are checked against: each file's text, read once, from inside the app's folder only. */
type Texts = (file: string) => Promise<string | undefined>;

/** The app's code: each file's text, and its files, listed once, for a name defined in a file other than where it's
 * written. */
interface Code {
  texts: Texts;
  files: () => Promise<string[]>;
}

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
  let listed: Promise<string[]> | undefined;
  const files = () => {
    listed ??= listFiles(scan.root).then((list) => list.files.map((f) => f.rel));
    return listed;
  };
  const code: Code = { texts, files };
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
          else
            unconfirmed.push({
              reference: label(reference),
              at: failed.at,
              kind: failed.kind,
              why: failed.why,
            });
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
          kind: isAssetCatalog(file) ? "asset" : "code",
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
            kind: "unread-name",
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
    const read = await textStyleAt(code, reference, style);
    if ("why" in read) {
      unconfirmed.push({ reference, at: style.at, kind: read.kind, why: read.why });
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
        unconfirmed.push({ reference, at: step.at, kind: read.kind, why: read.why });
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
  return { scan: { ...scan, frameworks: [merged] }, components: map.components, confirmed, unconfirmed };
}

/** The last name in a reference: `surface` in `Theme.surface`, `md` in `spacing.md`. */
const nameOf = (reference: string) => namesOf(reference).at(-1) ?? reference;

/** A reference's names, a bracket's string as one: `textSizes['10pt']` is `textSizes`, `10pt`. */
const namesOf = (reference: string) =>
  [...reference.matchAll(/\[\s*["']([^"']+)["']\s*\]|[A-Za-z_$][\w$-]*/g)].map((m) => m[1] ?? m[0]);

type Failure = { kind: UnconfirmedKind; why: string; at: string };
type Read<T> = T | Failure;

/** The definition the map's entry is at, its file's text with comments blanked, or why there's none. */
async function definitionAt(
  texts: Texts,
  reference: string,
  at: string,
  appearance?: "light" | "dark",
): Promise<Read<{ file: string; line: number; code: string; definition: Definition }>> {
  const { file, line } = placeOf(at);
  const text = await texts(file);
  if (text === undefined) return { kind: "outside-app", why: "the file isn't in the app's folder", at };
  const language = languageOf(file);
  if (!language) return { kind: "unread-file", why: "Designlane doesn't read this kind of file", at };
  const code = text;
  const span = lineAt(code, line);
  if (!span) return { kind: "no-line", why: `the file has no line ${line}`, at };
  // An asset catalog's color is the entry opening at the line, not a name.
  if (isAssetCatalog(file)) return { file, line, code, definition: { name: nameOf(reference), ...span } };
  const names = namesOf(reference).slice(-2).reverse();
  const definition = definitionOnLine(code, line, language, names, appearance);
  // JSON is only data, so its key is the name: no `primaryDisabled` for `colors.primary`.
  const named = language !== "json" || names.includes(definition?.name ?? "");
  if (!definition || !named)
    return { kind: "no-definition", why: `no ${nameOf(reference)} is defined there`, at };
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
  /** Each way the value may be written, when it's reached through opacity that isn't a whole byte: the value's
   * opacity rounded down and up. */
  writtenAs?: string[];
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
    // An Android resource (`@color/blue_500`) is only that resource, however it's referred to: never a constant of
    // its name in code.
    const resource = /^@color\/(\w+)$/.exec(name)?.[1];
    const references = resource
      ? [`@color/${resource}`, `R.color.${resource}`]
      : this.byReference.has(name) || name.includes(".")
        ? [name]
        : [...(this.byName.get(name) ?? [])];
    const read = references.flatMap((r) => this.byReference.get(r) ?? []);
    const [first] = read;
    // Two references to one color (`R.color.accent` and `@color/accent`) are one, not two of the name.
    if (first && read.every((r) => sameColor(r, first))) return first;
    if (read.length > 1) return undefined;
    return this.parent?.get(name);
  }
}

/** Whether two colors read are one: the same values, light and dark, written in the same places. */
function sameColor(a: ReadColor, b: ReadColor): boolean {
  const same = (x?: Located, y?: Located) =>
    x?.value === y?.value && x?.location.file === y?.location.file && x?.location.start === y?.location.start;
  return same(a.light, b.light) && same(a.dark, b.dark);
}

async function colorAt(
  texts: Texts,
  reference: string,
  given: { value: string; at: string },
  names: Names,
  appearance: "light" | "dark",
  unread: Set<string>,
): Promise<Read<Located> | (Failure & { waiting: true })> {
  const value = colorOf(given.value);
  if (!value) return { kind: "invalid-value", why: `${given.value} isn't a color`, at: given.at };
  const at = await definitionAt(texts, reference, given.at, appearance);
  if ("why" in at) return at;
  const written = colorValue(at.file, at.code, at.definition, appearance);
  if (!written) return { kind: "no-color", why: "no color is written there", at: given.at };
  if ("name" in written) {
    // A color written as another's name: its value is where that one's is, reached through this name.
    const self = written.name === reference || written.name === nameOf(reference);
    const target =
      unread.has(written.name) && !self && !names.has(written.name) ? undefined : names.get(written.name);
    if (!target)
      return {
        kind: "unread-name",
        why: `${written.name} isn't a color Designlane read`,
        at: given.at,
        waiting: true,
      };
    const through = appearance === "dark" ? target.dark : target.light;
    if (!through)
      return {
        kind: "unread-name",
        why: `${written.name}'s dark color isn't one Designlane read`,
        at: given.at,
      };
    // With opacity after the name, the color is that one's at the opacity the calls give it, rounded either way. The
    // value kept is Designlane's own rounding, so a name built on this one starts from it, not from the map's.
    const { value: reached, writtenAs } = written.opacity
      ? withOpacityRounded(through.value, written.opacity)
      : { value: through.value, writtenAs: through.writtenAs ?? [through.value] };
    if (!writtenAs.includes(value))
      return {
        kind: "other-value",
        why: written.opacity
          ? `${written.name} at that opacity is ${reached}, not ${value}`
          : `${written.name} is ${through.value} there, not ${value}`,
        at: given.at,
      };
    const via: CodeSpan = { file: at.file, line: at.line, start: written.start, end: written.end };
    return {
      value: reached,
      ...(writtenAs.length > 1 && { writtenAs }),
      location: { ...through.location, via: [via, ...(through.location.via ?? [])] },
      ...((at.definition.ofPair || through.pair) && { pair: true }),
    };
  }
  const found = "colors" in written ? written.colors : written[appearance];
  const match = found.find((f) => holdsColor(f.value, value));
  if (match)
    return {
      value,
      location: locationOf(at.file, at.line, match),
      ...((!("colors" in written) || at.definition.ofPair) && { pair: true }),
    };
  const there = found[0];
  return there
    ? {
        kind: "other-value",
        why: `the code there writes ${showColor(there.value as Color)}, not ${value}`,
        at: given.at,
      }
    : { kind: "no-color", why: "no color is written there", at: given.at };
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
    kind: found ? "other-value" : "no-number",
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

/** How many names a size is followed through: `fontScale.finePrint` to `variables.fontSizeExtraSmall` to `9`. */
const MAX_NAMES = 3;

/** The number a size written as a name (`fontScale.finePrint`) is given where the name is defined, following a name
 * given another (`finePrint: variables.fontSizeExtraSmall`), and where the number is, reached through the names. */
async function sizeThroughName(
  code: Code,
  file: string,
  text: string,
  name: Found<string>,
  via: CodeSpan[] = [],
): Promise<{ value: number; location: ValueLocation } | Failure> {
  const through = [...via, spanOf(file, text, name)];
  const defined = await definedOnce(code, file, name.value, (c, d) => sizeWritten(c, d, nameOf(name.value)));
  const size = defined?.value;
  if (defined && size && "name" in size && through.length < MAX_NAMES)
    return sizeThroughName(code, defined.file, defined.code, size.name, through);
  if (!defined || !size || !("number" in size))
    return { kind: "unread-name", why: `${name.value} isn't defined once in the app as a number`, at: "" };
  const { number } = size;
  return {
    value: number.value,
    location: { ...locationOf(defined.file, lineOf(defined.code, number.start), number), via: through },
  };
}

/** A size where a name is defined: a number, or another name. */
function sizeWritten(
  code: string,
  definition: Definition,
  label: string,
): { number: Found<number> } | { name: Found<string> } | undefined {
  const number = numberValue(code, definition, label);
  if (number) return { number };
  const name = sizeName(code, definition);
  return name && { name };
}

/** Where `written` (`fontScale.finePrint`) is defined with a value `read` reads, and only when that's one place:
 * in the file its owner is imported from (`import fontScale from './typography'`), or else in `file`, then in the
 * app's other files of its language. A name with owners counts only inside each of theirs, so neither
 * `lineHeightScale.finePrint` nor `dark.fontScale.finePrint` is taken for `light.fontScale.finePrint`. */
async function definedOnce<T>(
  code: Code,
  file: string,
  written: string,
  read: (code: string, definition: Definition) => T | undefined,
): Promise<{ file: string; code: string; value: T } | undefined> {
  const [name, ...owners] = namesOf(written).reverse();
  const language = languageOf(file);
  if (!name || !language) return undefined;
  const outer = owners.at(-1);
  const imported = outer ? await importOf(code, file, outer) : undefined;
  // An import Designlane can't follow (a package, an alias, `* as`) is no file to look in, nor any other.
  if (imported === null) return undefined;
  const chain = imported?.default ? [...owners.slice(0, -1), "default"] : owners;
  const word = new RegExp(`(?<![\\w$])${escapedName(name)}(?![\\w$])`, "g");
  const definedIn = async (other: string) => {
    const text = await code.texts(other);
    if (!text?.includes(name)) return [];
    const at = [...text.matchAll(word)].map((m) => m.index ?? 0);
    const lines = lineNumbers(text, at);
    const opens = openBrackets(text, at);
    return at.flatMap((offset, i) => {
      if (!ownedBy(text, opens[i] ?? [], chain)) return [];
      return definitionsAt(text, lines[i] ?? 1, language).flatMap((d) => {
        const value = d.name === name && d.start > offset ? read(text, d) : undefined;
        return value === undefined ? [] : [{ file: other, code: text, value }];
      });
    });
  };
  if (imported) {
    const found = await definedIn(imported.file);
    return found.length === 1 ? found[0] : undefined;
  }
  const own = await definedIn(file);
  if (own.length > 0) return own.length === 1 ? own[0] : undefined;
  const others: { file: string; code: string; value: T }[] = [];
  for (const other of await code.files())
    if (other !== file && languageOf(other) === language) others.push(...(await definedIn(other)));
  return others.length === 1 ? others[0] : undefined;
}

/** Whether brackets opened at `open` (outermost first) are, from the innermost, those of each of `owners`
 * (innermost first): the owner named on the line its bracket opens, as in `fontScale = {`, `object Dimens {`,
 * `enum FontSize {`, `export default {`. */
function ownedBy(code: string, open: number[], owners: string[]): boolean {
  return owners.every((owner, i) => {
    const bracket = open[open.length - 1 - i];
    if (bracket === undefined) return false;
    const opening = code.slice(code.lastIndexOf("\n", bracket - 1) + 1, bracket);
    return new RegExp(`(?<![\\w$])${escapedName(owner)}(?![\\w$])`).test(opening);
  });
}

/** The app's file `file` imports `name` from, with a relative path: as its default export
 * (`import variables from './variables'`) or by name (`import { fontScale } from './typography'`). Undefined when
 * `file` doesn't import it, and null when it does in a way Designlane doesn't follow. */
async function importOf(
  code: Code,
  file: string,
  name: string,
): Promise<{ file: string; default: boolean } | null | undefined> {
  const text = await code.texts(file);
  const n = escapedName(name);
  const statement =
    text &&
    new RegExp(
      `\\bimport\\b${IN_IMPORT}*?(?<![\\w$])${n}(?![\\w$])${IN_IMPORT}*?\\bfrom\\s*(["'])([^"']+)\\1`,
    ).exec(text);
  if (!statement) return undefined;
  const isDefault = new RegExp(`^import\\s+(?:type\\s+)?${n}\\s*(?:,|from\\b)`).test(statement[0]);
  const isNamed = new RegExp(`\\{[^}]*(?<![\\w$])${n}(?![\\w$])(?!\\s+as\\b)[^}]*\\}`).test(statement[0]);
  const from = statement[2] ?? "";
  if ((!isDefault && !isNamed) || !from.startsWith(".")) return null;
  const base = path.posix.join(path.posix.dirname(file), from);
  const files = new Set(await code.files());
  const found = IMPORT_ENDINGS.map((ending) => base + ending).find((candidate) => files.has(candidate));
  return found ? { file: found, default: isDefault } : null;
}

/** A character of one import statement: not its end, nor the start of the next one. */
const IN_IMPORT = "(?:(?!\\bimport\\b)[^;])";

/** The files an import's path may name, by what's written after it. */
const IMPORT_ENDINGS = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"];

const escapedName = (name: string) => name.replace(/\$/g, "\\$");
const lineOf = (code: string, at: number) => lineNumbers(code, [at])[0] ?? 1;
const spanOf = (file: string, code: string, span: { start: number; end: number }): CodeSpan => ({
  file,
  line: lineOf(code, span.start),
  start: span.start,
  end: span.end,
});

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

/** A text style the map gives, checked part by part where it says it's written. A part the code there gives
 * another value for refuses the style; one Designlane can't read there (a family from a spread, a size worked out
 * as the app runs) is kept from the map without a place, so it's listed but never edited. The style is kept when
 * the code bears out at least one of its parts. */
async function textStyleAt(
  code: Code,
  reference: string,
  style: z.infer<typeof TextStyleSchema>,
): Promise<Read<{ locations: TypeLocations }>> {
  if (style.size === undefined && !style.family)
    return { kind: "no-size-or-family", why: "it gives neither a size nor a family", at: style.at };
  const at = await definitionAt(code.texts, reference, style.at);
  if ("why" in at) return at;
  const written = textStyleValue(at.file, at.code, at.definition);
  const parts: Part[] = [];
  if (style.size !== undefined) parts.push(await sizePart(code, at, written, style.size));
  if (style.family) parts.push(familyPart(at, written, style.family));
  if (style.weight) parts.push(weightPart(at, written, style.weight));
  const failures = parts.filter(isFailure);
  const wrong = failures.find((part) => !part.unread);
  if (wrong) return failureAt(wrong, style.at);
  const locations: TypeLocations = Object.assign({}, ...parts.filter((part) => !isFailure(part)));
  const [unread] = failures;
  if (Object.keys(locations).length === 0 && unread) return failureAt(unread, style.at);
  return { locations };
}

/** A part of a text style not borne out: `unread` when the code gives it in a way Designlane can't read there,
 * rather than not at all (a part not written is the platform's default, which the map's other value isn't). */
type Unread = Failure & { unread?: boolean };
/** One part of a text style: where the code there writes it, or why it isn't read there. */
type Part = TypeLocations | Unread;
const isFailure = (part: Part): part is Unread => "why" in part;
const failureAt = ({ kind, why }: Unread, at: string): Failure => ({ kind, why, at });
type StyleAt = { file: string; line: number; code: string };

async function sizePart(code: Code, at: StyleAt, written: TextStyleValue, wanted: number): Promise<Part> {
  // A size written as a name (`fontSize: fontScale.finePrint`) is the number that name is defined as.
  const size = written.size
    ? { value: written.size.value, location: locationOf(at.file, at.line, written.size) }
    : written.sizeName && (await sizeThroughName(code, at.file, at.code, written.sizeName));
  if (!size)
    return {
      kind: "no-size",
      why: "no size is written there",
      at: "",
      unread: !!(written.sized || written.builtOn),
    };
  if ("why" in size) return { ...size, unread: true };
  if (size.value !== wanted)
    return {
      kind: "other-value",
      why: written.sizeName
        ? `${written.sizeName.value} is ${size.value}, not ${wanted}`
        : `its size there is ${size.value}, not ${wanted}`,
      at: "",
    };
  return { fontSize: size.location };
}

function familyPart(at: StyleAt, written: TextStyleValue, wanted: string): Part {
  const family = written.family;
  if (PLATFORM_FONT.test(wanted)) {
    // The platform's font is one no name is written for (`.system(size: 17)`): one that is, isn't it.
    // Compose names the platform's font too: `FontFamily.Default`, `FontFamily.SansSerif`.
    if (family && !/^FontFamily\.(?:Default|SansSerif)$/.test(family.value))
      return { kind: "other-value", why: `its family there is ${family.value}, not the platform's`, at: "" };
    return {};
  }
  // Not written is no family but the platform's, unless the style is built on one that gives it.
  const notWritten = (unread: boolean): Unread => ({
    kind: "no-family",
    why: `the family ${wanted} isn't written there`,
    at: "",
    unread,
  });
  if (!family) return notWritten(!!written.builtOn);
  const name = wanted.toLowerCase();
  if (family.kind === "literal") {
    // A font's file name names its family and weight: `Inter-SemiBold`.
    const value = family.value.toLowerCase();
    const kind = value === name ? "literal" : value.startsWith(`${name}-`) ? "family-name" : undefined;
    if (!kind)
      return { kind: "other-value", why: `its family there is ${family.value}, not ${wanted}`, at: "" };
    return { fontFamily: locationOf(at.file, at.line, { ...family, kind }) };
  }
  // Compose's font is a resource the family names: `FontFamily(Font(R.font.inter_variable))` for Inter.
  const font = fontOf(at.code, family);
  const resource = /\bR\.font\.(\w+)/.exec(at.code.slice(font.start, font.end));
  // A family named, but not for a font resource Designlane reads (`fontFamily = brandFamily()`).
  if (!resource) return notWritten(true);
  if (!namesFont(resource[1] ?? "", name))
    return { kind: "other-value", why: `its font there is R.font.${resource[1]}, not ${wanted}`, at: "" };
  const start = font.start + resource.index + resource[0].length - (resource[1] ?? "").length;
  return {
    fontFamily: locationOf(at.file, at.line, {
      start,
      end: start + (resource[1] ?? "").length,
      kind: "family-name",
    }),
  };
}

function weightPart(at: StyleAt, written: TextStyleValue, wanted: (typeof AGENT_WEIGHTS)[number]): Part {
  const value = WEIGHT_VALUES[wanted];
  if (written.weight) {
    if (written.weight.value !== value)
      return {
        kind: "other-value",
        why: `its weight there is ${written.weight.value}, not ${wanted}`,
        at: "",
      };
    return { fontWeight: locationOf(at.file, at.line, written.weight) };
  }
  // Text given no weight is regular, so a regular style's weight needn't be written, and has no place. One given a
  // weight Designlane doesn't read (`.bold()`, `Inter-Bold`) isn't regular, but may be the map's other weight.
  if (wanted === "regular")
    return written.weighted
      ? { kind: "no-weight", why: "a weight is written there, so it isn't regular", at: "" }
      : {};
  return {
    kind: "no-weight",
    why: `the weight ${wanted} isn't written there`,
    at: "",
    unread: !!(written.weighted || written.builtOn),
  };
}
