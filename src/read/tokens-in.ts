/** Every value one file uses: the named tokens it names and the values it writes in place, each with its span. */

import { jsCodeOnly } from "../frameworks/js-code.js";
import { jsSource } from "../frameworks/js-sources.js";
import { kotlinSource } from "../frameworks/kotlin-sources.js";
import { type Locator, locator } from "../frameworks/source-text.js";
import { swiftSource } from "../frameworks/swiftui-sources.js";
import type { FrameworkId } from "../scan/types.js";
import { type NamedUse, namedUses } from "./named-uses.js";
import type { FileTokens, TokenUse } from "./schema.js";
import type { TokenIndex } from "./token-index.js";
import { jsValues, kotlinValues, swiftValues, type Written, type WrittenValues } from "./written-values.js";

/** What a framework's reading of one file needs from the app. */
export interface Reading {
  framework: FrameworkId;
  index: TokenIndex;
  /** For Swift: whether the app's hex helper reads eight digits opacity first. */
  opacityFirst: boolean;
}

/** What follows a family's name in a font's own name: `Inter-Bold`, `Inter_600SemiBold`, `Inter Bold`. */
const AFTER_FAMILY = /^[-_ ]/;

/** The family `literal` names, of `fonts`: `Inter` for `"Inter-Bold"`. */
const familyIn = (literal: string, fonts: string[]) =>
  fonts.find((f) => literal === f || (literal.startsWith(f) && AFTER_FAMILY.test(literal.slice(f.length))));

function read(reading: Reading, rel: string, text: string): { code: string; values: WrittenValues } {
  if (reading.framework === "swiftui") {
    const source = swiftSource(rel, text);
    return {
      code: source.code,
      values: swiftValues(source, reading.opacityFirst, reading.index.fonts.length > 0),
    };
  }
  if (reading.framework === "compose") {
    const source = kotlinSource(rel, text);
    return { code: source.code, values: kotlinValues(source) };
  }
  const source = jsSource(rel, text);
  return { code: jsCodeOnly(source.file), values: jsValues(source) };
}

/** Of `written`, those overlapping none of `spans`: both sorted by start and swept once, so a file with thousands of
 * each costs their sum, not their product. */
function outside<V>(written: Written<V>[], spans: [number, number][]): Written<V>[] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  // The furthest end of the spans starting at or before each one, so a long span hides the short ones inside it.
  const reach: number[] = [];
  for (const [i, [, end]] of sorted.entries()) reach.push(Math.max(end, reach[i - 1] ?? 0));
  let at = 0;
  return [...written]
    .sort((a, b) => a.start - b.start)
    .filter((w) => {
      while (at < sorted.length && (sorted[at]?.[0] ?? 0) < w.end) at++;
      return at === 0 || (reach[at - 1] ?? 0) <= w.start;
    });
}

const byStart = <T extends { span: { start: number } }>(uses: T[]) =>
  uses.sort((a, b) => a.span.start - b.span.start);

/** The values `text` (the file `rel`, relative to the app's folder) uses, as `reading`'s framework reads them. */
export function tokensIn(reading: Reading, rel: string, text: string): FileTokens {
  const at: Locator = locator(rel, text);
  const { code, values } = read(reading, rel, text);
  const named = namedUses(reading.index, rel, text, code, at);
  // A value inside a token's own definition isn't written in place: it's the token.
  const taken = reading.index.definitions.get(rel) ?? [];
  const inPlace = <V>(written: Written<V>[]): TokenUse<V>[] =>
    outside(written, taken).map((w) => ({ value: w.value, span: at(w.start, w.end) }));
  const asUse = <V>(use: NamedUse, value: V): TokenUse<V> => ({
    token: use.named.token,
    value,
    span: at(use.start, use.end),
  });
  const colors: FileTokens["colors"] = [];
  const typeStyles: FileTokens["typeStyles"] = [];
  const fonts: FileTokens["fonts"] = [];
  for (const use of named) {
    if (use.named.kind === "unresolved") {
      const unresolved = {
        token: use.named.token,
        value: null,
        unresolved: true as const,
        span: at(use.start, use.end),
      };
      if (use.named.of === "color") colors.push(unresolved);
      else typeStyles.push(unresolved);
    } else if (use.named.kind === "color") colors.push(asUse(use, use.named.value));
    else {
      typeStyles.push(asUse(use, use.named.value));
      const family = use.named.value.family;
      if (family && reading.index.fonts.includes(family)) fonts.push(asUse(use, family));
    }
  }
  for (const literal of outside(values.strings, taken)) {
    const family = familyIn(literal.value, reading.index.fonts);
    if (family) fonts.push({ value: family, span: at(literal.start, literal.end) });
  }
  return {
    framework: reading.framework,
    colors: byStart([...colors, ...inPlace(values.colors)]),
    typeStyles: byStart([...typeStyles, ...inPlace(values.typeStyles)]),
    fonts: byStart(fonts),
    spacing: byStart(inPlace(values.spacing)),
    radii: byStart(inPlace(values.radii)),
  };
}
