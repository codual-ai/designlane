/** A React Native app's JavaScript and TypeScript files, each parsed once by TypeScript's own parser. */

import path from "node:path";
import ts from "typescript";
import { isTestPath } from "../scan/test-paths.js";
import type { CodeSpan, ValueLocation } from "../scan/types.js";
import type { ScanContext } from "./plugin.js";
import { valueAt } from "./value-locations.js";

export interface JsSource {
  rel: string;
  text: string;
  /** The parsed file: syntax only, nothing type-checked. */
  file: ts.SourceFile;
  /** Imports from `react-native` (or a package built on it, `react-native-web`). */
  reactNative: boolean;
}

/** `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs` and `.cjs`; type declarations (`.d.ts`) hold no values. */
const SCRIPT = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const DECLARATIONS = /\.d\.[cm]?ts$/;
/** Stories and generated or bundled output aren't the app's own code. */
const NOT_APP = /(?:\.stories\.[jt]sx?$|(?:^|\/)(?:dist|build|coverage|vendor|__generated__)\/|\.min\.js$)/;
const RN_IMPORT = /^react-native(?:-web)?$/;

/** Every non-test script file, read and parsed once. */
export async function jsSources(ctx: ScanContext): Promise<JsSource[]> {
  const out: JsSource[] = [];
  for (const f of ctx.files) {
    if (!isScript(f.rel) || isTestPath(f.rel)) continue;
    const text = await ctx.read(f);
    if (text) out.push(jsSource(f.rel, text));
  }
  return out;
}

/** One script's text, parsed as the readers read it. */
export function jsSource(rel: string, text: string): JsSource {
  const file = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, scriptKind(rel));
  return { rel, text, file, reactNative: importsReactNative(file) };
}

/** Whether `rel` is a script the readers read: not a declaration file, a story, or generated or bundled output. */
export const isScript = (rel: string) => SCRIPT.test(rel) && !DECLARATIONS.test(rel) && !NOT_APP.test(rel);

/** JSX is allowed in every `.js` file, as React Native's own tooling allows it. */
function scriptKind(rel: string): ts.ScriptKind {
  if (rel.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (/\.[cm]?ts$/.test(rel)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JSX;
}

function importsReactNative(file: ts.SourceFile): boolean {
  return file.statements.some(
    (s) =>
      ts.isImportDeclaration(s) &&
      ts.isStringLiteral(s.moduleSpecifier) &&
      RN_IMPORT.test(s.moduleSpecifier.text),
  );
}

/** Where `node` is written in `source`, from its first token, leading comments left out. */
export const nodeSpan = (source: JsSource, node: ts.Node): CodeSpan => ({
  file: source.rel,
  line: lineOf(node),
  start: node.getStart(),
  end: node.getEnd(),
});

/** Where a literal's value is written: a string's text without its quotes, a number as it is; none for anything
 * else, a template with substitutions (`\`Brand Neue, ${FALLBACK}\``) included, whose text is only part of it. */
export function literalLocation(source: JsSource, node: ts.Node): ValueLocation | undefined {
  const span = nodeSpan(source, node);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return valueAt({ ...span, start: span.start + 1, end: span.end - 1 }, "literal");
  const number =
    ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken ? node.operand : node;
  return ts.isNumericLiteral(number) ? valueAt(span, "literal") : undefined;
}

/** The text of a string written as it is, `"#fff"` or `\`#fff\``, past parentheses and casts. */
export function stringValue(node: ts.Expression): string | undefined {
  const inner = unwrapped(node);
  return ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner) ? inner.text : undefined;
}

/** The 1-based line `node` starts on. */
export const lineOf = (node: ts.Node) =>
  node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;

/** `node` without the wrappers that don't change its value: `( … )`, `… as const`, `… satisfies T`, `x!`. */
export function unwrapped(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** A property's name as written (`surface`, `"surface-dark"`, `200`), or undefined when it's computed. */
export function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name))
    return name.text;
  return undefined;
}

