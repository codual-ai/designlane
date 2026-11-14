/** The colours a React Native app's theme objects and constants name, as written, and each one's value once its
 * aliases are followed. */

import ts from "typescript";
import type { CodeSpan, ValueLocation } from "../scan/types.js";
import { colorOf } from "./css-color.js";
import {
  accessPath,
  defaultExport,
  fileName,
  type JsSource,
  lineOf,
  literalLocation,
  nodeSpan,
  objectIn,
  propertyName,
  stringValue,
  unwrapped,
} from "./js-sources.js";
import { MAX_HOPS, type Modules } from "./rn-color-modules.js";
import { MODE, THEMES } from "./rn-themes.js";
import { followNames, through, valueAt } from "./value-locations.js";

/** Style properties that take a colour: in a style, a colour there is one the code uses, not one it names. */
export const STYLE_COLOR = new Set([
  "color",
  "backgroundColor",
  "borderColor",
  "borderTopColor",
  "borderRightColor",
  "borderBottomColor",
  "borderLeftColor",
  "borderStartColor",
  "borderEndColor",
  "borderBlockColor",
  "borderBlockStartColor",
  "borderBlockEndColor",
  "shadowColor",
  "tintColor",
  "overlayColor",
  "textDecorationColor",
  "textShadowColor",
  "outlineColor",
  "placeholderTextColor",
  "underlayColor",
  "selectionColor",
  "fill",
  "stroke",
]);
/** Style properties that aren't colours: an object setting one is a style, not a theme (`{ padding, color }`). */
const STYLE_LAYOUT =
  /^(?:margin\w*|padding\w*|border(?:Top|Right|Bottom|Left|Start|End)?(?:Width|Radius|Style)|border\w*Radius|flex\w*|width|height|(?:min|max)(?:Width|Height)|position|top|right|bottom|left|start|end|font(?:Size|Weight|Family|Style)|lineHeight|letterSpacing|text(?:Align|Transform)|opacity|elevation|shadow(?:Offset|Opacity|Radius)|justifyContent|align(?:Items|Self|Content)|overflow|zIndex|gap|rowGap|columnGap|aspectRatio|display)$/;

/** A colour a theme object names, before its aliases are followed and its light and dark values paired. */
export interface Entry {
  name: string;
  /** The path the code reaches it by: `colors.surface`, `themes.light.surface`. */
  path: string[];
  source: JsSource;
  line: number;
  value?: string;
  /** The path another colour is reached by, for `primary: palette.blue500`. */
  aliasOf?: string[];
  /** Where its value, or the name of the one it takes, is written. */
  written: CodeSpan;
  /** Where the code names it, which isn't a use of it. */
  node: ts.Node;
  /** The object literal it's a property of; none for a module-level constant. */
  holder?: ts.ObjectLiteralExpression;
}
export type Valued = Entry & { value: string; location: ValueLocation };

/** A style rather than a theme: an object setting a layout property (`{ padding: 8, color: "#333" }`), or only style
 * properties (`{ borderColor: "#eee" }`). A theme names its own colours (`{ text, backgroundColor }`). */
function isStyle(object: ts.ObjectLiteralExpression): boolean {
  const names = object.properties.flatMap((p) => {
    const name = p.name && propertyName(p.name);
    return name === undefined || ts.isSpreadAssignment(p) ? [] : [name];
  });
  return (
    names.some((n) => STYLE_LAYOUT.test(n)) || (names.length > 0 && names.every((n) => STYLE_COLOR.has(n)))
  );
}

/** The module-level colours of `source`: constants (`const brand = "#3366e6"`) and objects' colour properties,
 * nested or not, by the path the code reaches them by. A spread object's colours come first and the object's own
 * replace them, as they do when the code runs. */
export function collectNamed(
  source: JsSource,
  modules: Modules,
  leaves: Map<ts.ObjectLiteralExpression, number>,
): Entry[] {
  const walk = (object: ts.ObjectLiteralExpression, at: string[], from: JsSource, hops: number): Entry[] => {
    // A light or dark theme names its colours, whatever it calls them (`{ color, backgroundColor }`).
    const inTheme = at.some((part) => MODE.test(part) || THEMES.test(part));
    if (!inTheme && isStyle(object)) return [];
    // By the key under this object each colour sits at, so an own property replaces a spread's.
    const own = new Map<string, Entry[]>();
    let values = 0;
    const under = (e: Entry) => e.path[at.length] ?? "";
    for (const property of object.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = unwrapped(property.expression);
        const target =
          ts.isIdentifier(spread) && hops < MAX_HOPS ? modules.object(from, spread.text) : undefined;
        if (!target) continue;
        // Whichever comes later wins, a spread's key or the object's own.
        const fromSpread = new Map<string, Entry[]>();
        for (const e of walk(target.object, at, target.source, hops + 1))
          fromSpread.set(under(e), [...(fromSpread.get(under(e)) ?? []), e]);
        for (const [key, list] of fromSpread) {
          own.delete(key);
          own.set(key, list);
        }
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        const key = property.name.text;
        const written = nodeSpan(from, property.name);
        own.set(key, [entry(key, at, property, from, object, { aliasOf: [key], written })]);
        continue;
      }
      if (!ts.isPropertyAssignment(property)) continue;
      const key = propertyName(property.name);
      if (key === undefined) continue;
      const value = unwrapped(property.initializer);
      if (ts.isObjectLiteralExpression(value)) {
        own.set(key, walk(value, [...at, key], from, hops));
        continue;
      }
      const text = stringValue(value);
      const color = text === undefined ? undefined : colorOf(text, true);
      const aliasOf = color ? undefined : accessPath(value);
      // Plain values other than colours (`title: "Home"`, `size: 8`) tell options from a theme; a value that can't be
      // read (`Platform.select(…)`, a library's palette) doesn't.
      if (color || isPlain(value)) values++;
      const held = color
        ? { value: color, written: valueSpan(from, value) }
        : aliasOf && { aliasOf, written: nodeSpan(from, value) };
      if (!held) {
        own.delete(key);
        continue;
      }
      own.set(key, [entry(key, at, property, from, object, held)]);
    }
    leaves.set(object, values);
    return [...own.values()].flat();
  };
  const entries: Entry[] = [];
  for (const statement of source.file.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const d of statement.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        const value = objectIn(d.initializer);
        if (value) entries.push(...walk(value, [d.name.text], source, 0));
        const text = stringValue(d.initializer);
        const color = text === undefined ? undefined : colorOf(text);
        if (color)
          entries.push({
            name: d.name.text,
            path: [d.name.text],
            source,
            line: lineOf(d),
            value: color,
            written: valueSpan(source, unwrapped(d.initializer)),
            node: d,
          });
      }
    }
    const exported = defaultExport(statement);
    const value = exported && objectIn(exported);
    // `export default { … }` is imported by the file's name: `import colors from "./colors"`.
    if (value) entries.push(...walk(value, [fileName(source)], source, 0));
  }
  return entries;
}

