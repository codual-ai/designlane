/** The font sizes a React Native app names on their own (`variables.fontSizeLarge: 17`, `FONT_SIZES.small: 12`), as
 * text styles of a size alone. */

import ts from "typescript";
import { COMPUTED } from "../scan/type-scale.js";
import type { TypeStyle, ValueLocation } from "../scan/types.js";
import {
  accessPath,
  defaultExport,
  eachNode,
  fileName,
  type JsSource,
  literalSpan,
  objectIn,
  propertyName,
  renderPath,
  shadowed,
  unwrapped,
} from "./js-sources.js";
import { literalNode, literalOf } from "./rn-values.js";

/** `fontSizeLarge`, `headerFontSize`, `FONT_SIZE_SMALL`; not a style's own `fontSize`. */
const SIZE_NAME = /font_?size./i;
const SIZE_END = /[a-z]FontSize$|_FONT_SIZE$/;
/** A group of sizes: `fontSizes: { small: 12 }`, `FONT_SIZE.small`. */
const SIZE_GROUP = /^font_?sizes?$/i;
/** Names for what goes with a size, not the size: `fontSizeNormalHeight`, `fontSizeToWidthRatio`. */
const NOT_SIZE = /height|ratio|scale|multiplier|width|spacing/i;

interface Found {
  path: string[];
  size: number;
  location?: ValueLocation;
}

export function namedFontSizes(sources: JsSource[]): TypeStyle[] {
  const sizes = new Map<string, Found>();
  for (const source of sources)
    for (const found of sizesIn(source)) {
      const key = found.path.join("\0");
      if (!sizes.has(key)) sizes.set(key, found);
    }
  const roots = new Set([...sizes.values()].map((s) => s.path[0] ?? ""));
  const deepest = Math.max(0, ...[...sizes.values()].map((s) => s.path.length));
  const uses = new Map<string, number>();
  for (const source of sources)
    eachNode(source.file, (node) => {
      const parts = chainRead(node, roots);
      // Each start of the chain: `variables.fontSizeLarge.toFixed` reads `variables.fontSizeLarge`.
      for (let end = 1; parts && end <= Math.min(parts.length, deepest); end++) {
        const key = parts.slice(0, end).join("\0");
        if (sizes.has(key)) uses.set(key, (uses.get(key) ?? 0) + 1);
      }
      return true;
    });
  return [...sizes].map(([key, { path, size, location }]) => ({
    name: path.at(-1) ?? "",
    kind: "app",
    family: "",
    size,
    weight: COMPUTED,
    reference: renderPath(path),
    uses: uses.get(key) ?? 0,
    ...(location && { locations: { fontSize: location } }),
  }));
}

const isAccess = (node: ts.Node): node is ts.PropertyAccessExpression | ts.ElementAccessExpression =>
  ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);

/** The whole chain a read starts with a name in `roots` (`variables.fontSizeLarge`, `FONT_SIZE_SMALL`), taken once at
 * its outermost node; not a name being declared, a property's own name, or a local name of the same spelling. */
function chainRead(node: ts.Node, roots: ReadonlySet<string>): string[] | undefined {
  const parent = node.parent;
  if (parent && isAccess(parent) && parent.expression === node) return undefined;
  if (!isAccess(node) && !ts.isIdentifier(node)) return undefined;
  let root: ts.Expression = node;
  while (isAccess(root)) root = root.expression;
  if (!ts.isIdentifier(root) || !roots.has(root.text) || isDeclaredName(root) || shadowed(root))
    return undefined;
  return accessPath(node);
}

function isDeclaredName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent)) return true;
  if (ts.isNamespaceImport(parent)) return true;
  return (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isBindingElement(parent)) &&
    parent.name === node
  );
}

const isSizeName = (name: string) => (SIZE_NAME.test(name) || SIZE_END.test(name)) && !NOT_SIZE.test(name);

/** The sizes a file's exported objects and constants hold, by their paths; a constant the file keeps to itself is one
 * screen's detail, not the app's. */
function sizesIn(source: JsSource): Found[] {
  const found: Found[] = [];
  const objects: { object: ts.ObjectLiteralExpression; path: string[] }[] = [];
  const take = (value: ts.Expression, path: string[]) => {
    const object = objectIn(value);
    if (object) objects.push({ object, path });
    else if (isSize(path)) {
      const written = unwrapped(value);
      const size = literalOf(written);
      const location = literalSpan(source, literalNode(written));
      if (typeof size === "number" && size > 0) found.push({ path, size, ...(location && { location }) });
    }
  };
  for (const statement of source.file.statements) {
    const exported = defaultExport(statement);
    if (exported) take(exported, [fileName(source)]);
    if (!ts.isVariableStatement(statement) || !isExported(statement)) continue;
    for (const d of statement.declarationList.declarations)
      if (ts.isIdentifier(d.name) && d.initializer) take(d.initializer, [d.name.text]);
  }
  for (let next = objects.pop(); next; next = objects.pop())
    for (const property of next.object.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const key = propertyName(property.name);
      if (key !== undefined) take(property.initializer, [...next.path, key]);
    }
  return found;
}

const isExported = (statement: ts.VariableStatement) =>
  statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;

/** A path naming a size: its own name says so, or the group holding it does (`fontSizes.small`). */
function isSize(path: string[]): boolean {
  const name = path.at(-1) ?? "";
  if (isSizeName(name)) return true;
  return path.length > 1 && SIZE_GROUP.test(path.at(-2) ?? "") && !NOT_SIZE.test(name);
}
