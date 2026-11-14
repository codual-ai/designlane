/**
 * An app's own fonts: `static var scaledBody: Font { … }`, `static let brand = Font.custom(…)`,
 * `class var dynamicTypeBody: UIFont { … }`, on `Font`, `UIFont`, `NSFont` or the app's own types. Each is read
 * from its body; a helper whose font is worked out at run time is `computed`, never guessed from its name.
 */

import { firstAtOrAfter } from "../scan/sorted.js";
import { COMPUTED, type TypeUse } from "../scan/type-scale.js";
import type { TypeLocations } from "../scan/types.js";
import type { Locator } from "./source-text.js";
import { expressionAt } from "./swift-expressions.js";
import { FONT_TYPES, fontValues } from "./swift-font-reading.js";
import type { FontSite } from "./swift-font-sites.js";
import type { FontSpans, FontValue } from "./swift-font-values.js";
import { memberOf, ownerAt, qualifiedOwnerAt } from "./swift-owners.js";
import { type SwiftTokens, tokenIndexAt } from "./swift-tokens.js";
import { valueAt, withLocations } from "./value-locations.js";

export type Range = [start: number, end: number];

/** Brackets that open a group inside a parameter list: a default value's call or array, a closure. */
const NESTED_OPENERS = new Set(["(", "[", "{"]);

export interface FontHelper {
  name: string;
  /** The type it's declared on (`Font`, `UIFont`, `AppFont`), or empty at the top level. */
  owner: string;
  /** A function, `static func brand(size:) -> Font`, rather than a property: a type can declare both by one name. */
  isFunction: boolean;
  font: TypeUse;
  /** Its body, whose fonts count through the helper's uses rather than on their own. */
  body: Range;
  /** Whether its body passes a parameter straight on as the size, so a call's size is the font's. */
  sizeParameter: boolean;
  /** The fonts written in its body, and where. */
  written: { font: TypeUse; at: number }[];
}

const DECLARERS = new Set(["static", "class"]);
const MEMBERS = new Set(["let", "var", "func"]);
/** How far into a helper's body its fonts are looked for; real helpers are a few lines. */
const MAX_BODY_TOKENS = 512;
/** How many of a body's fonts are compared to find what they share. */
const MAX_BODY_FONTS = 8;

/** The font helpers declared in `file`, given the fonts found in it; `span` says where offsets of it are. */
export function fontHelpers(file: SwiftTokens, sites: FontSite[], span: Locator): FontHelper[] {
  const helpers: FontHelper[] = [];
  const ordered = [...sites].sort((a, b) => a.at - b.at);
  const starts = ordered.map((s) => s.at);
  file.tokens.forEach((token, i) => {
    if (!DECLARERS.has(token.text) || !MEMBERS.has(file.tokens[i + 1]?.text ?? "")) return;
    const declaration = declarationAt(file, i + 2);
    if (!declaration) return;
    const [start, end] = declaration.body;
    const sitesInBody: FontSite[] = [];
    for (
      let k = firstAtOrAfter(starts, start);
      sitesInBody.length < MAX_BODY_FONTS && (ordered[k]?.at ?? end) < end;
      k++
    ) {
      sitesInBody.push(ordered[k] as FontSite);
    }
    // A body's expression can also be a font site (`{ UIFont.preferredFont(…) }`): each place is read once.
    const read = bodyValues(file, declaration.body);
    const readAt = new Set(read.map((r) => r.at));
    const all = [
      ...read,
      ...sitesInBody.filter((s) => !readAt.has(s.at)).map((s) => ({ value: s.value, at: s.at })),
    ];
    const fonts = all
      .slice(0, MAX_BODY_FONTS)
      .flatMap(({ value, at }) => ("font" in value ? [{ ...value, at }] : []));
    const font = shared(fonts.map((v) => v.font));
    // Only a helper returning one font has one place each of its values is written.
    const [only] = all.length === 1 ? fonts : [];
    const locations = only?.spans ? locationsOf(only.spans, span) : {};
    const sizeParameter = fonts.some(
      (v) => v.sizeFrom !== undefined && declaration.parameters.includes(v.sizeFrom),
    );
    const isFunction = file.tokens[i + 1]?.text === "func";
    // `Font.brand(size:)`, how Swift names a function by its argument labels.
    const labels = declaration.labels.map((label) => `${label}:`).join("");
    const member = isFunction ? `${declaration.name}(${labels})` : declaration.name;
    const reference = memberOf(qualifiedOwnerAt(file, i), member);
    helpers.push({
      name: declaration.name,
      owner: ownerAt(file, i),
      isFunction,
      font: { ...font, kind: "app", style: declaration.name, reference, ...withLocations(locations) },
      body: declaration.body,
      sizeParameter,
      written: fonts.map(({ font, at }) => ({ font, at })),
    });
  });
  return helpers;
}