/** Where a colour's string is written, without its quotes. */
const valueSpan = (source: JsSource, node: ts.Expression) =>
  literalLocation(source, node) ?? nodeSpan(source, node);

/** A string, number or boolean written as it is. */
const isPlain = (node: ts.Expression) =>
  ts.isStringLiteral(node) ||
  ts.isNoSubstitutionTemplateLiteral(node) ||
  ts.isNumericLiteral(node) ||
  node.kind === ts.SyntaxKind.TrueKeyword ||
  node.kind === ts.SyntaxKind.FalseKeyword;

function entry(
  key: string,
  at: string[],
  node: ts.Node,
  source: JsSource,
  holder: ts.ObjectLiteralExpression,
  held: { value?: string; aliasOf?: string[]; written: CodeSpan },
): Entry {
  // A shade in a scale, `charcoal: { 500: … }`, is named by its scale too: `charcoal-500`.
  const name = /^\d+$/.test(key) && at.length > 0 ? `${at[at.length - 1]}-${key}` : key;
  return { name, path: [...at, key], source, line: lineOf(node), node, holder, ...held };
}

/** The colours of objects that are mostly colours: a theme, not options holding one (`{ title: "Home",
 * headerTintColor }`). A theme's few plain values (`type: "Denim"`) don't change that, nor do values that can't be read. */
export function mostlyColors(entries: Valued[], leaves: Map<ts.ObjectLiteralExpression, number>): Valued[] {
  const colors = new Map<ts.ObjectLiteralExpression, number>();
  for (const e of entries) if (e.holder) colors.set(e.holder, (colors.get(e.holder) ?? 0) + 1);
  return entries.filter((e) => !e.holder || (colors.get(e.holder) ?? 0) * 2 > (leaves.get(e.holder) ?? 0));
}

/**
 * Each entry with a value, following aliases (`appBG: colors.productDark100`): in the entry's own file, then through
 * what it imports (`import appColors from "./palette"`), then by the path's end when only one colour has that end.
 * Aliases that reach no colour are dropped.
 */
export function resolveAliases(entries: Entry[], modules: Modules): Valued[] {
  const byFile = new Map<JsSource, Map<string, Entry>>();
  // A path or a path's end that only one colour has, for an alias into a file imported by a path alias (`@styles/…`).
  const byEnd = new Map<string, Entry | null>();
  for (const e of entries) {
    const own = byFile.get(e.source) ?? new Map<string, Entry>();
    const full = e.path.join("\0");
    if (!own.has(full)) own.set(full, e);
    byFile.set(e.source, own);
    for (let i = 0; i < e.path.length; i++) {
      const end = e.path.slice(i).join("\0");
      byEnd.set(end, byEnd.has(end) && byEnd.get(end) !== e ? null : e);
    }
  }
  const target = (from: Entry, alias: string[]): Entry | undefined => {
    const own = byFile.get(from.source)?.get(alias.join("\0"));
    if (own) return own;
    const imported = modules.imported(from.source, alias[0] ?? "");
    const there = imported && byFile.get(imported.source)?.get([imported.root, ...alias.slice(1)].join("\0"));
    return there ?? byEnd.get(alias.join("\0")) ?? undefined;
  };
  const resolve = (e: Entry): { value: string; location: ValueLocation } | undefined => {
    const next = (at: Entry) => {
      if (at.value) return null;
      const to = at.aliasOf ? target(at, at.aliasOf) : undefined;
      return to === at ? undefined : to;
    };
    const found = followNames(e, next, (at) => at.written, MAX_HOPS);
    const value = found?.target.value;
    return found && value
      ? { value, location: through(valueAt(found.target.written, "literal"), found.via) }
      : undefined;
  };
  return entries.flatMap((e) => {
    const resolved = resolve(e);
    return resolved ? [{ ...e, ...resolved }] : [];
  });
}
