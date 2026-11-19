/**
 * The values one file writes in place, as each framework writes them: colours, text sizes, spacing, corner radii and
 * font families, each with where it's written. A value inside a token's own definition isn't one of them.
 */

import ts from "typescript";
import { colorValue, expressionEnd } from "../frameworks/compose-color-values.js";
import { dpInCallsOf, RADIUS_CALL, SPACING_CALL } from "../frameworks/compose-tokens.js";
import { colorOf } from "../frameworks/css-color.js";
import { eachNode, type JsSource, propertyName } from "../frameworks/js-sources.js";
import type { KotlinSource } from "../frameworks/kotlin-sources.js";
import { bracketTree } from "../frameworks/source-text.js";
import { commentOrStringEnd } from "../frameworks/swift-source.js";
import { literals } from "../frameworks/swiftui-colors.js";
import type { SwiftSource } from "../frameworks/swiftui-sources.js";
import { RADIUS, SPACING } from "../frameworks/swiftui-tokens.js";
import { WEIGHT_NUMBERS } from "../output/token-names.js";
import type { TypeValue } from "./schema.js";

/** A value and where it's written, as offsets into the file's text. */
export interface Written<V> {
  value: V;
  start: number;
  end: number;
}

export interface WrittenValues {
  colors: Written<string>[];
  typeStyles: Written<TypeValue>[];
  /** String literals, which may name a font family (`"Inter-Bold"`). */
  strings: Written<string>[];
  spacing: Written<number>[];
  radii: Written<number>[];
}

const empty = (): WrittenValues => ({ colors: [], typeStyles: [], strings: [], spacing: [], radii: [] });

/** The number a pattern captures first, with where that number is written. */
function* numbersOf(text: string, code: string, pattern: RegExp): Generator<Written<number>> {
  for (const m of text.matchAll(pattern)) {
    const at = m.index ?? 0;
    const number = m[1] ?? "";
    if (code[at] === " " || !number) continue;
    const start = at + m[0].lastIndexOf(number);
    yield { value: Number(number), start, end: start + number.length };
  }
}

/** `.system(size: 17, weight: .bold)` or `.custom("Inter", size: 17)`: a font written in place, to its `)`. */
const SWIFT_FONT =
  /\.(?:system|custom)\(\s*(?:"([^"\n]*)"\s*,\s*)?size:\s*(\d+(?:\.\d+)?)(?:\s*,\s*weight:\s*\.(\w+))?[^()\n]*\)/g;

/** Every string literal's text in a Swift file, with where it's written inside its quotes. */
function* swiftStrings(text: string): Generator<Written<string>> {
  for (let i = 0; i < text.length; ) {
    const end = commentOrStringEnd(text, i);
    if (end === undefined) {
      i++;
      continue;
    }
    if (text[i] === '"') yield { value: text.slice(i + 1, end - 1), start: i + 1, end: end - 1 };
    i = end;
  }
}

/** A Swift file's values; `strings` only when asked for, as only an app with custom fonts needs them. */
export function swiftValues(source: SwiftSource, opacityFirst: boolean, strings: boolean): WrittenValues {
  const out = empty();
  // The brackets of the blanked code find each call's end without tokenizing the file, which only this needs here.
  const tree = bracketTree(source.code);
  const callEnd = (open: number) => {
    const close = tree.closeOf.get(open);
    return close === undefined ? undefined : close + 1;
  };
  for (const color of literals(source, opacityFirst, callEnd))
    if (color.end !== undefined) out.colors.push({ value: color.hex, start: color.start, end: color.end });
  for (const m of source.text.matchAll(SWIFT_FONT)) {
    const start = m.index ?? 0;
    if (source.code[start] === " ") continue;
    const weight = m[3] === undefined ? undefined : WEIGHT_NUMBERS[m[3]];
    out.typeStyles.push({
      value: { ...(m[1] && { family: m[1] }), size: Number(m[2]), ...(weight !== undefined && { weight }) },
      start,
      end: start + m[0].length,
    });
  }
  out.spacing.push(...numbersOf(source.text, source.code, SPACING));
  out.radii.push(...numbersOf(source.text, source.code, RADIUS));
  if (strings) out.strings.push(...swiftStrings(source.text));
  return out;
}

const KOTLIN_COLOR = /\bColor(?:\s*\(|\.[A-Z]\w*)/g;
const KOTLIN_FONT_SIZE = /\bfontSize\s*=\s*(\d+(?:\.\d+)?)\.sp\b/g;
const KOTLIN_STRING = /"([^"\\\n]{0,200})"/g;

export function kotlinValues(source: KotlinSource): WrittenValues {
  const out = empty();
  for (const m of source.code.matchAll(KOTLIN_COLOR)) {
    const start = m.index ?? 0;
    const end = expressionEnd(source, start);
    const color = colorValue(source, start, end, () => undefined);
    if (color) out.colors.push({ value: color.hex, start, end });
  }
  for (const size of numbersOf(source.text, source.code, KOTLIN_FONT_SIZE))
    out.typeStyles.push({ value: { size: size.value }, start: size.start, end: size.end + ".sp".length });
  for (const dp of dpInCallsOf(source, SPACING_CALL)) out.spacing.push(dp);
  for (const dp of dpInCallsOf(source, RADIUS_CALL)) out.radii.push(dp);
  for (const m of source.written.matchAll(KOTLIN_STRING)) {
    const start = (m.index ?? 0) + 1;
    out.strings.push({ value: m[1] ?? "", start, end: start + (m[1] ?? "").length });
  }
  return out;
}

/** Style properties holding spacing, a corner radius, or a text size. */
const JS_SPACING =
  /^(?:padding|margin)(?:Top|Bottom|Left|Right|Start|End|Horizontal|Vertical)?$|^(?:gap|rowGap|columnGap)$/;
const JS_RADIUS = /^border(?:Top|Bottom)?(?:Left|Right|Start|End)?Radius$|^borderRadius$/;

export function jsValues(source: JsSource): WrittenValues {
  const out = empty();
  const file = source.file;
  eachNode(file, (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const start = node.getStart(file) + 1;
      const written = { start, end: node.getEnd() - 1 };
      const color = colorOf(node.text);
      if (color) out.colors.push({ value: color, ...written });
      else out.strings.push({ value: node.text, ...written });
    }
    if (ts.isPropertyAssignment(node) && ts.isNumericLiteral(node.initializer)) {
      const name = propertyName(node.name) ?? "";
      const value = Number(node.initializer.text);
      const written = { value, start: node.initializer.getStart(file), end: node.initializer.getEnd() };
      if (JS_SPACING.test(name)) out.spacing.push(written);
      else if (JS_RADIUS.test(name)) out.radii.push(written);
      else if (name === "fontSize") out.typeStyles.push({ ...written, value: { size: value } });
    }
    return true;
  });
  return out;
}
