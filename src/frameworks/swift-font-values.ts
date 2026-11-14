/** The parts of a font a Swift expression writes: what a font value is, and how its size and weight are read and
 * where each is written. */

import { COMPUTED, type TypeUse } from "../scan/type-scale.js";
import type { TypeLocations, ValueKind } from "../scan/types.js";
import type { Argument, Expression } from "./swift-expressions.js";
import { type TextStyleName, WEIGHTS } from "./swift-font-names.js";

/** A reference to one of the app's own font helpers: `.scaledBody`, `AppFont.title`, `UIFont.dynamicTypeBody`. */
export interface HelperReference {
  /** The type it's named on; undefined when written as `.name` and found by the type the context expects. */
  owner?: string;
  name: string;
  args: Argument[];
  /** Whether it's called, `.brand(size: 24)`, so it names a helper function rather than a property. */
  called: boolean;
  /** A weight or size set on the helper's font after it: `.dynamicTypeFootnote.semibold()`, `.withSize(32)`. */
  weight?: string;
  size?: number;
  /** Where the reference starts. */
  at: number;
}

/** Where a font's family, size and weight are written in its file, by the token value each is. */
export type FontSpans = { [K in keyof TypeLocations]?: { start: number; end: number; kind: ValueKind } };

/** A font an expression sets: one written out (with the text style it is, if any, the parameter its size comes
 * straight from, `size: size`, so a helper's call can supply it, and where its values are written), or one of the
 * app's helpers. */
export type FontValue =
  | { font: TypeUse; style?: TextStyleName; sizeFrom?: string; spans?: FontSpans }
  | { helper: HelperReference };

/** Conversions that keep a number as it is: `CGFloat(17)`. */
const NUMBER_TYPES = new Set(["CGFloat", "Double", "Float", "Int"]);

/** `{ start, end }` as the place a value of `kind` is written. */
export const fontSpan = ({ start, end }: { start: number; end: number }, kind: ValueKind) => ({
  start,
  end,
  kind,
});

/** `.bold`, `Font.Weight.bold` or `UIFont.Weight.bold` as a weight; anything else is worked out at run time. */
export function weightOf(value: Expression | undefined): string | undefined {
  if (!value) return undefined;
  return value.kind === "member" && WEIGHTS.has(value.name) ? value.name : COMPUTED;
}

/** A size written as a number, `17` or `CGFloat(17)`; nothing for one worked out at run time (`adaptive(14)`). */
export function sized(value: Expression | undefined): { size?: number } {
  const number = numberIn(value);
  return number ? { size: number.value } : {};
}

/** The number a size is written as: `17`, or `17` in `CGFloat(17)`. */
export function numberIn(value: Expression | undefined): (Expression & { kind: "number" }) | undefined {
  const converted =
    value?.kind === "call" && value.callee.kind === "name" && NUMBER_TYPES.has(value.callee.name);
  // Only an unlabelled conversion keeps the number as it is: `CGFloat(exactly: 17)` may give no number at all.
  const plain = converted && value.args.length === 1 && value.args[0]?.label === undefined;
  const number = plain ? value.args[0]?.value : value;
  return number?.kind === "number" ? number : undefined;
}
