/** Colours written as hex digits: a literal (`#3366CC`, Android's `#AARRGGBB`) or one inside a call
 * (`Color(0xFF6650A4)`, `.init(hex: 0x112233)`, `UIColor(hex: "#112233")`). */

import { alphaOf, type Color, hexByte, isUpperCase, keepsAlpha } from "./color-value.js";
import { callArguments, type Language, type SpanText, spliced, type Written } from "./notation.js";

/** Where eight digits keep the opacity: last (CSS, most Swift helpers) or first (Android, Compose). */
type Layout = "rgba" | "argb";

const HEX_LITERAL = /^#([0-9a-fA-F]+)$/;
const HEX_INTEGER = /0[xX]([0-9a-fA-F]+)(?![0-9a-fA-F])/g;
const HEX_STRING = /(["'])#?([0-9a-fA-F]+)\1/g;
const LENGTHS = new Set([3, 4, 6, 8]);
/** A number in code is a colour only at full length; `0xFFF` is no colour. */
const INTEGER_LENGTHS = new Set([6, 8]);
const BYTE_PAIRS = /../g;
/** A short form's digit stands for itself twice: `f` is `ff`, 17 × 15. */
const NIBBLE = 17;

/** The ways a literal or a call's one hex number can be read, each with how to write another colour the same way. */
export function hexReadings({ text, kind, language, fileText }: SpanText): Written<Color>[] {
  if (kind === "literal") {
    const digits = HEX_LITERAL.exec(text)?.[1];
    const layout = language === "xml" ? "argb" : "rgba";
    return digits ? reading(digits, layout, fileText, (written) => `#${written}`) : [];
  }
  const args = kind === "expression" ? callArguments(text) : undefined;
  const found = args ? [...text.matchAll(HEX_INTEGER), ...text.matchAll(HEX_STRING)] : [];
  const [only] = found;
  // The number must be a whole argument: `0x112233 + offset` is worked out as the app runs.
  const isArgument = args?.some((arg) => arg.start === only?.index && arg.value === only[0]);
  if (found.length !== 1 || !only || !isArgument) return [];
  const isString = only[2] !== undefined;
  const digits = only[2] ?? only[1] ?? "";
  if (!isString && !INTEGER_LENGTHS.has(digits.length)) return [];
  const start = (only.index ?? 0) + only[0].lastIndexOf(digits);
  const write = (written: string) => spliced(text, [{ start, end: start + digits.length, text: written }]);
  return layoutsIn(language).flatMap((layout) => reading(digits, layout, fileText, write));
}

/** Kotlin's colour integers are ARGB; elsewhere a helper decides, so both are tried against the value it has. */
const layoutsIn = (language: Language): Layout[] => (language === "kotlin" ? ["argb"] : ["rgba", "argb"]);

function reading(
  digits: string,
  layout: Layout,
  fileText: string,
  write: (digits: string) => string,
): Written<Color>[] {
  if (!LENGTHS.has(digits.length)) return [];
  const short = digits.length < 6;
  const bytes = (short ? [...digits].map((d) => d + d).join("") : digits).match(BYTE_PAIRS) ?? [];
  const [first, second, third, fourth] = bytes.map((pair) => Number.parseInt(pair, 16));
  if (first === undefined || second === undefined || third === undefined) return [];
  const value: Color =
    fourth === undefined
      ? { red: first, green: second, blue: third }
      : layout === "rgba"
        ? { red: first, green: second, blue: third, alpha: fourth }
        : { red: second, green: third, blue: fourth, alpha: first };
  const upper = isUpperCase(digits, fileText);
  return [
    {
      value,
      write: (to, from) => {
        if (fourth === undefined && !keepsAlpha(from, to)) return undefined;
        const channels = [to.red, to.green, to.blue];
        if (fourth !== undefined) {
          const alpha = alphaOf(from, to);
          if (layout === "rgba") channels.push(alpha);
          else channels.unshift(alpha);
        }
        const written =
          short && channels.every((byte) => byte % NIBBLE === 0)
            ? channels.map((byte) => (byte / NIBBLE).toString(16)).join("")
            : channels.map(hexByte).join("");
        return write(upper ? written.toUpperCase() : written);
      },
    },
  ];
}
