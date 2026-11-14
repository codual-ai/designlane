/**
 * What a Swift font expression sets, read from its structure: Apple's text styles (`.headline`,
 * `UIFont.preferredFont(forTextStyle: .body)`), system fonts at a size, custom fonts, and the app's own font helpers,
 * with the weight and size changes written after them (`.bold()`, `.weight(.medium)`, `.withSize(32)`). Anything
 * worked out at run time is `computed`, never guessed.
 */

import { COMPUTED } from "../scan/type-scale.js";
import { type Argument, type ChainLink, chain, type Expression } from "./swift-expressions.js";
import { changesIn, withChanges } from "./swift-font-changes.js";
import { fontName, isTextStyle, type TextStyleName, textStyle, WEIGHTS } from "./swift-font-names.js";
import { type FontValue, fontSpan, numberIn, sized, weightOf } from "./swift-font-values.js";

/** The types fonts are made from: SwiftUI's, UIKit's and AppKit's. */
export const FONT_TYPES = new Set(["Font", "UIFont", "NSFont"]);

const SYSTEM_SIZED = new Set([
  "systemFont",
  "monospacedSystemFont",
  "monospacedDigitSystemFont",
  "italicSystemFont",
]);
/** What can follow a font and leave it a font: changes to its weight, size, width or figures. Anything else reads
 * something from the font (`.lineHeight`), which sets no font. */
const KEEPS_FONT = new Set([
  "bold",
  "italic",
  "weight",
  "fontWeight",
  "withSize",
  "width",
  "leading",
  "monospaced",
  "monospacedDigit",
  "smallCaps",
  "lowercaseSmallCaps",
  "uppercaseSmallCaps",
  // A font's descriptor describes that same font, and is used to make it: `UIFont(descriptor: f.fontDescriptor, …)`.
  "fontDescriptor",
]);
/** The labels a font's size is passed with. */
export const SIZE_LABELS = new Set(["size", "ofSize", "fixedSize"]);

/** The fonts `expression` sets: both sides of a ternary, the font a `??` falls back from, the font inside `Font(…)`
 * or `UIFontMetrics(…).scaledFont(for:)`. Nothing for an expression that isn't a font. */
export function fontValues(expression: Expression): FontValue[] {
  const e = expression.kind === "postfix" ? expression.operand : expression;
  if (e.kind === "ternary") return [...fontValues(e.then), ...fontValues(e.otherwise)];
  // `UIFont(name: "Inter", size: 17) ?? .systemFont(ofSize: 17)`: the system font only stands in for the custom one.
  if (e.kind === "binary" && e.operator === "??") return fontValues(e.left);
  // `Font(metrics.scaledFont(for: f) as CTFont)`: a cast leaves the font as it was.
  if (e.kind === "binary" && e.operator.startsWith("as")) return fontValues(e.left);
  const { root, links } = chain(e);
  const base = baseFont(root, links, e.start);
  if (!base) return [];
  // `UIFont.systemFont(ofSize: 12).lineHeight` reads a measurement from a font, which sets no font.
  if (links.slice(base.links).some((l) => !KEEPS_FONT.has(l.name) && !WEIGHTS.has(l.name))) return [];
  return [withChanges(base.value, changesIn(links.slice(base.links)))];
}

/** The font a chain starts with, and how many of its links that took. */
function baseFont(
  root: Expression | undefined,
  links: ChainLink[],
  at: number,
): { value: FontValue; links: number } | undefined {
  if (root?.kind === "call" && root.callee.kind === "name") {
    const name = root.callee.name;
    const only =
      root.args.length === 1 && root.args[0]?.label === undefined ? root.args[0]?.value : undefined;
    // `Font(uiFont)` and `UIFontMetrics(forTextStyle: …).scaledFont(for: font)` wrap another font.
    if (name === "Font" && only) return wrapped(only, 0);
    if (name === "UIFontMetrics" && links[0]?.name === "scaledFont") {
      const font = links[0].args?.find((a) => a.label === "for")?.value;
      return font ? wrapped(font, 1) : undefined;
    }
    if (FONT_TYPES.has(name) && root.args.some((a) => a.label === "name")) {
      return { value: customFont(root.args, "name"), links: 0 };
    }
    return undefined;
  }
  const typed = root?.kind === "name" && (FONT_TYPES.has(root.name) || root.name === "SwiftUI");
  const first = root === undefined || typed ? (links[0]?.name === "Font" ? 1 : 0) : -1;
  if (first === -1) return helperOn(root, links, at);
  const link = links[first];
  if (!link) return undefined;
  const known = knownFont(link.name, link.args);
  if (known) return { value: known, links: first + 1 };
  const owner = root?.kind === "name" && root.name !== "SwiftUI" ? { owner: root.name } : {};
  return {
    value: {
      helper: { ...owner, name: link.name, args: link.args ?? [], called: link.args !== undefined, at },
    },
    links: first + 1,
  };
}

