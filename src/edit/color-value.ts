/** A colour as an edit reads and writes it, and the case its hex digits are written in. */

/** Channels 0–255. `alpha` is missing where a notation doesn't hold the opacity, which the code then sets apart. */
export interface Color {
  red: number;
  green: number;
  blue: number;
  alpha?: number;
}

const HEX_INPUT = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i;
const HEX_DIGITS_IN_FILE = /(?:#|0[xX])([0-9a-fA-F]{6,8})(?![0-9a-fA-F])/g;

const UPPER_HEX = /[A-F]/;
const LOWER_HEX = /[a-f]/;

const byteAt = (digits: string, at: number) => Number.parseInt(digits.slice(at, at + 2), 16);

/** The channels of six hex digits, `rrggbb`. */
export const rgbOf = (digits: string): Color => ({
  red: byteAt(digits, 0),
  green: byteAt(digits, 2),
  blue: byteAt(digits, 4),
});

/** `#rrggbb` or `#rrggbbaa` as a colour; without an alpha, the colour keeps the opacity it has. */
export function parseColor(input: string): Color | undefined {
  const match = HEX_INPUT.exec(input.trim());
  const digits = match?.[1];
  if (!digits) return undefined;
  return match[2] ? { ...rgbOf(digits), alpha: byteAt(match[2], 0) } : rgbOf(digits);
}

export const hexByte = (byte: number) => byte.toString(16).padStart(2, "0");

export function showColor({ red, green, blue, alpha }: Color): string {
  return `#${[red, green, blue].map(hexByte).join("")}${alpha === undefined || alpha === 255 ? "" : hexByte(alpha)}`;
}

/** Whether two colours match, an opacity one of them doesn't hold counting as a match. */
export function sameColor(a: Color, b: Color): boolean {
  if (a.red !== b.red || a.green !== b.green || a.blue !== b.blue) return false;
  return a.alpha === undefined || b.alpha === undefined || a.alpha === b.alpha;
}

/** The opacity `to` has in place of `from`: its own, or else the one it keeps. */
export const alphaOf = (from: Color, to: Color) => to.alpha ?? from.alpha ?? 255;

/** Whether `to` keeps the opacity of `from`, which a notation without one needs, since the code sets it apart. */
export const keepsAlpha = (from: Color, to: Color) => alphaOf(from, to) === (from.alpha ?? 255);

/** Whether hex digits are written upper case: as `digits` are, or when they have no letters, as most in the file
 * are, upper case when it's even. */
export function isUpperCase(digits: string, fileText: string): boolean {
  if (UPPER_HEX.test(digits)) return true;
  if (LOWER_HEX.test(digits)) return false;
  let upper = 0;
  let lower = 0;
  for (const [, found = ""] of fileText.matchAll(HEX_DIGITS_IN_FILE)) {
    if (UPPER_HEX.test(found)) upper++;
    else if (LOWER_HEX.test(found)) lower++;
  }
  return upper >= lower;
}
