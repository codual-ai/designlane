/**
 * Colours from Tailwind (NativeWind, Uniwind): those a `tailwind.config.js` or a CSS `@theme` names, and the class
 * names that use them (`bg-primary-500`, `dark:text-muted`).
 */

import path from "node:path";
import ts from "typescript";
import type { ColorFindings, NamedColor } from "../scan/palette.js";
import { appFirst } from "../scan/targets.js";
import type { ValueLocation } from "../scan/types.js";
import { colorOf } from "./css-color.js";
import {
  accessPath,
  eachNode,
  type JsSource,
  lineOf,
  literalSpan,
  propertyName,
  renderPath,
  unwrapped,
} from "./js-sources.js";
import type { ScanContext } from "./plugin.js";
import { locator } from "./source-text.js";
import { valueAt } from "./value-locations.js";

export const TAILWIND_CONFIG = /(?:^|\/)tailwind\.config\.[cm]?[jt]s$/;
const CSS = /\.css$/;
/** A colour variable in a CSS `@theme`: `--color-charcoal-500: #7d7d7d;`. */
const CSS_COLOR = /--color-([\w-]+)\s*:\s*([^;]+);/g;
/** A block whose variables are the dark scheme's. */
const DARK_BLOCK =
  /(?:@media[^{]*prefers-color-scheme:\s*dark[^{]*|\.dark\b[^{]*|\[data-theme=["']?dark["']?\][^{]*|@variant\s+dark[^{]*)\{/g;
/** Utility prefixes that take a colour: `bg-`, `text-`, `border-t-` and the rest. */
const COLOR_UTILITY =
  /^(?:bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|fill|stroke|from|via|to|divide|outline|decoration|placeholder|shadow|accent|caret)-(.+)$/;
/** How many variables, requires and imports a config value is followed through. */
const MAX_HOPS = 8;

export interface TailwindFindings extends ColorFindings {
  /** The configs and the modules they read colours from, whose colours are Tailwind's names, not objects' paths. */
  files: Set<string>;
  /** The app uses Tailwind: it has a config, or a stylesheet bringing Tailwind in. */
  used: boolean;
  /** The families a CSS `@theme` names, by class name: `--font-inter: "Inter"` is `font-inter`. */
  fonts: Record<string, string>;
}

/** Where class names are written: a `className`-like prop, or a class helper's arguments (`cn(…)`, `tw\`…\``). */
const CLASS_PROP = /^(?:className|class|tw|\w+Class(?:Name)?)$/;
const CLASS_HELPER = /^(?:cn|cx|clsx|classnames|classNames|twMerge|twJoin|tw|cva|tv)$/;
/** Every string under a node: quoted, or a template's text parts. */
function stringsIn(node: ts.Node): string[] {
  const out: string[] = [];
  eachNode(node, (inner) => {
    if (
      ts.isStringLiteral(inner) ||
      ts.isNoSubstitutionTemplateLiteral(inner) ||
      ts.isTemplateHead(inner) ||
      ts.isTemplateMiddle(inner) ||
      ts.isTemplateTail(inner)
    )
      out.push(inner.text);
    return true;
  });
  return out;
}

/** A word only a class name is: `p-4`, `md:text-lg`, `bg-primary/50`, `flex`. */
const CLASS_WORD = /^!?-?(?:[\w-]+:)*[a-z][\w-]*(?:-(?:[\w.%]+|\[[^\]\s]+\]))+(?:\/[\w.]+)?!?$/;
const BARE_CLASS =
  /^(?:flex|grid|hidden|block|inline|contents|absolute|relative|italic|underline|uppercase|lowercase|capitalize|truncate|grow|shrink|rounded|border|shadow)$/;

/** A string of nothing but class names, at least one with a value (`text-lg`, not just `flex`). */
export function looksLikeClasses(text: string): boolean {
  const words = text.trim().split(/\s+/);
  return (
    words.some((w) => CLASS_WORD.test(w)) && words.every((w) => CLASS_WORD.test(w) || BARE_CLASS.test(w))
  );
}

/** The class names a file writes, one list per place: a `className`-like prop or property, or a class helper's
 * arguments (`cn("text-lg", isBold && "font-bold")`, `tw\`…\``), with every string in it (quoted, or a template's
 * text parts). Strings elsewhere (a label, an id) aren't classes, however they read. */
export function eachClassList(source: JsSource, visit: (node: ts.Node, text: string) => void): void {
  eachNode(source.file, (node) => {
    const holds =
      (ts.isJsxAttribute(node) && CLASS_PROP.test(node.name.getText()) && node.initializer) ||
      (ts.isPropertyAssignment(node) && CLASS_PROP.test(propertyName(node.name) ?? "")) ||
      (ts.isCallExpression(node) && CLASS_HELPER.test(accessPath(node.expression)?.at(-1) ?? "")) ||
      (ts.isTaggedTemplateExpression(node) && CLASS_HELPER.test(accessPath(node.tag)?.at(-1) ?? ""));
    if (!holds) {
      // A string held elsewhere reading as nothing but class names (`const heading = "mt-4 text-darkGray"`, a
      // ternary's branches) is one too; a sentence (`"Corners are rounded and m-2 looks nice"`) isn't.
      if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        // A prop that isn't for classes (`testID="text-lg"`) holds something else.
        !ts.isJsxAttribute(node.parent) &&
        looksLikeClasses(node.text)
      )
        visit(node, node.text);
      return true;
    }
    // A ternary's branches are classes one instead of the other, each with the rest of the list.
    const texts: string[] = [];
    const branches: ts.Expression[] = [];
    eachNode(node, (inner) => {
      if (ts.isConditionalExpression(inner)) {
        branches.push(inner.whenTrue, inner.whenFalse);
        return false;
      }
      if (
        ts.isStringLiteral(inner) ||
        ts.isNoSubstitutionTemplateLiteral(inner) ||
        ts.isTemplateHead(inner) ||
        ts.isTemplateMiddle(inner) ||
        ts.isTemplateTail(inner)
      )
        texts.push(inner.text);
      return true;
    });
    const base = texts.join(" ");
    if (branches.length === 0) visit(node, base);
    for (const branch of branches) visit(branch, `${base} ${stringsIn(branch).join(" ")}`);
    return false;
  });
}

/** The colours Tailwind names in the project, with the class names using them; empty for an app without Tailwind. */
export async function tailwindColors(ctx: ScanContext, sources: JsSource[]): Promise<TailwindFindings> {
  const files = new Set<string>();
  const named = [...configColors(sources, files), ...(await cssColors(ctx))];
  const css = await readCss(ctx);
  const used = files.size > 0 || css.imports;
  const found: TailwindFindings = {
    named,
    references: [],
    literals: [],
    system: [],
    files,
    used,
    fonts: css.fonts,
  };
  if (named.length === 0) return found;
  const names = new Set(named.map((c) => c.name));
  for (const source of sources) {
    eachClassList(source, (_, text) => {
      for (const name of classColors(text))
        if (names.has(name)) found.references.push({ name, reference: name });
    });
  }
  return found;
}

/** The colour names a string's class names use: `dark:bg-primary-500/50` uses `primary-500`. */
function classColors(text: string): string[] {
  return text.split(/\s+/).flatMap((word) => {
    const utility = word.slice(word.lastIndexOf(":") + 1).replace(/^!|!$/g, "");
    const name = utility.match(COLOR_UTILITY)?.[1]?.replace(/\/[\w.[\]%]+$/, "");
    return name ? [name] : [];
  });
}

/** A value and the file it's written in, which its names are looked up in. */
export interface Located {
  node: ts.Expression;
  source: JsSource;
}

/** The colours `theme.colors` and `theme.extend.colors` name in a Tailwind config, nested names joined by `-`
 * (`charcoal: { 500 }` is `charcoal-500`, `DEFAULT` is the group's own), also from modules the config requires. */
function configColors(sources: JsSource[], files: Set<string>): NamedColor[] {
  const out: NamedColor[] = [];
  for (const { config, groups, resolver } of themeGroups(sources, "colors")) {
    files.add(config.rel);
    for (const group of groups) flatten(group, [], resolver, files, out, 0);
  }
  return out;
}

/** For each Tailwind config, the values its `theme` and `theme.extend` give `key` (`colors`, `fontSize`). */
export function themeGroups(sources: JsSource[], key: string) {
  const resolver = new Resolver(sources);
  return sources
    .filter((s) => TAILWIND_CONFIG.test(s.rel))
    .map((config) => {
      const root = resolver.exported(config);
      const theme = root && resolver.member(root, "theme");
      const extend = theme && resolver.member(theme, "extend");
      const groups = [theme && resolver.member(theme, key), extend && resolver.member(extend, key)].filter(
        (g): g is Located => g !== undefined,
      );
      return { config, groups, resolver };
    });
}

function flatten(
  at: Located,
  names: string[],
  resolver: Resolver,
  files: Set<string>,
  out: NamedColor[],
  hops: number,
) {
  const object = hops > MAX_HOPS ? undefined : resolver.object(at);
  if (!object) return;
  files.add(object.source.rel);
  for (const property of object.node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = propertyName(property.name);
    if (key === undefined) continue;
    const parts = key === "DEFAULT" ? names : [...names, key];
    const text = stringValue(property.initializer);
    const light = text === undefined ? undefined : colorOf(text, true);
    const written = literalSpan(object.source, unwrapped(property.initializer));
    const name = parts.join("-");
    if (light && name) {
      out.push({
        name,
        light,
        source: object.source.rel,
        reference: name,
        line: lineOf(property),
        kind: "code",
        ...(written && { locations: { light: written } }),
      });
      continue;
    }
    // A nested group, also one held elsewhere: `brand: require("./brand")`.
    flatten({ node: property.initializer, source: object.source }, parts, resolver, files, out, hops + 1);
  }
}

const stringValue = (node: ts.Expression): string | undefined => {
  const inner = unwrapped(node);
  return ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner) ? inner.text : undefined;
};

/** Follows a config's values through module-level variables, `require(…)` and default imports of local modules. */
export class Resolver {
  private readonly byRel: Map<string, JsSource>;

  constructor(sources: JsSource[]) {
    this.byRel = new Map(sources.map((s) => [s.rel, s]));
  }

  /** What a module exports: `module.exports = …` or `export default …`. */
  exported(source: JsSource, hops = 0): Located | undefined {
    for (const statement of source.file.statements) {
      if (ts.isExportAssignment(statement)) return this.value({ node: statement.expression, source }, hops);
      if (
        ts.isExpressionStatement(statement) &&
        ts.isBinaryExpression(statement.expression) &&
        statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        renderPath(accessPath(statement.expression.left) ?? []) === "module.exports"
      ) {
        return this.value({ node: statement.expression.right, source }, hops);
      }
    }
    return undefined;
  }

  /** `name`'s value in an object literal, also written as a variable of that name (`{ theme: { colors } }`). */
  member(at: Located, name: string): Located | undefined {
    const object = this.object(at);
    if (!object) return undefined;
    for (const property of object.node.properties) {
      if (ts.isPropertyAssignment(property) && propertyName(property.name) === name)
        return { node: property.initializer, source: object.source };
      if (ts.isShorthandPropertyAssignment(property) && property.name.text === name)
        return { node: property.name, source: object.source };
    }
    return undefined;
  }

  /** The object literal a value is, wherever it's written. */
  object(at: Located): { node: ts.ObjectLiteralExpression; source: JsSource } | undefined {
    const found = this.value(at, 0);
    const node = found && unwrapped(found.node);
    return found && node && ts.isObjectLiteralExpression(node) ? { node, source: found.source } : undefined;
  }

  /** A value's own expression, past variables, requires and imports; undefined past `MAX_HOPS`, so modules that
   * require each other end. */
  private value({ node, source }: Located, hops: number): Located | undefined {
    if (hops > MAX_HOPS) return undefined;
    const value = unwrapped(node);
    if (ts.isCallExpression(value) && renderPath(accessPath(value.expression) ?? []) === "require") {
      const target = this.moduleAt(value.arguments[0], source);
      return target && this.exported(target, hops + 1);
    }
    if (!ts.isIdentifier(value)) return { node: value, source };
    for (const statement of source.file.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const d of statement.declarationList.declarations)
          if (ts.isIdentifier(d.name) && d.name.text === value.text && d.initializer)
            return this.value({ node: d.initializer, source }, hops + 1);
      }
      if (
        ts.isImportDeclaration(statement) &&
        statement.importClause?.name?.text === value.text &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        const target = this.moduleAt(statement.moduleSpecifier, source);
        return target && this.exported(target, hops + 1);
      }
    }
    return undefined;
  }

  /** The project's module a relative path names, trying the script extensions and `index`. */
  private moduleAt(specifier: ts.Expression | undefined, from: JsSource): JsSource | undefined {
    if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith(".")) return undefined;
    const base = path.posix.join(path.posix.dirname(from.rel), specifier.text);
    for (const ext of ["", ".js", ".ts", ".cjs", ".mjs", ".jsx", ".tsx", "/index.js", "/index.ts"]) {
      const found = this.byRel.get(base + ext);
      if (found) return found;
    }
    return undefined;
  }
}

