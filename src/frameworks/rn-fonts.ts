/** Font families and weights as React Native writes them. */

/** CSS's weight names and numbers as the weights Designlane names. */
export const WEIGHTS: Record<string, string> = {
  "100": "thin",
  "200": "ultraLight",
  "300": "light",
  "400": "regular",
  normal: "regular",
  "500": "medium",
  "600": "semibold",
  "700": "bold",
  bold: "bold",
  "800": "heavy",
  "900": "black",
  // React Native 0.71's names.
  ultralight: "ultraLight",
  thin: "thin",
  light: "light",
  medium: "medium",
  regular: "regular",
  semibold: "semibold",
  condensedBold: "bold",
  condensed: "regular",
  heavy: "heavy",
  black: "black",
};
/** A weight in a font file's name: `Inter-SemiBold`, `OpenSans_Bold`, `ProximaNova-Semibold`, and expo-google-fonts'
 * `Inter_700Bold`. */
const FAMILY_WEIGHT =
  /^(.+?)(?:[-_ ]?\d{3})?[-_ ]?(Thin|ExtraLight|UltraLight|Light|Regular|Book|Medium|SemiBold|DemiBold|Bold|ExtraBold|UltraBold|Heavy|Black)$/i;
const NAMED_WEIGHT: Record<string, string> = {
  thin: "thin",
  extralight: "ultraLight",
  ultralight: "ultraLight",
  light: "light",
  regular: "regular",
  book: "regular",
  medium: "medium",
  semibold: "semibold",
  demibold: "semibold",
  bold: "bold",
  extrabold: "heavy",
  ultrabold: "heavy",
  heavy: "heavy",
  black: "black",
};
/** Families that stand for the platform's own font. */
const GENERIC =
  /^(?:system-ui|-apple-system|blinkmacsystemfont|sans-serif|serif|monospace|ui-\w+|system|roboto|sf pro\w*|helvetica(?: ?neue)?|arial)$/i;

/** A `fontFamily` as a family and the weight its name carries: `Inter-SemiBold` is Inter semibold, a web stack
 * (`"Inter", system-ui, sans-serif`) its first family, and the platform's own font, whatever its weight
 * (`Roboto-Bold`), `System`. */
export function familyAndWeight(written: string): { family: string; weight?: string } {
  const first = written
    .split(",")
    .map((f) => f.trim().replace(/^["']|["']$/g, ""))
    .find((f) => f !== "");
  if (!first) return { family: "System" };
  const plain = first.replace(/[-_ ]?Italic$/i, "");
  const m = plain.match(FAMILY_WEIGHT);
  const weight = m ? NAMED_WEIGHT[(m[2] ?? "").toLowerCase()] : undefined;
  const family = (m ? m[1] : plain) || plain;
  return { family: GENERIC.test(family) ? "System" : family, ...(weight ? { weight } : {}) };
}