/** A font's spans as places in its file. */
function locationsOf(spans: FontSpans, span: Locator): TypeLocations {
  return Object.fromEntries(
    Object.entries(spans).map(([key, { start, end, kind }]) => [key, valueAt(span(start, end), kind)]),
  );
}

/** The helper declared from the name at `at`: `name(parameters) -> Font {`, `name: UIFont {`, `name = Font.custom(…)`. */
function declarationAt(
  file: SwiftTokens,
  at: number,
): { name: string; parameters: string[]; labels: string[]; body: Range } | undefined {
  const { tokens, match } = file;
  const name = tokens[at];
  if (name?.kind !== "name") return undefined;
  let i = at + 1;
  const parameters: string[] = [];
  const labels: string[] = [];
  if (tokens[i]?.text === "(") {
    const close = match[i] ?? -1;
    if (close === -1) return undefined;
    // `(_ size: CGFloat, weight w: Font.Weight)`: the first word of each parameter is how a call labels it, and the
    // name before its `:` is the one the body uses. Commas inside a group (`[String]`, `Dictionary<String, Int>`, a
    // default value's call) aren't the list's.
    for (let k = i + 1, first = true, angles = 0; k < close; k++) {
      const text = tokens[k]?.text ?? "";
      if (first) labels.push(text);
      first = text === "," && angles === 0;
      if (tokens[k + 1]?.text === ":" && tokens[k]?.kind === "name") parameters.push(text);
      if (text === "<") angles++;
      else if (text === ">" && angles > 0) angles--;
      // A bracket group is skipped whole, and only ever forward: an unmatched one has no end.
      const end = NESTED_OPENERS.has(text) ? (match[k] ?? -1) : -1;
      if (end > k) k = end;
    }
    i = close + 1;
  }
  const typed = tokens[i]?.text === ":" || tokens[i]?.text === "->";
  if (typed) {
    i++;
    if (tokens[i]?.text === "SwiftUI" && tokens[i + 1]?.text === ".") i += 2;
    // `Font` but not `Font.Weight` or `Font.TextStyle`.
    if (!FONT_TYPES.has(tokens[i]?.text ?? "") || tokens[i + 1]?.text === ".") return undefined;
    i++;
  } else if (tokens[i]?.text !== "=" || !FONT_TYPES.has(tokens[i + 1]?.text ?? "")) return undefined;
  const body = bodyAt(file, i);
  return body && { name: name.text, parameters, labels, body };
}

/** A helper's body: its `{ … }`, or the expression after `=`. */
function bodyAt(file: SwiftTokens, at: number): Range | undefined {
  const token = file.tokens[at];
  if (token?.text === "{") {
    const close = file.tokens[file.match[at] ?? -1];
    return close ? [token.start, close.end] : undefined;
  }
  if (token?.text !== "=") return undefined;
  const value = expressionAt(file, file.tokens[at + 1]?.start ?? file.text.length);
  return value && [token.start, value.end];
}

/** The fonts a body returns: its expression after `=`, its single expression `{ .title }`, or each `return`. */
function bodyValues(file: SwiftTokens, [start, end]: Range): { value: FontValue; at: number }[] {
  const values: { value: FontValue; at: number }[] = [];
  const readAt = (index: number) => {
    const expression = expressionAt(file, file.tokens[index]?.start ?? end);
    if (expression && expression.end <= end) {
      for (const value of fontValues(expression)) values.push({ value, at: expression.start });
    }
  };
  const first = tokenIndexAt(file, start);
  const opener = file.tokens[first]?.text;
  if (opener === "=") readAt(first + 1);
  else if (opener === "{") {
    readAt(file.tokens[first + 1]?.text === "return" ? first + 2 : first + 1);
    const stop = first + MAX_BODY_TOKENS;
    for (let i = first + 1; i < stop && (file.tokens[i]?.start ?? end) < end; i++) {
      if (file.tokens[i]?.text === "return") readAt(i + 1);
    }
  }
  return values;
}

/** What a helper's fonts share; a family, size or weight that differs between them (a `switch`) has no one value. */
function shared(fonts: TypeUse[]): TypeUse {
  const [one] = fonts;
  if (!one) return { kind: "app", family: "", weight: COMPUTED };
  const same = <K extends "family" | "size" | "weight">(key: K) => fonts.every((f) => f[key] === one[key]);
  return {
    kind: "app",
    family: same("family") ? one.family : "",
    ...(same("size") && one.size !== undefined ? { size: one.size } : {}),
    weight: same("weight") ? one.weight : COMPUTED,
  };
}
