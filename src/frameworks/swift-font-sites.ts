/**
 * Every place Swift code sets a font, read with the expression reader: the `.font(…)` modifier (with a weight set
 * after it, `.fontWeight(.bold)`), a `font:` argument or attribute, a UIKit `label.font = …`, and a font written on
 * its own (`UIFont.systemFont(ofSize: 17)`, `Font.custom("Inter", size: 15)`) anywhere else.
 */

import { argumentsAt, chain, type Expression, expressionAt } from "./swift-expressions.js";
import { type Changes, changesIn, withChanges } from "./swift-font-changes.js";
import { FONT_TYPES, fontValues } from "./swift-font-reading.js";
import type { FontValue } from "./swift-font-values.js";
import { type SwiftTokens, tokenIndexAt } from "./swift-tokens.js";

/** A font set at one place, and the type a `.name` written there would be a member of. */
export interface FontSite {
  value: FontValue;
  /** Where the font's expression starts and ends. */
  at: number;
  end: number;
  /** `Font` in a SwiftUI `.font(…)`, `UIFont` in a UIKit `label.font = …`; otherwise unknown. */
  expects?: string;
}

/** What a font written on its own starts with: a font type (`SwiftUI.Font` too), or
 * `UIFontMetrics(…).scaledFont(for:)`. */
const FONT_ROOTS = new Set([...FONT_TYPES, "UIFontMetrics", "SwiftUI"]);

/** Every font set in `file`, each read once. */
export function fontSites(file: SwiftTokens): FontSite[] {
  const sites: FontSite[] = [];
  const read: [number, number][] = [];
  const add = (expression: Expression | undefined, expects?: string, after?: Changes) => {
    if (!expression) return;
    read.push([expression.start, expression.end]);
    for (const value of fontValues(expression)) {
      sites.push({
        value: after ? withChanges(value, after) : value,
        at: expression.start,
        end: expression.end,
        ...(expects ? { expects } : {}),
      });
    }
  };
  const { tokens } = file;
  tokens.forEach((token, i) => {
    if (token.kind !== "name" || token.text !== "font") return;
    const [before, next] = [tokens[i - 1], tokens[i + 1]];
    if (before?.text === "." && next?.text === "(" && !next.spaceBefore) add(...modifier(file, i + 1));
    else if (next?.text === ":" && isInBrackets(file, i)) add(argument(file, i + 2));
    else if (before?.text === "." && next?.text === "=")
      add(expressionAt(file, tokens[i + 2]?.start ?? file.text.length), "UIFont");
  });
  // A font written on its own, anywhere the places above didn't already read. Spans are visited in order, so the
  // check walks forward once.
  const spans = read.sort((a, b) => a[0] - b[0]);
  let span = 0;
  let readUntil = 0;
  tokens.forEach((token, i) => {
    while ((spans[span]?.[1] ?? Number.POSITIVE_INFINITY) <= token.start) span++;
    const inSpan = (spans[span]?.[0] ?? Number.POSITIVE_INFINITY) <= token.start || token.start < readUntil;
    const after = tokens[i + 1];
    // Not `SwiftUI.Font` (read with `SwiftUI`) or a key path, `\Font.body`.
    const before = tokens[i - 1]?.text;
    const root = token.kind === "name" && FONT_ROOTS.has(token.text) && before !== "." && before !== "\\";
    if (!root || inSpan || (after?.text !== "." && after?.text !== "(") || after.spaceBefore) return;
    const expression = expressionAt(file, token.start);
    readUntil = Math.max(readUntil, expression?.end ?? 0);
    add(expression);
  });
  return sites;
}

/** The font a `.font(…)` modifier sets, and the weight changes written after it on the same view. */
function modifier(file: SwiftTokens, open: number): [Expression | undefined, string, Changes] {
  const [first] = argumentsAt(file, file.tokens[open]?.start ?? 0) ?? [];
  // `T.font(for: .title)` is an app's own function: `.font(…)` takes one unlabelled argument.
  const font = first && first.label === undefined ? first.value : undefined;
  const close = file.match[open] ?? -1;
  const following =
    close === -1 || file.tokens[close + 1]?.text !== "."
      ? undefined
      : expressionAt(file, file.tokens[close + 1]?.start ?? 0);
  return [font, "Font", following ? changesIn(chain(following).links) : {}];
}

/** A `font:` argument or attribute's value: `Label(font: .title)`, `[.font: UIFont.systemFont(ofSize: 17)]`, or a
 * parameter's default, `font: UIFont = .preferredFont(forTextStyle: .body)`. */
function argument(file: SwiftTokens, at: number): Expression | undefined {
  const value = expressionAt(file, file.tokens[at]?.start ?? file.text.length);
  if (value?.kind !== "name" || !FONT_TYPES.has(value.name)) return value;
  const equals = tokenIndexAt(file, value.end);
  return file.tokens[equals]?.text === "="
    ? expressionAt(file, file.tokens[equals + 1]?.start ?? file.text.length)
    : undefined;
}

const isInBrackets = (file: SwiftTokens, index: number) => {
  const open = file.tokens[file.enclosing[index] ?? -1]?.text;
  return open === "(" || open === "[";
};
