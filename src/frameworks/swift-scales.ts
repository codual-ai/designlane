/**
 * Spacing and corner radius scales declared in Swift: numbers a type of that name declares as its own,
 * `enum AppSpacing { static let large: CGFloat = 16 }`, at the top level or inside the app's theme
 * (`enum Theme { enum Spacing { … } }`). One nested in a screen's or feature's own type (`Onboarding.Spacing`) is
 * that screen's constants, and `CGFloat` members (`extension CGFloat { static let margin = 16 }`) are left out too:
 * apps declare those for one view as often as for the whole app.
 */

import {
  countChains,
  countUse,
  indexBy,
  type ScaleCandidate,
  scaleKindOf,
  stepKindOf,
} from "../scan/scales.js";
import { locator } from "./source-text.js";
import { memberOf, ownerAt, qualifiedOwnerAt } from "./swift-owners.js";
import type { Token } from "./swift-tokens.js";
import { type SwiftSource, tokensOf } from "./swiftui-sources.js";
import { valueAt } from "./value-locations.js";

/** Types a scale may sit inside and still be the whole app's: `Theme.Spacing`, `DesignSystem.Radius`. */
const DESIGN_SYSTEM = /(?:Theme|Design|DesignSystem|Style|Styles|Tokens?|Foundations?|DS)$/;
/** A screen's own type, whose constants are its layout's, however many files extending it use them:
 * `MenuTableView.UX.topPadding`, `ContactCellView.avatarSpacing`. */
const SCREEN_TYPE = /(?:View|ViewController|Controller|Cell|ViewModel|Screen|Coordinator)$/;
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
      const scale = inScale && outer.every((name) => DESIGN_SYSTEM.test(name)) ? inScale : undefined;
      // Outside a scale, a constant whose own name says what it is: `extension CGFloat { static let
      // statusColumnsSpacing: CGFloat = 8 }`, kept when another file uses it.
      const kind =
        scale ??
        (inScale || qualified.split(".").some((t) => SCREEN_TYPE.test(t))
          ? undefined
          : stepKindOf(declared.name));
      if (!kind) continue;
      const span = locate(declared.at.start, declared.at.end);
      found.push({
        kind,
        ...(!scale && { named: true }),
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

/** Counts each step's uses by name in every file: `AppSpacing.large`, and a number type's own member written where
 * the type is known, `.padding(.statusColumnsSpacing)` for `CGFloat.statusColumnsSpacing`. */
function countUses(found: ScaleCandidate[], sources: SwiftSource[]): void {
  if (found.length === 0) return;
  const byReference = indexBy(found, (c) => [c.step.reference]);
  countChains(sources, (parts) => byReference.get(parts.join(".")));
  const implicit = indexBy(
    found.filter((c) => NUMBER_TYPES.has(c.scale)),
    (c) => [c.step.name],
  );
  if (implicit.size === 0) return;
  for (const source of sources) {
    const { tokens } = tokensOf(source);
    for (let i = 0; i < tokens.length - 1; i++) {
      if (tokens[i]?.text !== "." || !implicitAt(tokens, i)) continue;
      // One number type's member of the name, or none: which of several it is can't be told from `.name` alone.
      const steps = implicit.get(tokens[i + 1]?.text ?? "") ?? [];
      if (steps.length === 1 && steps[0]) countUse(steps[0].usedIn, source.rel);
    }
  }
}

/** Tokens a member's `.` follows when it's another value's member, `a.b` or `f().b`, rather than written alone. */
const MEMBER_AFTER = new Set(["name", "number", "string"]);

/** Whether the `.` at `index` starts an implicit member, `.statusColumnsSpacing`, not another value's `a.b`. */
function implicitAt(tokens: Token[], index: number): boolean {
  const before = tokens[index - 1];
  if (!before) return true;
  // `flag ? .rowPadding : 0` and `x == .rowPadding`; a line starting `.rowPadding` continues a chain instead.
  if (tokens[index]?.spaceBefore && !tokens[index]?.newlineBefore) return true;
  return !MEMBER_AFTER.has(before.kind) && ![")", "]", "?", "!", ">"].includes(before.text);
}