/** The font inside a wrapper, `Font(x)`, carrying on past the wrapper's own links. */
function wrapped(inner: Expression, links: number): { value: FontValue; links: number } | undefined {
  const [value] = fontValues(inner);
  return value ? { value, links: links + 1 } : undefined;
}

/** `Theme.Fonts.title`, `Self.heading`: a helper named on the app's own type, the last link being its name. */
function helperOn(
  root: Expression | undefined,
  links: ChainLink[],
  at: number,
): { value: FontValue; links: number } | undefined {
  if (root?.kind !== "name" || links.length === 0 || !/^[A-Z]/.test(root.name)) return undefined;
  // The helper is the first link that isn't a type name: `Theme.Fonts.title` is `title` on `Fonts`.
  let index = 0;
  while (index < links.length - 1 && /^[A-Z]/.test(links[index]?.name ?? "")) index++;
  const link = links[index];
  if (!link) return undefined;
  const owner = index === 0 ? root.name : (links[index - 1]?.name ?? root.name);
  return {
    value: { helper: { owner, name: link.name, args: link.args ?? [], called: link.args !== undefined, at } },
    links: index + 1,
  };
}

/** A font Apple's frameworks define, named by `name` and called with `args`, if it is one. */
function knownFont(name: string, args: Argument[] | undefined): FontValue | undefined {
  if (isTextStyle(name) && !args) return styled(name);
  if (name === "custom" && args) return customFont(args);
  if (name === "system" && args) {
    const style = args[0]?.label === undefined ? args[0]?.value : undefined;
    const weight = weightOf(args.find((a) => a.label === "weight")?.value);
    if (style?.kind === "member" && !style.base && isTextStyle(style.name)) return styled(style.name, weight);
    return systemFont(args, weight ?? "regular");
  }
  if (SYSTEM_SIZED.has(name) && args)
    return systemFont(args, weightOf(args.find((a) => a.label === "weight")?.value) ?? "regular");
  if (name === "boldSystemFont" && args) return systemFont(args, "bold");
  if (name === "preferredFont" && args) {
    const style = args.find((a) => a.label === "forTextStyle")?.value;
    if (style?.kind === "member" && isTextStyle(style.name)) return styled(style.name);
    return { font: { kind: "text-style", family: "System", weight: COMPUTED } };
  }
  return undefined;
}

const styled = (style: TextStyleName, weight?: string): FontValue => ({
  font: textStyle(style, weight),
  style,
});

function systemFont(args: Argument[], weight: string): FontValue {
  const size = args.find((a) => SIZE_LABELS.has(a.label ?? ""))?.value;
  const weightAt = args.find((a) => a.label === "weight")?.value;
  const sizeAt = numberIn(size);
  const spans = {
    ...(sizeAt && { fontSize: fontSpan(sizeAt.token, "literal") }),
    ...(weightAt && { fontWeight: fontSpan(weightAt, "expression") }),
  };
  return { font: { kind: "system", family: "System", ...sized(size), weight }, ...sizeSource(size), spans };
}

/** Where a string literal's text is, without its quotes: `"Inter"`, `#"Inter"#`. */
function textOf({ token, value }: Expression & { kind: "string" }) {
  const quotes = (token.end - token.start - value.length) / 2;
  return { start: token.start + quotes, end: token.end - quotes };
}

/** `.custom("Inter-Bold", size: 17)` or `UIFont(name: "Inter", size: 17)`; a family that's a constant is unknown. */
function customFont(args: Argument[], familyLabel?: string): FontValue {
  const family = (familyLabel ? args.find((a) => a.label === familyLabel) : args[0])?.value;
  const named = family?.kind === "string" ? fontName(family.value) : { family: "", weight: COMPUTED };
  const size = args.find((a) => SIZE_LABELS.has(a.label ?? ""))?.value;
  // A font's name is its family and its weight: `Inter-Bold`, or `Inter` for the regular one.
  const nameAt =
    family?.kind === "string" && !family.interpolated ? fontSpan(textOf(family), "family-name") : undefined;
  const sizeAt = numberIn(size);
  const spans = {
    ...(nameAt && { fontFamily: nameAt, fontWeight: nameAt }),
    ...(sizeAt && { fontSize: fontSpan(sizeAt.token, "literal") }),
  };
  return {
    font: { kind: "custom", family: named.family, ...sized(size), weight: named.weight },
    ...sizeSource(size),
    spans,
  };
}

function sizeSource(value: Expression | undefined): { sizeFrom?: string } {
  return value?.kind === "name" ? { sizeFrom: value.name } : {};
}
