/**
 * A React Native app's text styles, spacing and corner radii: the styles its typography objects name
 * (`typography.title = { fontSize: 22, fontWeight: "700" }`), each style written in place (a style sheet's, a `style`
 * prop's), and the padding, margins, gaps and radii its styles set.
 */

import ts from "typescript";
import { inherited, type TypeFindings, type TypeUse } from "../scan/type-scale.js";
import type { TypeStyle } from "../scan/types.js";
import {
  defaultExport,
  dottedName,
  eachNode,
  fileName,
  type JsSource,
  lineOf,
  objectIn,
  propertyName,
  renderPath,
  unwrapped,
} from "./js-sources.js";
import { familyAndWeight } from "./rn-fonts.js";
import { countUses, type Font, type Named, StyleIndex, styleLocations, UNKNOWN } from "./rn-named.js";
import { type Spreads, styleOf } from "./rn-style.js";
import { Values } from "./rn-values.js";
import { withLocations } from "./value-locations.js";

export interface RnType extends TypeFindings {
  /** The text styles the app's typography objects name, each with how many times the code reaches it. */
  named: TypeStyle[];
  /** Each spacing value a style sets, once per place. */
  spacing: number[];
  /** Each corner radius a style sets, once per place. */
  radii: number[];
}

/** `skip` holds the files that aren't the app's styles (a Tailwind config). */
export function rnType(sources: JsSource[], skip: Set<string> = new Set()): RnType {
  const read = sources.filter((s) => !skip.has(s.rel));
  const values = new Values(read);
  const none = new StyleIndex([]);
  const all = namedStyles(read, values, none, "named");
  const named = once(all);
  // A module-level style sheet's styles aren't the app's named styles, but a style spreading one takes its font
  // (`...sharedStyles.textRegular`).
  const index = new StyleIndex(named);
  const sheets = new StyleIndex(namedStyles(read, values, none, "sheet"));
  // By path first, in either (`common.label` is the sheet's), and by a name alone only after.
  const spreads = (parts: string[], from: JsSource) =>
    index.find(parts, from) ??
    sheets.find(parts, from) ??
    index.find(parts, from, true) ??
    sheets.find(parts, from, true);
  // A named style spreading another (`title: { ...fonts.body, fontSize: 24 }`) takes its font.
  for (const style of named)
    style.font = styleOf(style.object, style.source, values, spreads).font ?? style.font;
  // The named styles, platform copies included, and the branches of a `Platform.select` a style reads, aren't styles of
  // their own.
  const own = new Set<ts.Node>(all.map((n) => n.object));
  for (const n of all)
    for (const branch of styleOf(n.object, n.source, values, spreads).branches) own.add(branch);
  const uses: TypeUse[] = [];
  const spacing: number[] = [];
  const radii: number[] = [];
  const inStyles = new Set<ts.Node>();
  for (const source of read) {
    eachNode(source.file, (node) => {
      if (!ts.isObjectLiteralExpression(node)) return true;
      const style = styleOf(node, source, values, spreads);
      for (const branch of style.branches) own.add(branch);
      // A style setting its own family or size is a style of its own, even over a named one it spreads; a style that
      // only spreads one is a use of that one.
      if (style.font && style.ownFont && !own.has(node)) {
        uses.push({ ...useOf(style.font), file: source.rel, line: lineOf(node) });
        for (const spread of style.spreads) inStyles.add(spread);
        for (const read of style.fromNamed) inStyles.add(read);
      }
      spacing.push(...style.spacing);
      radii.push(...style.radii);
      return true;
    });
  }
  countUses(read, index, inStyles);
  const styles = named.map((n): TypeStyle => {
    const { family, size, weight, inherits } = useOf(n.font);
    return {
      name: n.path[n.path.length - 1] ?? "",
      kind: "app",
      family,
      ...(size === undefined ? {} : { size }),
      weight,
      ...(inherits && { inherits }),
      reference: renderPath(n.path),
      uses: n.uses,
      ...withLocations(styleLocations(n.font)),
    };
  });
  return {
    named: styles,
    uses,
    // A named style's family is listed even when nothing reaches the style.
    helperFonts: styles
      .filter((s) => s.family !== "System" && s.family !== "")
      .map((s) => ({ kind: "custom", family: s.family, weight: s.weight })),
    spacing,
    radii,
  };
}

