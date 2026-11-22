/**
 * What a line of code defines, and the value each definition is given, with where it's written: what an agent's map
 * is checked against. A map's entry is confirmed only by the value its definition is given, read whole (`surface =
 * Color(hex: 0x121212)`, `md: 16`, `<color name="accent">#3366CC</color>`), never by something else written nearby: a
 * comment, a neighbor's value, an argument of an unrelated call, a number in a sum. Colors are read with the readers a
 * code edit uses, so a confirmed value is one an edit can change.
 */

import { assetReadings, callChannelReadings } from "../edit/color-channels.js";
import { hexReadings } from "../edit/color-hex.js";
import type { Color } from "../edit/color-value.js";
import { type Language, languageOf } from "../edit/notation.js";
import { weightReadings } from "../edit/type-values.js";
import { colorOf } from "../frameworks/css-color.js";
import type { ValueKind } from "./types.js";

/** A value found, and where its text is written in the file: what an edit would replace. */
export interface Found<T> {
  value: T;
  start: number;
  end: number;
  kind: ValueKind;
}

/** Where some text is written in a file. */
export interface Span {
  start: number;
  end: number;
}

/** A name a line defines, and where the value it's given is written. */
export interface Definition extends Span {
  name: string;
}

/** How many lines a value is read over. */
const MAX_VALUE_LINES = 40;

/** Skips the string starting at `at`, giving where it ends: a quote's own line, or a JavaScript template's close. */
function stringEnd(text: string, at: number): number {
  const quote = text[at];
  for (let i = at + 1; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === quote) return i + 1;
    else if (c === "\n" && quote !== "`") return i;
  }
  return text.length;
}

/** `text` with its comments as spaces, at the same offsets: `//`, `/* *\/` (nested in Swift and Kotlin), and XML's
 * `<!-- -->`. A comment's quotes and brackets don't count, and strings are kept. */
export function withoutComments(text: string, language: Language): string {
  const out = text.split("");
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (out[i] !== "\n") out[i] = " ";
  };
  for (let i = 0; i < text.length; i++) {
    if (language === "xml") {
      if (!text.startsWith("<!--", i)) continue;
      const end = text.indexOf("-->", i + 4);
      const to = end === -1 ? text.length : end + 3;
      blank(i, to);
      i = to - 1;
      continue;
    }
    const c = text[i];
    if (c === '"' || c === "'" || (c === "`" && language === "js")) {
      // Swift and Kotlin's `'` isn't a string: a character in Kotlin, never in Swift.
      if (c === "'" && language === "swift") continue;
      i = stringEnd(text, i) - 1;
    } else if (c === "/" && text[i + 1] === "/" && language !== "json") {
      const end = text.indexOf("\n", i);
      const to = end === -1 ? text.length : end;
      blank(i, to);
      i = to - 1;
    } else if (c === "/" && text[i + 1] === "*" && language !== "json") {
      const nests = language === "swift" || language === "kotlin";
      let depth = 0;
      let j = i;
      for (; j < text.length; j++) {
        if (text.startsWith("/*", j) && (nests || depth === 0)) {
          depth++;
          j++;
        } else if (text.startsWith("*/", j)) {
          depth--;
          j++;
          if (depth === 0) break;
        }
      }
      const to = Math.min(j + 1, text.length);
      blank(i, to);
      i = to - 1;
    }
  }
  return out.join("");
}

/** Each line's start in the text last asked about: a map's entries are mostly of a few files, each read in turn. */
let starts: { text: string; at: number[] } | undefined;

/** Where line `line` (1-based) of `text` starts and ends, or undefined for a line it doesn't have. */
export function lineAt(text: string, line: number): Span | undefined {
  if (!Number.isInteger(line) || line < 1) return undefined;
  if (starts?.text !== text) {
    const at = [0];
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) at.push(i + 1);
    starts = { text, at };
  }
  const start = starts.at[line - 1];
  if (start === undefined) return undefined;
  const next = starts.at[line];
  return { start, end: next === undefined ? text.length : next - 1 };
}

