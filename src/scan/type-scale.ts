/**
 * Turns every text style a framework plugin found into the app's type scale: identical styles are merged however
 * they were written (`HelveticaNeue` and `Helvetica Neue` are one family), ranked by how often the code uses them,
 * and custom font families are listed by use.
 */

import { byText, mostCommon } from "./counting.js";
import type { DesignTokens, TypeLocations, TypeStyle } from "./types.js";

/** One place the code sets a font. `style` names a platform text style (`headline`) or an app's own helper. */
export interface TypeUse {
  kind: TypeStyle["kind"];
  family: string;
  size?: number;
  weight: string;
  style?: string;
  /** The app's own helper the code calls for it: `Font.brandTitle`. */
  reference?: string;
  /** Where the code sets it, when known: the file, and the 1-based line. */
  file?: string;
  line?: number;
  /** Where its values are written, for one of the app's helpers. */
  locations?: TypeLocations;
}

/** A weight the code works out as it runs (`weight: isOn ? .bold : .regular`). */
export const COMPUTED = "computed";
export const weightLabel = (weight: string) => (weight === COMPUTED ? "computed weight" : weight);

export interface TypeFindings {
  uses: TypeUse[];
  /** The fonts written inside the app's own font helpers, where they're written. They count in the scale through the
   * helpers' uses; their families are listed in `fonts` even when a helper mixes several or isn't used. */
  helperFonts: TypeUse[];
}

type TypeScale = Pick<DesignTokens, "typeStyles" | "fonts">;

export function typeScale({ uses, helperFonts }: TypeFindings): TypeScale {
  const family = canonicalFamilies([...uses, ...helperFonts]);
  const merged = new Map<string, TypeStyle>();
  for (const use of uses) {
    const style: Omit<TypeStyle, "uses"> = {
      name: use.style ?? describe(family(use.family), use.size, use.weight),
      kind: use.kind,
      family: family(use.family),
      ...(use.size === undefined ? {} : { size: use.size }),
      weight: use.weight,
      ...(use.reference ? { reference: use.reference } : {}),
    };
    const key = [style.kind, style.name, style.family, style.size, style.weight, style.reference].join("|");
    const found = merged.get(key);
    // Every use of one helper has its places, so the first use's are the style's.
    if (found) found.uses++;
    else merged.set(key, { ...style, uses: 1, ...(use.locations ? { locations: use.locations } : {}) });
  }
  const ranked = [...merged.values()].sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));
  // Custom families by use, then those written only inside the app's helpers.
  const custom = uses.filter((u) => isCustom(u.family)).map((u) => family(u.family));
  const used = mostCommon(custom, byText).map(({ value }) => value);
  const inHelpers = helperFonts.filter((f) => isCustom(f.family)).map((f) => family(f.family));
  return {
    typeStyles: ranked,
    fonts: [...new Set([...used, ...inHelpers])],
  };
}

/** `Inter 17 bold`, `Inter 17` for the regular weight, `Inter, computed size`, or `Unknown font 17` when the family is
 * computed. */
const describe = (family: string, size: number | undefined, weight: string) =>
  [
    (family || "Unknown font") + (size === undefined ? "," : ""),
    size ?? "computed size",
    weight === "regular" ? undefined : weightLabel(weight),
  ]
    .filter((part) => part !== undefined)
    .join(" ");

const isCustom = (family: string) => family !== "System" && family !== "";

/** `Helvetica Neue`, `HelveticaNeue` and `helvetica-neue` are one family. */
const familyKey = (family: string) => family.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Maps each family to the spelling the code uses most. */
function canonicalFamilies(uses: Pick<TypeUse, "family">[]): (family: string) => string {
  const spellings = new Map<string, string[]>();
  for (const { family } of uses) {
    const key = familyKey(family);
    const list = spellings.get(key);
    if (list) list.push(family);
    else spellings.set(key, [family]);
  }
  const canonical = new Map(
    [...spellings].map(([key, names]) => [key, mostCommon(names, byText)[0]?.value ?? ""]),
  );
  return (family) => canonical.get(familyKey(family)) || family;
}