/** A font as a use of the type scale: an unknown one when the code works it out, the family and weight a font file's
 * name carries (`Inter-SemiBold`), and a family or weight it doesn't set inherited from the text around it, which
 * sets the app's own font as often as the system's. */
function useOf(font: Font): TypeUse {
  const read = typeof font.family === "string" ? familyAndWeight(font.family) : undefined;
  const family = read?.family ?? (font.family === UNKNOWN ? "" : "System");
  const weight = font.weight === UNKNOWN ? "computed" : (font.weight ?? read?.weight ?? "regular");
  const inherits = inherited({
    family: font.family === undefined,
    weight: font.weight === undefined && !read?.weight,
  });
  return {
    kind: family === "System" ? "system" : "custom",
    family,
    ...(typeof font.size === "number" ? { size: font.size } : {}),
    weight,
    ...(inherits && { inherits }),
  };
}

/**
 * The text styles module-level objects name, `typography.title = { fontSize, fontWeight }`, by the path the code
 * uses; `export default { title: … }` is named by its file. With `"sheet"`, the styles of module-level style sheets
 * (`const sharedStyles = StyleSheet.create({ … })`) instead, written for screens rather than named for the app.
 */
function namedStyles(
  sources: JsSource[],
  values: Values,
  index: StyleIndex,
  kind: "named" | "sheet",
): Named[] {
  const out: Named[] = [];
  const spreads: Spreads = (parts, from) => index.find(parts, from, true);
  for (const source of sources) {
    const walk = (object: ts.ObjectLiteralExpression, at: string[]) => {
      const style = styleOf(object, source, values, spreads);
      if (style.font && style.ownFont && at.length > 1) {
        out.push({ path: at, source, object, font: style.font, uses: 0 });
        return;
      }
      for (const property of object.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const key = propertyName(property.name);
        const value = unwrapped(property.initializer);
        if (key !== undefined && ts.isObjectLiteralExpression(value)) walk(value, [...at, key]);
      }
    };
    for (const statement of source.file.statements) {
      const exported = defaultExport(statement);
      const object = exported && (kind === "named" ? objectIn(exported) : sheetIn(exported));
      if (object) walk(object, [fileName(source)]);
      if (!ts.isVariableStatement(statement)) continue;
      for (const d of statement.declarationList.declarations) {
        const value = d.initializer && (kind === "named" ? objectIn(d.initializer) : sheetIn(d.initializer));
        if (ts.isIdentifier(d.name) && value) walk(value, [d.name.text]);
      }
    }
  }
  return out;
}

/** The object `StyleSheet.create({ … })` makes a style sheet of. */
function sheetIn(node: ts.Expression): ts.ObjectLiteralExpression | undefined {
  const value = unwrapped(node);
  if (!ts.isCallExpression(value) || dottedName(value.expression) !== "StyleSheet.create") return undefined;
  const first = value.arguments[0] && unwrapped(value.arguments[0]);
  return first && ts.isObjectLiteralExpression(first) ? first : undefined;
}

/** One named style per path and font: a platform's copy of a style (`singleFontFamily` and `multiFontFamily` both
 * defining `fontFamily.BRAND_SANS`) is the same style. */
function once(named: Named[]): Named[] {
  const seen = new Set<string>();
  return named.filter((n) => {
    const { family, size, weight, inherits } = useOf(n.font);
    const familyKey = family.toLowerCase().replace(/[^a-z0-9]/g, "");
    const key = [n.path.join("\0"), familyKey, size, weight, inherits].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
