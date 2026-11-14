/**
 * A React Native app's colours: those its theme objects name (`colors.surface`, with a `light` and `dark` object
 * paired into one colour), where the code uses them, and the colours written straight into styles.
 */

import path from "node:path";
import ts from "typescript";
import type { ColorFindings, NamedColor } from "../scan/palette.js";
import type { CodeSpan, ValueLocation } from "../scan/types.js";
import { CSS_NAMES, colorOf } from "./css-color.js";
import {
  accessPath,
  defaultExport,
  eachNode,
  fileName,
  type JsSource,
  lineOf,
  literalSpan,
  nodeSpan,
  objectIn,
  platformChoice,
  propertyName,
  renderPath,
  shadowed,
  unwrapped,
} from "./js-sources.js";
import { MODE, modeOf, namedColor, THEMES, themesApart } from "./rn-themes.js";
import { TAILWIND_CONFIG } from "./tailwind-colors.js";
import { followNames, through, valueAt } from "./value-locations.js";

/** Style properties that take a colour: in a style, a colour there is one the code uses, not one it names. */
const STYLE_COLOR = new Set([
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
/** A name a theme is reached through: `theme`, `colors`, `palette`, or one ending so (`appTheme`, `darkColors`). */
const THEME_WORD = /^(?:theme|colou?rs?|palette)$|[a-z](?:Theme|Colou?rs?|Palette)$/;
/** How many aliases (`primary: palette.blue500`) or spread objects are followed. */
const MAX_HOPS = 5;

/** A colour a theme object names, before its aliases are followed and its light and dark values paired. */
interface Entry {
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
type Valued = Entry & { value: string; location: ValueLocation };

/** `tailwind` holds the files whose colours Tailwind names (see tailwind-colors.ts), left out here. */
export function rnColors(sources: JsSource[], tailwind: Set<string> = new Set()): ColorFindings {
  const read = sources.filter((s) => !TAILWIND_CONFIG.test(s.rel) && !tailwind.has(s.rel));
  const modules = new Modules(read);
  const leaves = new Map<ts.ObjectLiteralExpression, number>();
  const entries = read.flatMap((source) => collectNamed(source, modules, leaves));
  const valued = mostlyColors(resolveAliases(entries, modules), leaves);
  const { kept, themes } = themesApart(valued);
  const named = once(pairModes(kept));
  const known: Known = {
    names: new Set(named.map((c) => c.name)),
    constants: constantsByName(valued),
    definitions: new Set(valued.map((e) => e.node)),
    holders: new Set(valued.flatMap((e) => e.path.slice(0, -1).map((part) => part.toLowerCase()))),
  };
  const found: ColorFindings = {
    named,
    references: [],
    literals: [],
    system: [],
    ...(themes.length > 0 ? { themes } : {}),
  };
  for (const source of read) collectUses(source, known, found);
  return found;
}

/** Each file's module-level objects and imports, to follow a spread or an alias into the file defining it. */
class Modules {
  private readonly byRel: Map<string, JsSource>;
  private readonly objects = new Map<JsSource, Map<string, ts.ObjectLiteralExpression>>();
  /** For each file, the name its default export's paths start with: its variable's, or the file's own. */
  private readonly defaultName = new Map<JsSource, string>();
  /** A name holding the object another name holds on iOS, by `file#name`: `black` is `blackIOS`. */
  private readonly choices = new Map<string, string>();
  private readonly imports = new Map<JsSource, Map<string, { from: string; name: string }>>();

  constructor(sources: JsSource[]) {
    this.byRel = new Map(sources.map((s) => [s.rel, s]));
    for (const source of sources) {
      const objects = new Map<string, ts.ObjectLiteralExpression>();
      const imports = new Map<string, { from: string; name: string }>();
      for (const statement of source.file.statements) {
        if (ts.isVariableStatement(statement)) {
          for (const d of statement.declarationList.declarations) {
            if (!ts.isIdentifier(d.name) || !d.initializer) continue;
            const value = objectIn(d.initializer);
            if (value) objects.set(d.name.text, value);
            // `const black = Platform.OS === "ios" ? blackIOS : blackAndroid`: iOS's theme, as the design shows it.
            const chosen = platformChoice(d.initializer)?.ios;
            const picked = chosen && unwrapped(chosen);
            if (picked && ts.isIdentifier(picked))
              this.choices.set(`${source.rel}#${d.name.text}`, picked.text);
            const inPlace = picked && objectIn(picked);
            if (inPlace) objects.set(d.name.text, inPlace);
          }
        } else if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
          const from = statement.moduleSpecifier.text;
          const clause = statement.importClause;
          if (clause?.name) imports.set(clause.name.text, { from, name: "default" });
          const bindings = clause?.namedBindings;
          if (bindings && ts.isNamedImports(bindings))
            for (const e of bindings.elements)
              imports.set(e.name.text, { from, name: e.propertyName?.text ?? e.name.text });
        }
        const exported = defaultExport(statement);
        if (exported) {
          const inner = unwrapped(exported);
          this.defaultName.set(source, ts.isIdentifier(inner) ? inner.text : fileName(source));
        }
      }
      this.objects.set(source, objects);
      this.imports.set(source, imports);
    }
  }

  /** The object literal `name` holds in `source`, or that it imports from another file of the project. */
  object(
    source: JsSource,
    name: string,
    hops = 0,
  ): { object: ts.ObjectLiteralExpression; source: JsSource } | undefined {
    const own = this.objects.get(source)?.get(name);
    if (own) return { object: own, source };
    const chosen = this.choices.get(`${source.rel}#${name}`);
    if (chosen && hops < MAX_HOPS) return this.object(source, chosen, hops + 1);
    const target = this.imported(source, name);
    return target && hops < MAX_HOPS ? this.object(target.source, target.root, hops + 1) : undefined;
  }

  /** The file and root name a local name is imported from: `import appColors from "./palette"`. */
  imported(source: JsSource, name: string): { source: JsSource; root: string } | undefined {
    const binding = this.imports.get(source)?.get(name);
    const target = binding && this.moduleAt(binding.from, source);
    if (!binding || !target) return undefined;
    const root = binding.name === "default" ? this.defaultName.get(target) : binding.name;
    return root ? { source: target, root } : undefined;
  }

  private moduleAt(specifier: string, from: JsSource): JsSource | undefined {
    if (!specifier.startsWith(".")) return undefined;
    const base = path.posix.join(path.posix.dirname(from.rel), specifier);
    for (const ext of ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.js"]) {
      const found = this.byRel.get(base + ext);
      if (found) return found;
    }
    return undefined;
  }
}

const stringValue = (node: ts.Expression): string | undefined => {
  const inner = unwrapped(node);
  return ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner) ? inner.text : undefined;
};

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
function collectNamed(
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
        const spread_ = new Map<string, Entry[]>();
        for (const e of walk(target.object, at, target.source, hops + 1))
          spread_.set(under(e), [...(spread_.get(under(e)) ?? []), e]);
        for (const [key, list] of spread_) {
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
      if (!color && !aliasOf) {
        own.delete(key);
        continue;
      }
      const held = color
        ? { value: color, written: valueSpan(from, value) }
        : aliasOf
          ? { aliasOf, written: nodeSpan(from, value) }
          : { written: nodeSpan(from, value) };
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
  literalSpan(source, node) ?? nodeSpan(source, node);

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
function mostlyColors(entries: Valued[], leaves: Map<ts.ObjectLiteralExpression, number>): Valued[] {
  const colors = new Map<ts.ObjectLiteralExpression, number>();
  for (const e of entries) if (e.holder) colors.set(e.holder, (colors.get(e.holder) ?? 0) + 1);
  return entries.filter((e) => !e.holder || (colors.get(e.holder) ?? 0) * 2 > (leaves.get(e.holder) ?? 0));
}

/**
 * Each entry with a value, following aliases (`appBG: colors.productDark100`): in the entry's own file, then through
 * what it imports (`import appColors from "./palette"`), then by the path's end when only one colour has that end.
 * Aliases that reach no colour are dropped.
 */
function resolveAliases(entries: Entry[], modules: Modules): Valued[] {
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

/** Colours told apart only by a `light` and a `dark` object (`themes.light.surface`, `themes.dark.surface`, or
 * `lightTheme.surface` and `darkTheme.surface` in their own files) are one colour with both values; the rest stand as
 * they are, a second colour at the same path included. */
function pairModes(entries: Valued[]): NamedColor[] {
  const pairs = new Map<string, { light?: Valued; dark?: Valued }>();
  const alone: NamedColor[] = [];
  // A colour with its own two values, `SECONDARY_LABEL = { light: "…", dark: "…" }`, is named by its object.
  const own = new Map<string, { light?: Valued; dark?: Valued; path: string[] }>();
  const rest: Valued[] = [];
  for (const e of entries) {
    const mode = e.path.length > 1 ? (e.path[e.path.length - 1] ?? "").toLowerCase() : "";
    if (mode !== "light" && mode !== "dark") {
      rest.push(e);
      continue;
    }
    const key = `${e.source.rel}\0${e.path.slice(0, -1).join("\0")}`;
    const pair = own.get(key) ?? { path: e.path.slice(0, -1) };
    pair[mode] = e;
    own.set(key, pair);
  }
  for (const { light, dark, path: at } of own.values()) {
    const first = light ?? dark;
    if (!first) continue;
    alone.push({
      ...namedColor(first, light && dark),
      name: at[at.length - 1] ?? first.name,
      reference: renderPath(at),
    });
  }
  for (const e of rest) {
    const at = e.path.slice(0, -1).findIndex((part) => modeOf(part) !== undefined);
    const mode = at === -1 ? undefined : modeOf(e.path[at] ?? "");
    // `lightColors` pairs with `darkColors`, and `LightTheme` with `DarkTheme`, not with each other.
    const rest = (e.path[at] ?? "").toLowerCase().replace(mode ?? "", "*");
    const key = mode && [...e.path.slice(0, at), rest, ...e.path.slice(at + 1)].join("\0");
    const pair = key ? (pairs.get(key) ?? {}) : undefined;
    if (!mode || !key || !pair || pair[mode]) {
      alone.push(namedColor(e));
      continue;
    }
    pair[mode] = e;
    pairs.set(key, pair);
  }
  const paired = [...pairs.values()].flatMap(({ light, dark }) => {
    if (light) return [namedColor(light, dark)];
    return dark ? [namedColor(dark)] : [];
  });
  return [...paired, ...alone];
}

/** One colour per name and values: a theme reached two ways (`light.fontDefault`, `colors.light.fontDefault`) or
 * repeated (`text: "#fff"` in each card's colours) is one colour, at its first place. */
function once(colors: NamedColor[]): NamedColor[] {
  const seen = new Set<string>();
  return colors.filter((c) => {
    const key = `${c.name}|${c.light}|${c.dark ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface Known {
  /** Every colour's name, for crediting `theme.colors.surface` to `surface`. */
  names: Set<string>;
  /** Module-level colour constants by name, with the files declaring them, used by name alone
   * (`backgroundColor: brand`) in those files or ones importing them. */
  constants: Map<string, Set<string>>;
  /** Where the code names its colours, which aren't uses. */
  definitions: Set<ts.Node>;
  /** The names of the objects holding colours (`colors`, `palette`, `light`), lowercased. */
  holders: Set<string>;
}

/** Each use of a named colour, each colour written without a name, and each CSS colour name in a style. */
function collectUses(source: JsSource, known: Known, found: ColorFindings) {
  eachNode(source.file, (node) => {
    if (known.definitions.has(node)) return false;
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      !isInnerOfChain(node)
    ) {
      const parts = accessPath(node);
      const last = parts?.[parts.length - 1] ?? "";
      const name =
        parts && parts.length > 1 && /^\d+$/.test(last) ? `${parts[parts.length - 2]}-${last}` : last;
      // `theme.text` is the theme's colour; `styles.text` and `post.text` aren't.
      const themed = parts
        ?.slice(0, -1)
        .some((part) => THEME_WORD.test(part) || known.holders.has(part.toLowerCase()));
      if (parts && themed && known.names.has(name)) {
        found.references.push({ name, reference: renderPath(parts) });
        return false;
      }
    }
    if (ts.isIdentifier(node) && isConstantUse(node, source, known) && isValueUse(node) && !shadowed(node)) {
      found.references.push({ name: node.text, reference: node.text });
      return false;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const hex = colorOf(node.text);
      if (hex && !isDefinition(node)) found.literals.push({ hex, file: source.rel });
      else if (CSS_NAMES[node.text.toLowerCase()] && inStyleColor(node))
        found.system.push(node.text.toLowerCase());
      return false;
    }
    return true;
  });
}

/** Whether `node` is the left part of a longer chain (`theme` or `theme.colors` in `theme.colors.surface`). */
const isInnerOfChain = (node: ts.Node) =>
  (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) &&
  node.parent.expression === node;

/** An identifier read as a value: not a declaration's name, a property's name, or an import. */
function isValueUse(node: ts.Identifier): boolean {
  const { parent } = node;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isPropertyAccessExpression(parent)) && parent.name === node)
    return false;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isExportSpecifier(parent)) return false;
  if ((ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent)) && parent.name === node)
    return false;
  return !ts.isShorthandPropertyAssignment(parent) || parent.objectAssignmentInitializer === node;
}

function constantsByName(entries: Valued[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const e of entries.filter((x) => x.path.length === 1)) {
    const files = out.get(e.name) ?? new Set<string>();
    files.add(e.source.rel);
    out.set(e.name, files);
  }
  return out;
}

const importedNames = new WeakMap<JsSource, Set<string>>();

/** A colour constant's name read where it's the constant: in its own file, or one importing that name. */
function isConstantUse(node: ts.Identifier, source: JsSource, known: Known): boolean {
  const files = known.constants.get(node.text);
  if (!files) return false;
  if (files.has(source.rel)) return true;
  let names = importedNames.get(source);
  if (!names) {
    names = new Set(
      source.file.statements.flatMap((s) => {
        if (!ts.isImportDeclaration(s) || !s.importClause) return [];
        const bindings = s.importClause.namedBindings;
        return [
          ...(s.importClause.name ? [s.importClause.name.text] : []),
          ...(bindings && ts.isNamedImports(bindings) ? bindings.elements.map((e) => e.name.text) : []),
        ];
      }),
    );
    importedNames.set(source, names);
  }
  return names.has(node.text);
}

/** A module-level constant's own value, `const brand = "#3366e6" as const`, already a named colour. */
function isDefinition(node: ts.Node): boolean {
  let declaration = node.parent;
  while (
    ts.isParenthesizedExpression(declaration) ||
    ts.isAsExpression(declaration) ||
    ts.isSatisfiesExpression(declaration) ||
    ts.isTypeAssertionExpression(declaration)
  )
    declaration = declaration.parent;
  return (
    ts.isVariableDeclaration(declaration) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    ts.isVariableStatement(declaration.parent.parent) &&
    ts.isSourceFile(declaration.parent.parent.parent)
  );
}

/** A string set as a style's colour: `{ color: "white" }` or `<Icon color="white" />`. */
function inStyleColor(node: ts.Node): boolean {
  const { parent } = node;
  if (ts.isPropertyAssignment(parent)) return STYLE_COLOR.has(propertyName(parent.name) ?? "");
  if (ts.isJsxAttribute(parent)) {
    const name = parent.name.getText();
    return /colou?r$/i.test(name) || STYLE_COLOR.has(name);
  }
  return false;
}
