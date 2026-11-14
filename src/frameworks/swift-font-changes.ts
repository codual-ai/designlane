/** The weight and size changes written after a Swift font (`.bold()`, `.weight(.medium)`, `.withSize(32)`), where
 * each is written, and the font they make. */

import { COMPUTED } from "../scan/type-scale.js";
import type { Argument, ChainLink } from "./swift-expressions.js";
import { textStyle, WEIGHTS } from "./swift-font-names.js";
import { type FontSpans, type FontValue, fontSpan, numberIn, sized, weightOf } from "./swift-font-values.js";

/** A font's weight and size changes, and where each is written. */
export interface Changes {
  weight?: string;
  size?: number;
  /** The last size set is worked out as the app runs (`.withSize(scaled())`), replacing the font's own. */
  computedSize?: true;
  spans?: FontSpans;
}

/** The weight and size changes in a chain of links after a font. A later `.font(…)` replaces the font, so the
 * changes stop there. */
export function changesIn(links: ChainLink[]): Changes {
  let weight: string | undefined;
  let size: number | undefined;
  let computedSize = false;
  const spans: FontSpans = {};
  for (const link of links) {
    const { name, args } = link;
    if (name === "font") break;
    const argument = args?.[0]?.value;
    if (name === "bold") {
      const bold = boldness(args);
      weight = bold ?? weight;
      if (bold) spans.fontWeight = fontSpan(link, "expression");
    } else if ((name === "weight" || name === "fontWeight") && args) {
      weight = weightOf(argument) ?? COMPUTED;
      if (argument && weight !== COMPUTED) spans.fontWeight = fontSpan(argument, "expression");
    }
    // UIKit apps add weight methods of their own: `UIFont.dynamicTypeFootnote.semibold()`.
    else if (WEIGHTS.has(name) && args?.length === 0) {
      weight = name;
      spans.fontWeight = fontSpan(link, "expression");
    } else if (name === "withSize" && args) {
      size = sized(argument).size;
      computedSize = size === undefined;
      const sizeAt = numberIn(argument);
      if (sizeAt) spans.fontSize = fontSpan(sizeAt.token, "literal");
    }
  }
  return {
    ...(weight ? { weight } : {}),
    ...(size === undefined ? {} : { size }),
    ...(computedSize && { computedSize: true as const }),
    ...(Object.keys(spans).length > 0 ? { spans } : {}),
  };
}

/** `value` with the given weight and size changes applied. */
export function withChanges(value: FontValue, { spans, computedSize, ...changes }: Changes): FontValue {
  if ("helper" in value) return { helper: { ...value.helper, ...changes } };
  const restyled = value.style && changes.weight ? textStyle(value.style, changes.weight) : value.font;
  const font = { ...restyled, ...changes };
  const written = { ...value.spans, ...spans };
  if (computedSize) {
    delete font.size;
    delete written.fontSize;
  }
  return { ...value, font, spans: written };
}

/** `.bold()` is bold, `.bold(true)` too; `.bold(false)` changes nothing; `.bold(isOn)` can't be read. */
function boldness(args: Argument[] | undefined): string | undefined {
  const value = args?.[0]?.value;
  if (!value) return "bold";
  if (value.kind === "name" && value.name === "true") return "bold";
  return value.kind === "name" && value.name === "false" ? undefined : COMPUTED;
}
