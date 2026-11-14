/** A text style's size, weight and family as code writes them: `17`, `22.sp`, `15sp`; `.semibold`,
 * `FontWeight.SemiBold`, `FontWeight.W600`, `"600"`, `bold`; and a family's name. */

import { COMPOSE_WEIGHTS, weightByHundred, weightOf } from "../frameworks/material-type.js";
import { WEIGHT_NUMBERS } from "../output/token-names.js";
import type { SpanText, Written } from "./notation.js";

const SIZE = /^(\d+(?:\.(\d+))?)(\.sp|\.dp|sp|dp|pt|px|[fF])?$/;
const WEIGHT_NUMBER = /^[1-9]00$/;
const SWIFT_WEIGHT = /^(\.|(?:SwiftUI\.)?Font\.Weight\.|(?:UI|NS)Font\.Weight\.)([a-zA-Z]+)$/;
const COMPOSE_NAMED = /^FontWeight\.([A-Z]\w*)$/;
const COMPOSE_HUNDRED = /^FontWeight\.W([1-9]00)$/;
const COMPOSE_NUMBER = /^(FontWeight\(\s*(?:weight\s*=\s*)?)([1-9]00)(\s*\))$/;
/** React Native's weight words. */
const WEIGHT_WORDS: Record<string, number> = { normal: 400, bold: 700 };
/** What a family's name can't hold without escaping in some language: quotes, a backslash, a template's `$`, markup. */
const UNSAFE_IN_NAME = /["'`\\$<>&\n\r]/;

/** A size as a number with the unit the code writes after it (`22.sp`, `15sp`, `17`), keeping its decimals. */
export function sizeReadings({ text, kind }: SpanText): Written<number>[] {
  const match = kind === "literal" || kind === "expression" ? SIZE.exec(text) : null;
  if (!match?.[1]) return [];
  const decimals = match[2]?.length ?? 0;
  const unit = match[3] ?? "";
  const write = (to: number) => {
    const plain = String(to);
    const own = plain.split(".")[1]?.length ?? 0;
    return `${own >= decimals ? plain : to.toFixed(decimals)}${unit}`;
  };
  return [{ value: Number(match[1]), write }];
}

/** A weight in the form the code gives it: a number, a React Native word, Swift's `.semibold`, or Compose's
 * `FontWeight.SemiBold`, `FontWeight.W600` or `FontWeight(600)`. */
export function weightReadings({ text, kind, language }: SpanText): Written<number>[] {
  if (kind !== "literal" && kind !== "expression") return [];
  if (WEIGHT_NUMBER.test(text)) return [{ value: Number(text), write: String }];
  if (language === "js" && Object.hasOwn(WEIGHT_WORDS, text)) {
    const word = (to: number) => Object.keys(WEIGHT_WORDS).find((w) => WEIGHT_WORDS[w] === to) ?? String(to);
    return [{ value: WEIGHT_WORDS[text] ?? 0, write: word }];
  }
  if (language === "swift") return swiftWeight(text);
  return language === "kotlin" ? composeWeight(text) : [];
}

function swiftWeight(text: string): Written<number>[] {
  const [, qualifier, name = ""] = SWIFT_WEIGHT.exec(text) ?? [];
  const value = Object.hasOwn(WEIGHT_NUMBERS, name) ? WEIGHT_NUMBERS[name] : undefined;
  return value === undefined ? [] : [{ value, write: (to) => `${qualifier}${weightByHundred(to)}` }];
}

function composeWeight(text: string): Written<number>[] {
  const value = WEIGHT_NUMBERS[weightOf(text)];
  if (value === undefined) return [];
  if (COMPOSE_HUNDRED.test(text)) return [{ value, write: (to) => `FontWeight.W${to}` }];
  const number = COMPOSE_NUMBER.exec(text);
  if (number) return [{ value, write: (to) => `${number[1]}${to}${number[3]}` }];
  if (!COMPOSE_NAMED.test(text)) return [];
  const named = (to: number) => {
    const name = Object.keys(COMPOSE_WEIGHTS).find((key) => COMPOSE_WEIGHTS[key] === weightByHundred(to));
    return name && `FontWeight.${name}`;
  };
  return [{ value, write: named }];
}

/** A family written as its own name, which any other name can take the place of. */
export function familyReadings({ text, kind }: SpanText): Written<string>[] {
  if (kind !== "literal") return [];
  return [{ value: text, write: (to) => (UNSAFE_IN_NAME.test(to) ? undefined : to) }];
}