/** `text` with each string's contents as spaces, its quotes kept: where a definition can be, never inside one. */
function withoutStrings(text: string): string {
  let out = "";
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== '"' && c !== "'" && c !== "`") continue;
    const end = stringEnd(text, i);
    out +=
      text.slice(from, i + 1) + " ".repeat(Math.max(0, end - i - 2)) + (end - i >= 2 ? text[end - 1] : "");
    from = end;
    i = end - 1;
  }
  return out + text.slice(from);
}

/** A name given a value with `=`: `let surface: Color =`, `val Purple40 =`, `primary =` as an argument, `const X =`. */
const ASSIGNED = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?::\s*[\w.<>?[\] ]{1,60}?\s*)?=(?![=>])/g;
/** A computed property: `var tint: Color {`. */
const COMPUTED = /\b(?:var|val)\s+([A-Za-z_$][\w$]*)\s*:\s*[\w.<>?]+\s*\{/g;
/** A key given a value: `surface:` and `"surface":` in JavaScript and JSON, `color:` in CSS. */
const KEYED = /(?<![\w$.-])(?:(["'])([^"'\n]+)\1|([A-Za-z_$-][\w$-]*))\s*:(?!:)/g;
/** An Android resource: `<color name="accent">#FF3366CC</color>`, `<dimen name="md">16dp</dimen>`. */
const RESOURCE = /<(?:color|dimen|integer|item)\b[^>]*\bname="([^"]+)"[^>]*>([^<]*)</g;

/** The definitions written on line `line` of `code`, whose comments are blanked, each with its value. */
export function definitionsAt(code: string, line: number, language: Language): Definition[] {
  const span = lineAt(code, line);
  if (!span) return [];
  const written = code.slice(span.start, span.end);
  // A definition is never in a string (`"x = Color.white;"`); a resource's tag is all written in its file's strings.
  const text = language === "xml" ? written : withoutStrings(written);
  const out: Definition[] = [];
  if (language === "xml") {
    for (const m of text.matchAll(RESOURCE)) {
      const written = m[2] ?? "";
      const end = span.start + (m.index ?? 0) + m[0].length - 1;
      out.push({ name: m[1] ?? "", ...trimmed(code, end - written.length, end) });
    }
    return out;
  }
  const add = (name: string, value: Span | undefined) => {
    if (value && !out.some((d) => d.start === value.start)) out.push({ name, ...value });
  };
  if (language === "swift" || language === "kotlin")
    for (const m of text.matchAll(COMPUTED))
      add(m[1] ?? "", blockValue(code, span.start + (m.index ?? 0) + m[0].length - 1));
  if (language !== "css" && language !== "json")
    for (const m of text.matchAll(ASSIGNED))
      add(m[1] ?? "", valueAfter(code, span.start + (m.index ?? 0) + m[0].length));
  // Swift's argument labels give a value too: `ColorPalette(accent: .blue, contrastingLabel: .white)`.
  const opens = language === "swift" ? /[{,;([]$/ : /[{,;]$/;
  if (language !== "kotlin")
    for (const m of text.matchAll(KEYED)) {
      // A key starts an entry, an argument or a CSS declaration: after `{`, `,`, `;` or at its line's start (in Swift,
      // after `(` or `[` too), not a ternary's `:` or a type's.
      const before = code.slice(span.start, span.start + (m.index ?? 0)).trimEnd();
      if (before !== "" && !opens.test(before)) continue;
      // A quoted key's name is read from the code, its strings being blanked where definitions are looked for.
      const at = m.index ?? 0;
      const name = m[2] === undefined ? (m[3] ?? "") : written.slice(at + 1, at + 1 + m[2].length);
      const value = valueAfter(code, span.start + at + m[0].length);
      // A parameter's default, `cornerRadius: CGFloat = 4`, is its `=` definition's, read already.
      if (value && out.some((d) => d.name === name && d.start >= value.start && d.start <= value.end))
        continue;
      add(name, value);
    }
  return out.sort((a, b) => a.start - b.start);
}

/** How many lines above the map's line the definition holding it is looked for. */
const MAX_ABOVE = 3;

/** The definition the map means at line `line`: one of `names` (the reference's last name, then the one before it:
 * `badge` for `FrameConfig.badge.cornerRadius`) defined there, or holding the line from a few lines above (a
 * computed property's body, a style object's `fontSize: 20,`), or the line's one definition when it's named for what
 * the map names (`title` for `scaledTitle`). None when that can't be told. */
export function definitionAt(
  code: string,
  line: number,
  language: Language,
  names: string[],
  appearance?: "light" | "dark",
): Definition | undefined {
  const span = lineAt(code, line);
  if (!span) return undefined;
  const own = definitionsAt(code, line, language);
  for (const name of names) {
    const named = own.filter((d) => d.name === name || d.name.replace(/^--/, "") === name);
    // Two of the name on one line (`light: { text: … }, dark: { text: … }`): which one is meant can't be told.
    if (named.length > 0) return named.length === 1 ? named[0] : undefined;
  }
  // The line's own text, without its indent: what a definition above holds.
  const text = trimmed(code, span.start, span.end);
  for (let above = line - 1; above >= Math.max(1, line - MAX_ABOVE); above--) {
    const holding = definitionsAt(code, above, language).filter(
      (d) =>
        d.start <= text.start &&
        d.end >= text.end &&
        (names.includes(d.name) || related(d.name, names[0] ?? "", appearance)),
    );
    if (holding.length === 1) return holding[0];
  }
  // The line's own definitions, not those within one's value (`hex:` in `surface = Color(hex: 0x121212)`).
  const top = own.filter((d) => !own.some((o) => o !== d && o.start <= d.start && d.end <= o.end));
  const [only] = top;
  const [name = ""] = names;
  return top.length === 1 && only && related(only.name, name, appearance) ? only : undefined;
}

/** Whether one name holds the other, as `scaledTitle` does `title`, or `surfaceDark` the dark `surface`, but not its
 * light one. */
function related(defined: string, name: string, appearance?: "light" | "dark"): boolean {
  // A private constant's underscore isn't part of the name: `_background` is the one `themedBackground` is made of.
  const a = defined.replace(/^_+/, "").toLowerCase();
  const b = name.toLowerCase();
  if (a === b || !(a.includes(b) || b.includes(a))) return false;
  const rest = a.replace(b, "");
  return rest === "dark" ? appearance === "dark" : rest === "light" ? appearance !== "dark" : true;
}

/** A value from `at` to where it ends: a `,` or `;` outside brackets, the bracket closing the one it's in, or its
 * line's end, unless the next line goes on with it (`.weight(.bold)`, an operator). */
export function valueAfter(code: string, at: number): Span | undefined {
  let depth = 0;
  let lines = 0;
  let i = at;
  for (; i < code.length; i++) {
    const c = code[i] ?? "";
    if (c === '"' || c === "'" || c === "`") {
      i = stringEnd(code, i) - 1;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && (c === "," || c === ";")) break;
    else if (c === "\n") {
      if (++lines > MAX_VALUE_LINES) return undefined;
      if (depth === 0 && !GOES_ON.test(code.slice(i + 1, i + 200))) break;
    }
  }
  const value = trimmed(code, at, i);
  return value.end > value.start ? value : undefined;
}

/** A line going on with the value before it: a member (`.weight(.bold)`) or an operator. */
const GOES_ON = /^\s*(?:\.[A-Za-z_]|[?:+\-*/|&](?!\/))/;

/** A computed property's value: what its block gives, its `return` aside (`var tint: Color { return .white }`). */
function blockValue(code: string, open: number): Span | undefined {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'") i = stringEnd(code, i) - 1;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      const inner = trimmed(code, open + 1, i);
      const ret = /^return\s+/.exec(code.slice(inner.start, inner.end));
      return ret ? { start: inner.start + ret[0].length, end: inner.end } : inner;
    }
  }
  return undefined;
}

function trimmed(code: string, start: number, end: number): Span {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(code[s] ?? "")) s++;
  while (e > s && /\s/.test(code[e - 1] ?? "")) e--;
  return { start: s, end: e };
}

/** What a color definition's value is: a color written in place (each of its readings, for eight hex digits whose
 * opacity may be first or last), a light and a dark one, or another color's name. */
export type ColorValue =
  | { colors: Found<Color>[] }
  | { light: Found<Color>[]; dark: Found<Color>[] }
  | { name: string; start: number; end: number };

/** The colors SwiftUI and Compose name that are the same everywhere (`.white`, `Color.Black`, `.clear`), not the
 * platform's adapting ones (`.red`, `.secondary`). */
const NAMED_COLORS: Record<string, string> = {
  white: "#ffffff",
  black: "#000000",
  clear: "#00000000",
  transparent: "#00000000",
};
const NAMED_COLOR = /^(?:(?:UI|NS)?Color)?\.(white|black|clear|White|Black|Transparent)$/;
/** Calls that make a color, whose arguments are its value. */
const COLOR_CALL =
  /^(?:\.init|(?:UI|NS)?Color(?:\.init)?|Color\.(?:rgb|argb|hex|fromRGBO?|fromARGB)|rgba?|hsla?)\(/;
const HEX = /^#[0-9a-fA-F]{3,8}$/;
/** Another color's name: `Purple40`, `.brand`, `Color.brand`, `colors.primary`. */
const NAME = /^\.?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
/** A light and a dark color given together: `Color(light: …, dark: …)`. */
const PAIR = /^(?:\.init|(?:UI|NS)?Color(?:\.init)?)\(\s*(?:light|any)\s*:/;

/** The color value written whole from `span.start` to `span.end` of `code` in `file`. */
export function colorValue(
  file: string,
  code: string,
  span: Span,
  appearance?: "light" | "dark",
): ColorValue | undefined {
  const language = languageOf(file);
  if (!language) return undefined;
  if (language === "json") return { colors: assetColor(code, span, appearance) };
  const value = code.slice(span.start, span.end);
  if (PAIR.test(value) && closeOf(value) === value.length - 1) {
    const labelled = (label: RegExp) => {
      const m = label.exec(value);
      return m ? valueAfter(code, span.start + m.index + m[0].length) : undefined;
    };
    const light = labelled(/\b(?:light|any)\s*:\s*/);
    const dark = labelled(/\bdark\s*:\s*/);
    if (!light || !dark) return undefined;
    return { light: colorsWritten(language, code, light), dark: colorsWritten(language, code, dark) };
  }
  const colors = colorsWritten(language, code, span);
  if (colors.length > 0) return { colors };
  if (NAME.test(value) && !NAMED_COLOR.test(value))
    return { name: value.replace(/^\./, ""), start: span.start, end: span.end };
  return undefined;
}

/** The readings of a color written whole: nothing before or after it, like `.opacity(0.5)`, changes it. */
function colorsWritten(language: Language, code: string, span: Span): Found<Color>[] {
  const value = code.slice(span.start, span.end);
  const found = (readings: { value: Color }[], at: Span, kind: ValueKind) =>
    readings.map((r) => ({ value: r.value, ...at, kind }));
  // Each value is read as its own text: reading the file's other colors for it would make many values quadratic.
  const reading = (text: string, kind: "literal" | "expression") => ({
    text,
    kind,
    language,
    fileText: text,
  });
  const named = NAMED_COLOR.exec(value)?.[1];
  if (named) return found([{ value: fromHex(NAMED_COLORS[named.toLowerCase()] ?? "") }], span, "expression");
  if (HEX.test(value) && (language === "css" || language === "xml"))
    return found(hexReadings(reading(value, "literal")), span, "literal");
  const unquoted = /^(["'])(.*)\1$/s.exec(value)?.[2];
  if (unquoted !== undefined) {
    const inner = { start: span.start + 1, end: span.end - 1 };
    if (HEX.test(unquoted)) return found(hexReadings(reading(unquoted, "literal")), inner, "literal");
    const css = language === "js" || language === "css" ? cssColor(unquoted) : undefined;
    return css ? found([{ value: css }], inner, /^[a-z]+$/i.test(unquoted) ? "literal" : "expression") : [];
  }
  if (language === "css") {
    const css = cssColor(value);
    return css ? found([{ value: css }], span, "expression") : [];
  }
  // The edit readers read a call only when it's the whole value: `Color(…).opacity(0)` is no color they read.
  if (!COLOR_CALL.test(value)) return [];
  const readings = [
    ...hexReadings(reading(value, "expression")),
    ...callChannelReadings(reading(value, "expression")),
  ];
  // An opacity the reading doesn't hold (`Color(hex: 0xFFFFFF, opacity: 0)`) makes it another color.
  if (/\b(?:opacity|alpha)\s*[:=]/.test(value) && readings.every((r) => r.value.alpha === undefined))
    return [];
  return found(readings, span, "expression");
}

/** A CSS color written whole: a function (`rgb(51 102 230)`, `hsl(…)`) or a name (`white`, `rebeccapurple`). */
function cssColor(text: string): Color | undefined {
  if (!/^(?:(?:rgba?|hsla?)\(.*\)|[a-z]+)$/is.test(text)) return undefined;
  const hex = colorOf(text, true);
  return hex ? fromHex(hex) : undefined;
}

/** An asset catalog color at the line the map gives: the one `components` of the entry or object opening there. */
function assetColor(code: string, line: Span, appearance?: "light" | "dark"): Found<Color>[] {
  const open = code.indexOf("{", line.start);
  if (open === -1 || open >= line.end) return [];
  let componentsOpen = open;
  // The line opens the components, or an entry or color holding just one.
  if (!code.slice(line.start, open).includes('"components"')) {
    const object = valueAfter(code, open);
    if (!object) return [];
    const text = code.slice(object.start, object.end);
    const at = text.indexOf('"components"');
    if (at === -1 || text.indexOf('"components"', at + 1) !== -1) return [];
    componentsOpen = object.start + text.indexOf("{", at);
  }
  const components = valueAfter(code, componentsOpen);
  if (!components) return [];
  // The entry it's of says its appearance: one for dark says so (`"value" : "dark"`), and is no light color.
  const entry = enclosing(code, componentsOpen, (text) => text.includes('"idiom"'));
  if (!entry) return [];
  const dark = /"appearance"\s*:\s*"luminosity"\s*,\s*"value"\s*:\s*"dark"/.test(
    code.slice(entry.start, entry.end),
  );
  if (dark !== (appearance === "dark")) return [];
  const written = code.slice(components.start, components.end);
  return assetReadings({ text: written, kind: "components", language: "json", fileText: written }).map(
    (r) => ({
      value: r.value,
      ...components,
      kind: "components" as const,
    }),
  );
}

/** The object enclosing the one opening at `open` (three levels up at most) whose text `holds` says it's the one. */
function enclosing(code: string, open: number, holds: (text: string) => boolean): Span | undefined {
  let at = open;
  for (let level = 0; level < 3; level++) {
    let depth = 0;
    let i = at - 1;
    for (; i >= 0; i--) {
      const c = code[i];
      if (c === "}" || c === "]") depth++;
      else if (c === "{" || c === "[") {
        if (depth === 0) break;
        depth--;
      }
    }
    if (i < 0) return undefined;
    at = i;
    if (code[i] !== "{") continue;
    const object = valueAfter(code, i);
    if (object && holds(code.slice(object.start, object.end))) return object;
  }
  return undefined;
}

/** Where the bracket opening `text`'s first `(` closes, or -1. */
function closeOf(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") i = stringEnd(text, i) - 1;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

const byte = (hex: string, at: number) => Number.parseInt(hex.slice(at, at + 2), 16);

/** A color from `#rrggbb` or `#rrggbbaa`. */
export function fromHex(value: string): Color {
  const hex = value.slice(1);
  return {
    red: byte(hex, 0),
    green: byte(hex, 2),
    blue: byte(hex, 4),
    ...(hex.length === 8 && { alpha: byte(hex, 6) }),
  };
}

/** Whether `found` is `value`, given as `#rrggbb` or `#rrggbbaa`: the same channels and the same opacity, a color
 * written without one being opaque. */
export function holdsColor(found: Color, value: string): boolean {
  const hex = colorOf(value);
  if (!hex) return false;
  const wanted = fromHex(hex);
  return (
    found.red === wanted.red &&
    found.green === wanted.green &&
    found.blue === wanted.blue &&
    (found.alpha ?? 255) === (wanted.alpha ?? 255)
  );
}

/** A size as code writes one whole: `16`, `16.0`, `16f`, `16.dp`, `16dp`, `16pt`, `16px`, `17.sp`. */
const NUMBER = /^(\d+(?:\.\d+)?)(?:\.(?:dp|sp)|dp|sp|pt|px|[fF])?$/;

/** The number a value is, written whole, or the one its `label` is given inside it (`cornerRadius: 10` in
 * `FrameConfig(width: 20, cornerRadius: 10)`, `paddingVertical: 8` in `{ paddingVertical: 8 }`). */
export function numberValue(
  code: string,
  span: Span,
  label?: string,
  single = true,
): Found<number> | undefined {
  const value = code.slice(span.start, span.end);
  const whole = NUMBER.exec(value) ?? undefined;
  const sized = whole ? undefined : sizeArgument(code, span);
  if (sized) return numberValue(code, sized);
  if (whole) return { value: Number(whole[1]), ...span, kind: value === whole[1] ? "literal" : "expression" };
  const inner = label
    ? labelled(code, span, new RegExp(`(?<![\\w$.])${escaped(label)}\\s*[:=]\\s*`, "g"))
    : [];
  const only = single ? /^\{\s*[\w$]+\s*:\s*/.exec(value) : null;
  if (only) {
    const one = valueAfter(code, span.start + only[0].length);
    if (one && /^\s*,?\s*\}$/.test(code.slice(one.end, span.end))) inner.push(one);
  }
  for (const s of inner) {
    const n = NUMBER.exec(code.slice(s.start, s.end));
    if (n) return numberValue(code, s);
  }
  return undefined;
}

/** Calls whose one argument is a size: `RoundedCornerShape(12.dp)`, `RoundedCornerShape(size = 12.dp)`,
 * `RoundedRectangle(cornerRadius: 8)`, `PaddingValues(vertical = 24.dp)`. */
const SIZE_CALL =
  /^(?:RoundedCornerShape|RoundedRectangle|CornerSize|PaddingValues|BorderRadius\.circular|Radius\.circular)\(/;

/** The one argument of a size-holding call, without its label, when it's written whole there. */
function sizeArgument(code: string, span: Span): Span | undefined {
  const value = code.slice(span.start, span.end);
  const call = SIZE_CALL.exec(value);
  if (!call || closeOf(value) !== value.length - 1) return undefined;
  const argument = valueAfter(code, span.start + call[0].length);
  // One argument: it ends where the call does.
  if (!argument || argument.end !== trimmed(code, span.start, span.end - 1).end) return undefined;
  const label = /^[A-Za-z_]\w*\s*[:=]\s*/.exec(code.slice(argument.start, argument.end));
  return label ? { start: argument.start + label[0].length, end: argument.end } : argument;
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Each value given a label inside `span`, the label matched by `pattern` ending where its value starts. */
function labelled(code: string, span: Span, pattern: RegExp): Span[] {
  return [...code.slice(span.start, span.end).matchAll(pattern)].flatMap((m) => {
    const at = span.start + (m.index ?? 0);
    // Its own, not a nested object's or call's: `{ nested: { fontSize: 12 }, fontSize: 24 }` gives 24.
    if (depthAt(code, span.start, at) > 1) return [];
    const value = valueAfter(code, at + m[0].length);
    return value ? [value] : [];
  });
}

/** How many brackets are open at `to`, from `from`. */
function depthAt(code: string, from: number, to: number): number {
  let depth = 0;
  for (let i = from; i < to; i++) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") i = stringEnd(code, i) - 1;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
  }
  return depth;
}

/** A text style's size, family and weight, each the value its own label is given: `size:`, `fontSize`; `fontFamily`,
 * `.custom("…")`, `UIFont(name: "…")`; `weight:`, `fontWeight`, `.weight(…)`. A style that's
 * a number whole is its size (`static let title = 28.0`). */
export interface TextStyleValue {
  size?: Found<number>;
  family?: Found<string>;
  weight?: Found<number>;
  /** A weight is given in a way Designlane doesn't read for an edit: `.bold()`, or the font's name (`Inter-Bold`). */
  weighted?: boolean;
}

/** SwiftUI's weight modifiers, and a font name's weight: `Inter-Bold`, `Inter_18pt-SemiBold`. */
const WEIGHT_MODIFIER = /\.(?:bold|fontWeight)\(\s*\)|\.bold\(\s*\)/;
const NAMED_WEIGHT =
  /[-_](?:thin|hairline|ultra_?light|extra_?light|light|medium|semi_?bold|demi_?bold|bold|heavy|extra_?bold|black)(?:italic)?$/i;

const SIZE = /(?<![\w$.])(?:size|ofSize|fontSize|textSize)\s*[:=]\s*/g;
const FAMILY =
  /(?<![\w$.])(?:fontFamily|family)\s*[:=]\s*|(?:\.custom|\b(?:UI|NS)?Font)\(\s*(?:name\s*:\s*)?(?=["'])/g;
const WEIGHT = /(?<![\w$.])(?:fontWeight|weight)\s*[:=]\s*|\.(?:weight|fontWeight)\(\s*/g;

export function textStyleValue(file: string, code: string, span: Span): TextStyleValue {
  const language = languageOf(file);
  const out: TextStyleValue = {};
  const whole = numberValue(code, span, undefined, false);
  if (whole) return { size: whole };
  for (const s of labelled(code, span, SIZE)) {
    const size = numberValue(code, s);
    if (size) {
      out.size = size;
      break;
    }
  }
  const [family] = labelled(code, span, FAMILY);
  if (family) {
    const written = code.slice(family.start, family.end);
    const unquoted = /^(["'])(.*)\1$/s.exec(written)?.[2];
    out.family =
      unquoted === undefined
        ? { value: written, ...family, kind: "identifier" }
        : { value: unquoted, start: family.start + 1, end: family.end - 1, kind: "literal" };
  }
  const weights = labelled(code, span, WEIGHT);
  if (language)
    for (const w of weights) {
      const text = code.slice(w.start, w.end);
      const unquoted = /^(["'])(.*)\1$/s.exec(text);
      const at = unquoted ? { start: w.start + 1, end: w.end - 1 } : w;
      const [reading] = weightReadings({
        text: unquoted?.[2] ?? text,
        kind: unquoted ? "literal" : "expression",
        language,
        fileText: code,
      });
      if (reading) {
        out.weight = { value: reading.value, ...at, kind: unquoted ? "literal" : "expression" };
        break;
      }
    }
  // A weight given but not read for an edit (`if (bold) FontWeight.Bold else …`, `.bold()`, `Inter-Bold`) is no
  // regular one.
  if (!out.weight)
    out.weighted =
      weights.length > 0 ||
      WEIGHT_MODIFIER.test(code.slice(span.start, span.end)) ||
      (out.family?.kind === "literal" && NAMED_WEIGHT.test(out.family.value));
  return out;
}

export type { Language };
