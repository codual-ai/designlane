/**
 * Spacing and corner radius scales declared in Swift: numbers a type of that name declares as its own,
 * `enum WMFSpacing { static let large: CGFloat = 16 }`, at the top level or inside the app's theme
 * (`enum Theme { enum Spacing { … } }`). One nested in a screen's or feature's own type (`UX.Onboarding.Spacing`) is
 * that screen's constants, and `CGFloat` members (`extension CGFloat { static let margin = 16 }`) are left out too:
 * apps declare those for one view as often as for the whole app.
 */

import { countChains, indexBy, type ScaleCandidate, scaleKindOf } from "../scan/scales.js";
import { locator } from "./source-text.js";
import { memberOf, ownerAt, qualifiedOwnerAt } from "./swift-owners.js";
import type { Token } from "./swift-tokens.js";
import { type SwiftSource, tokensOf } from "./swiftui-sources.js";
import { valueAt } from "./value-locations.js";

/** Types a scale may sit inside and still be the whole app's: `Theme.Spacing`, `DesignSystem.Radius`. */
const DESIGN_SYSTEM = /(?:Theme|Design|DesignSystem|Style|Styles|Tokens?|Foundations?|DS)$/;
/** Modifiers keeping a declaration to its own file or type. */
const PRIVATE = new Set(["private", "fileprivate"]);

/** The number types a scale's steps are declared as. */
const NUMBER_TYPES = new Set(["CGFloat", "Double", "Float", "Int"]);
/** A plain decimal number, `16` or `1.5`, as a step's value is written. */
const DECIMAL = /^\d[\d_]*(?:\.\d[\d_]*)?$/;

/** A `static let` or `static var` holding a number written as it is, and nothing else. */
interface Declared {
  name: string;
  value: number;
  at: Token;
  /** The index of its `static`. */
  index: number;
}

/** Every scale step the Swift code declares, with the files using each by name. */
export function swiftScaleCandidates(sources: SwiftSource[]): ScaleCandidate[] {
  const found: ScaleCandidate[] = [];
  for (const source of sources) {
    const file = tokensOf(source);
    const locate = locator(source.rel, source.text);
    for (const declared of declarations(file.tokens)) {
      const owner = ownerAt(file, declared.index);
      const inScale = scaleKindOf(owner);
      const qualified = qualifiedOwnerAt(file, declared.index);
      const outer = qualified.split(".").slice(0, -1);
      if (!inScale || !outer.every((name) => DESIGN_SYSTEM.test(name))) continue;
      const span = locate(declared.at.start, declared.at.end);
      found.push({
        kind: inScale,
        scale: qualified,
        step: {
          name: declared.name,
          value: declared.value,
          reference: memberOf(qualified, declared.name),
          source: source.rel,
          line: span.line,
          location: valueAt(span, "literal"),
        },
        usedIn: new Map(),
      });
    }
  }
  countUses(found, sources);
  return found;
}

/** Tokens that end the declaration before a member's: its own modifiers and attributes come after them. */
const DECLARATION_START = new Set(["{", "}", ";", "let", "var", "func", "case", "init"]);
/** How far back a member's modifiers and attributes (`@available(*, deprecated, message: "…")`) are read. */
const MAX_MODIFIER_TOKENS = 24;

/** Whether the member whose `static` is at `index` is private to its file or type, or marked deprecated. */
function hidden(tokens: Token[], index: number): boolean {
  for (let k = index - 1; k >= 0 && k >= index - MAX_MODIFIER_TOKENS; k--) {
    const text = tokens[k]?.text ?? "";
    if (DECLARATION_START.has(text)) return false;
    if (PRIVATE.has(text) || text === "deprecated") return true;
  }
  return false;
}

/** `static let name: CGFloat = 16`, the value ending the statement: not `= 16 * scale`, nor `= 16` continued on the
 * next line (`* scale`, `.rounded()`). */
function* declarations(tokens: Token[]): Generator<Declared> {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]?.text !== "static" || hidden(tokens, i)) continue;
    let at = i + 1;
    if (!["let", "var"].includes(tokens[at]?.text ?? "")) continue;
    const name = tokens[++at];
    if (name?.kind !== "name") continue;
    at++;
    if (tokens[at]?.text === ":") {
      if (!NUMBER_TYPES.has(tokens[at + 1]?.text ?? "")) continue;
      at += 2;
    }
    if (tokens[at]?.text !== "=") continue;
    const value = tokens[at + 1];
    if (value?.kind !== "number" || !DECIMAL.test(value.text)) continue;
    const after = tokens[at + 2];
    const continues = after?.kind === "operator" || after?.text === ".";
    if (after && (continues || (!after.newlineBefore && after.text !== ";" && after.text !== "}"))) continue;
    yield { name: name.text, value: Number(value.text.replaceAll("_", "")), at: value, index: i };
  }
}

/** Counts each step's uses by name in every file: `WMFSpacing.large`. */
function countUses(found: ScaleCandidate[], sources: SwiftSource[]): void {
  if (found.length === 0) return;
  const byReference = indexBy(found, (c) => [c.step.reference]);
  countChains(sources, (parts) => byReference.get(parts.join(".")));
}