/** `a.b.c` as written, for a chain of names only (`theme.colors.surface`); undefined for calls or `[…]` in it. */
export function dottedName(node: ts.Expression): string | undefined {
  const inner = unwrapped(node);
  if (ts.isIdentifier(inner)) return inner.text;
  if (ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.name)) {
    const left = dottedName(inner.expression);
    return left === undefined ? undefined : `${left}.${inner.name.text}`;
  }
  return undefined;
}

/** The names a chain reaches through, with static `[…]` too: `colors.blue[500]` is `colors`, `blue`, `500`. */
export function accessPath(node: ts.Expression): string[] | undefined {
  const inner = unwrapped(node);
  if (ts.isIdentifier(inner)) return [inner.text];
  if (ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.name)) {
    const left = accessPath(inner.expression);
    return left && [...left, inner.name.text];
  }
  if (ts.isElementAccessExpression(inner)) {
    const key = unwrapped(inner.argumentExpression);
    const part =
      ts.isStringLiteral(key) || ts.isNumericLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)
        ? key.text
        : undefined;
    const left = part === undefined ? undefined : accessPath(inner.expression);
    return left && part !== undefined ? [...left, part] : undefined;
  }
  return undefined;
}

/** A path as code reaches it: `colors.blue[500]`, `colors["brand-blue"]`. */
export function renderPath(parts: string[]): string {
  return parts
    .map((part, i) => {
      if (i === 0) return part;
      if (/^[A-Za-z_$][\w$]*$/.test(part)) return `.${part}`;
      return /^\d+$/.test(part) ? `[${part}]` : `[${JSON.stringify(part)}]`;
    })
    .join("");
}

/** Visits `root` and the nodes under it, depth first in source order, without recursion (deeply nested code, a long
 * `"a" + "b" + …`, would overflow the stack); `visit` returns false to skip a node's children. */
export function eachNode(root: ts.Node, visit: (node: ts.Node) => boolean): void {
  const stack: ts.Node[] = [root];
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (!visit(node)) continue;
    const children: ts.Node[] = [];
    ts.forEachChild(node, (child) => {
      children.push(child);
    });
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i] as ts.Node);
  }
}

/** The name a file's default export is imported by: the file's, or its folder's for an `index` file. */
export const fileName = (source: JsSource) => {
  const base = path.basename(source.rel).replace(/\.[^.]+$/, "");
  const folder = path.dirname(source.rel);
  return base === "index" && folder !== "." ? path.basename(folder) : base;
};

/** `export default x` or `module.exports = x`: the `x`. */
export function defaultExport(statement: ts.Statement): ts.Expression | undefined {
  if (ts.isExportAssignment(statement)) return statement.expression;
  if (
    ts.isExpressionStatement(statement) &&
    ts.isBinaryExpression(statement.expression) &&
    statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    renderPath(accessPath(statement.expression.left) ?? []) === "module.exports"
  ) {
    return statement.expression.right;
  }
  return undefined;
}

/** The object literal a declaration holds, also through `Object.freeze(…)`; never a style sheet's. */
export function objectIn(node: ts.Expression): ts.ObjectLiteralExpression | undefined {
  const value = unwrapped(node);
  if (ts.isObjectLiteralExpression(value)) return value;
  if (ts.isCallExpression(value) && renderPath(accessPath(value.expression) ?? []) === "Object.freeze") {
    const first = value.arguments[0];
    return first ? objectIn(first) : undefined;
  }
  return undefined;
}

/** The branches of a choice the code makes by platform, with the one iOS takes, which is what a design shows:
 * `Platform.select({ ios: a, android: b })` (`native`'s or `default`'s when it has no `ios`), and `Platform.OS === "ios" ? a : b`
 * (any platform named, `===` or `!==`). Missing for any other expression. */