/** A font family in a CSS `@theme`: `--font-inter: "Inter", sans-serif;`, or v3-style `--font-family-sans`. */
const CSS_FONT = /--font-(?:family-)?([\w-]+)\s*:\s*([^;]+);/g;

/** Whether a stylesheet brings Tailwind in (`@import "tailwindcss"`, `@tailwind base`), and the families its
 * `@theme` names. */
async function readCss(ctx: ScanContext): Promise<{ imports: boolean; fonts: Record<string, string> }> {
  let imports = false;
  const fonts: Record<string, string> = {};
  for (const file of appFirst(ctx.files, (f) => f.rel).filter((f) => CSS.test(f.rel))) {
    const text = (await ctx.read(file))?.replace(/\/\*[\s\S]*?\*\//g, "");
    if (!text) continue;
    if (/@import\s+["']tailwindcss|@tailwind\s/.test(text)) imports = true;
    for (const m of text.matchAll(CSS_FONT)) if (m[1] && m[2] && !(m[1] in fonts)) fonts[m[1]] = m[2].trim();
  }
  return { imports, fonts };
}

/** The colours CSS `@theme` blocks name, `--color-*`, with the values a dark block gives them; commented-out
 * declarations aren't read. */
async function cssColors(ctx: ScanContext): Promise<NamedColor[]> {
  const out = new Map<string, NamedColor>();
  const darkValues = new Map<string, { value: string; location: ValueLocation }>();
  for (const file of appFirst(ctx.files, (f) => f.rel).filter((f) => CSS.test(f.rel))) {
    const raw = await ctx.read(file);
    if (!raw?.includes("--color-")) continue;
    // Comments blanked to spaces, keeping every offset and line where it was.
    const text = raw.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
    const dark = darkSpans(text);
    const span = locator(file.rel, text);
    for (const m of text.matchAll(CSS_COLOR)) {
      const [name, written] = [m[1] ?? "", m[2] ?? ""];
      const value = colorOf(written, true);
      const at = m.index ?? 0;
      if (!value) continue;
      // The value runs from after the `:` and its spaces to the `;`, less the spaces before it.
      const start = at + m[0].length - 1 - written.length;
      const location = valueAt(span(start, start + written.trimEnd().length), "literal");
      if (dark.some(([open, close]) => at > open && at < close)) {
        if (!darkValues.has(name)) darkValues.set(name, { value, location });
        continue;
      }
      if (!out.has(name))
        out.set(name, {
          name,
          light: value,
          source: file.rel,
          reference: name,
          line: location.line,
          kind: "code",
          locations: { light: location },
        });
    }
  }
  return [...out.values()].map((c) => {
    const dark = darkValues.get(c.name);
    if (!dark) return c;
    return {
      ...c,
      ...(dark.value !== c.light && { dark: dark.value }),
      locations: { ...c.locations, dark: dark.location },
    };
  });
}

/** The spans of the blocks in a stylesheet that hold the dark scheme's values. */
function darkSpans(text: string): [number, number][] {
  return [...text.matchAll(DARK_BLOCK)].map((m) => {
    const open = (m.index ?? 0) + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) return [open, i] as [number, number];
    }
    return [open, text.length] as [number, number];
  });
}