export function platformChoice(
  node: ts.Expression,
): { ios: ts.Expression; all: ts.Expression[] } | undefined {
  const value = unwrapped(node);
  if (ts.isCallExpression(value) && dottedName(value.expression) === "Platform.select") {
    const options = value.arguments[0] && unwrapped(value.arguments[0]);
    if (!options || !ts.isObjectLiteralExpression(options)) return undefined;
    // `{ ios: a }` and `{ ios }` alike; iOS takes `ios`, else `native`, else `default`, as React Native does.
    const branches = new Map<string, ts.Expression>();
    for (const p of options.properties) {
      if (ts.isShorthandPropertyAssignment(p)) branches.set(p.name.text, p.name);
      else if (ts.isPropertyAssignment(p)) {
        const key = propertyName(p.name);
        if (key !== undefined) branches.set(key, p.initializer);
      }
    }
    const ios = branches.get("ios") ?? branches.get("native") ?? branches.get("default");
    return ios ? { ios, all: [...branches.values()] } : undefined;
  }
  if (!ts.isConditionalExpression(value)) return undefined;
  const test = unwrapped(value.condition);
  if (!ts.isBinaryExpression(test)) return undefined;
  const sides = [unwrapped(test.left), unwrapped(test.right)];
  const named = sides.find((s) => ts.isStringLiteral(s));
  if (!named || !ts.isStringLiteral(named) || !sides.some((s) => dottedName(s) === "Platform.OS"))
    return undefined;
  const op = test.operatorToken.kind;
  const equal = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
  const unequal =
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
  if (!equal && !unequal) return undefined;
  const whenIos = (named.text === "ios") === equal ? value.whenTrue : value.whenFalse;
  return { ios: whenIos, all: [value.whenTrue, value.whenFalse] };
}

/** A style's `Platform.select({ … })`; a ternary on `Platform.OS` isn't read in styles yet. */
const selectChoice = (node: ts.Expression) => {
  const call = unwrapped(node);
  return ts.isCallExpression(call) && dottedName(call.expression) === "Platform.select"
    ? platformChoice(call)
    : undefined;
};

/** Every branch object of `Platform.select({ ios: { … }, android: { … } })`. */
export function platformBranches(node: ts.Expression): ts.ObjectLiteralExpression[] {
  return (selectChoice(node)?.all ?? []).flatMap((b) => {
    const value = unwrapped(b);
    return ts.isObjectLiteralExpression(value) ? [value] : [];
  });
}

/** The branch object of `Platform.select({ … })` that iOS takes. */
export function platformBranch(node: ts.Expression): ts.ObjectLiteralExpression | undefined {
  const choice = selectChoice(node);
  const value = choice && unwrapped(choice.ios);
  return value && ts.isObjectLiteralExpression(value) ? value : undefined;
}

/** Whether a name is a local one where it's read, a parameter or a variable of an enclosing function or block, rather
 * than the module's constant: `function Button({ brand }) { return brand; }`. */
export function shadowed(node: ts.Identifier): boolean {
  for (let at: ts.Node = node.parent; !ts.isSourceFile(at); at = at.parent) {
    if (ts.isFunctionLike(at) && at.parameters.some((p) => bindingNames(p.name).includes(node.text)))
      return true;
    // `for (const brand of list)`, `catch (brand)`.
    if (
      (ts.isForOfStatement(at) || ts.isForInStatement(at) || ts.isForStatement(at)) &&
      at.initializer &&
      ts.isVariableDeclarationList(at.initializer) &&
      at.initializer.declarations.some((d) => bindingNames(d.name).includes(node.text))
    )
      return true;
    if (
      ts.isCatchClause(at) &&
      at.variableDeclaration &&
      bindingNames(at.variableDeclaration.name).includes(node.text)
    )
      return true;
    if (ts.isBlock(at) || ts.isCaseClause(at)) {
      const statements = ts.isBlock(at) ? at.statements : at.statements;
      for (const s of statements)
        if (
          ts.isVariableStatement(s) &&
          s.declarationList.declarations.some((d) => bindingNames(d.name).includes(node.text))
        )
          return true;
    }
  }
  return false;
}

/** The names a binding declares: `brand`, or each name in `{ brand, tint: [a] }`. */
export function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : bindingNames(e.name)));
}
