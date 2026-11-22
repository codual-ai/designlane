/**
 * The elements a React Native component returns, read from its JSX: each element with its children, `a && <X/>` and
 * `a ? <X/> : <Y/>` as conditionals, `list.map(…)` and a list's `renderItem` as repeats, and a `View`'s direction from
 * its style.
 */

import ts from "typescript";
import { eachNode, type JsSource, propertyName, stringValue, unwrapped } from "../frameworks/js-sources.js";
import { componentFunction } from "../frameworks/rn-views.js";
import type { Element } from "./layout-tree.js";

/** How deep JSX is read; JSX nested deeper has no layout, so hostile code can't overflow the stack. */
const MAX_DEPTH = 100;
/** Props that render each item of a list. */
const RENDER_ITEM = new Set(["renderItem"]);
const ROW = /^row(?:-reverse)?$/;
const ROW_CLASS = /(?:^|\s)flex-row(?:-reverse)?(?:\s|$)/;
const LOOPS = new Set(["map", "flatMap"]);
/** The pragma marking a file Flow checks, in a comment before its code. */
const FLOW = /@flow\b/;
/** Lists that lay out their items in columns when given `numColumns`. */
const LISTS = /(?:^|\.)(?:FlatList|FlashList)$/;

/** The function a component's declaration is: one declared, held by a variable, a class's `render`, or itself. */
function functionOf(node: ts.Node): ts.SignatureDeclaration | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node))
    return node;
  if (ts.isVariableDeclaration(node)) return node.initializer && componentFunction(node.initializer);
  if (ts.isClassDeclaration(node))
    return node.members.find(
      (m): m is ts.MethodDeclaration =>
        ts.isMethodDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === "render",
    );
  return undefined;
}

/** What a function returns: its expression body, or each `return`'s value, not those of functions inside it. */
function returned(fn: ts.SignatureDeclaration): ts.Expression[] {
  const body = "body" in fn ? (fn.body as ts.ConciseBody | undefined) : undefined;
  if (!body) return [];
  if (!ts.isBlock(body)) return [body];
  const out: ts.Expression[] = [];
  eachNode(body, (node) => {
    if (node !== body && ts.isFunctionLike(node)) return false;
    if (ts.isReturnStatement(node) && node.expression) out.push(node.expression);
    return true;
  });
  return out;
}

/** The node declared from `start` to `end` in `source`, as the catalog's reader finds a component. */
function declared(source: JsSource, start: number, end: number): ts.Node | undefined {
  let found: ts.Node | undefined;
  eachNode(source.file, (node) => {
    if (found || node.getEnd() < start || node.pos > end) return false;
    if (node.getStart() === start && node.getEnd() === end && functionOf(node)) found = node;
    return !found;
  });
  return found;
}

/** The errors TypeScript's parser found in a file. Its parser keeps them on the file without listing them in its types;
 * the nodes' error flags stand in where it doesn't. */
type Parsed = ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] };

/** Where TypeScript's parser found errors in `node`'s code, its end included (a `}` missing at the end of the file):
 * an unclosed tag or bracket, a stray token. */
function errorsIn(file: Parsed, node: ts.Node): number[] {
  const start = node.getStart(file);
  const end = node.getEnd();
  if (file.parseDiagnostics)
    return file.parseDiagnostics.flatMap((d) =>
      d.start !== undefined && d.start >= start && d.start <= end ? [d.start] : [],
    );
  const out: number[] = [];
  eachNode(node, (n) => {
    if (n.flags & ts.NodeFlags.ThisNodeHasError) out.push(n.getStart(file));
    return true;
  });
  return out;
}

/** Whether the file is one Flow checks: `@flow` in a comment before its code. */
function isFlow(file: ts.SourceFile): boolean {
  const text = file.getFullText();
  return (ts.getLeadingCommentRanges(text, 0) ?? []).some((c) => FLOW.test(text.slice(c.pos, c.end)));
}

/** Whether a JSX element of `node`'s is left open: its closing tag isn't its own (`<Image>` closed by `</View>`). */
function unclosedJsx(file: ts.SourceFile, node: ts.Node): boolean {
  let found = false;
  eachNode(node, (n) => {
    if (found) return false;
    if (ts.isJsxElement(n))
      found = n.openingElement.tagName.getText(file) !== n.closingElement.tagName.getText(file);
    return !found;
  });
  return found;
}

/** Each `StyleSheet.create({ … })` style of the file, by how it's named: `styles.row`. */
function styleSheets(file: ts.SourceFile): Map<string, ts.ObjectLiteralExpression> {
  const out = new Map<string, ts.ObjectLiteralExpression>();
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const d of statement.declarationList.declarations) {
      const call = d.initializer && unwrapped(d.initializer);
      if (!ts.isIdentifier(d.name) || !call || !ts.isCallExpression(call)) continue;
      if (call.expression.getText() !== "StyleSheet.create") continue;
      const sheet = call.arguments[0];
      if (!sheet || !ts.isObjectLiteralExpression(sheet)) continue;
      for (const p of sheet.properties) {
        const name = p.name && propertyName(p.name);
        if (name && ts.isPropertyAssignment(p) && ts.isObjectLiteralExpression(p.initializer))
          out.set(`${d.name.text}.${name}`, p.initializer);
      }
    }
  }
  return out;
}

export class JsxElements {
  private readonly sheets: Map<string, ts.ObjectLiteralExpression>;
  /** Whether the nesting limit stopped the reading short, so the elements read are only part of what it returns. */
  private cut = false;

  constructor(private readonly source: JsSource) {
    this.sheets = styleSheets(source.file);
  }

  /** The elements the component declared from `start` to `end` returns: a conditional of its returns when it has
   * several (`if (loading) return <Spinner />`). Undefined when it isn't a component's declaration, or can't be read
   * whole: code TypeScript can't parse, or JSX nested past the limit. */
  ofComponent(start: number, end: number): Element[] | undefined {
    const node = declared(this.source, start, end);
    const fn = node && functionOf(node);
    if (!fn) return undefined;
    const elements = this.ofReturns(fn, { start, end }, 0);
    if (this.cut) return undefined;
    const { file } = this.source;
    const errors = errorsIn(file, node);
    if (errors.length === 0) return elements;
    // TypeScript can't parse Flow's types (`{| a: T |}`) but reads past them, and one such error can set off others
    // anywhere after it. So a Flow file's component with errors is read when they left it elements and its JSX is
    // whole, every tag closed by its own; any other component with errors is undefined.
    return isFlow(file) && elements.length > 0 && !unclosedJsx(file, node) ? elements : undefined;
  }

  /** What a function returns: one return's elements, or a conditional of its several. */
  private ofReturns(
    fn: ts.SignatureDeclaration,
    span: { start: number; end: number },
    depth: number,
  ): Element[] {
    const values = returned(fn).map((value) => this.ofExpression(value, depth + 1));
    if (values.length <= 1) return values[0] ?? [];
    return [{ name: "", kind: "conditional", ...span, children: [], branches: values }];
  }

  private span(node: ts.Node) {
    return { start: node.getStart(this.source.file), end: node.getEnd() };
  }

  /** The elements an expression gives: JSX, a conditional, a loop, or none. */
  private ofExpression(expression: ts.Expression, depth: number): Element[] {
    if (depth > MAX_DEPTH) {
      this.cut = true;
      return [];
    }
    const value = unwrapped(expression);
    if (ts.isJsxElement(value) || ts.isJsxSelfClosingElement(value) || ts.isJsxFragment(value))
      return [this.ofJsx(value, depth)];
    if (ts.isConditionalExpression(value))
      return this.conditional(value, [value.whenTrue, value.whenFalse], depth);
    if (ts.isBinaryExpression(value)) {
      const operator = value.operatorToken.kind;
      // `a && <X />` shows X or nothing; `a || <X />` and `a ?? <X />` show a, or X instead.
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken)
        return this.conditional(value, [value.right], depth);
      if (operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken)
        return this.conditional(value, [value.left, value.right], depth);
    }
    if (ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression)) {
      const loop = LOOPS.has(value.expression.name.text);
      const fn = value.arguments[0];
      if (loop && fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)))
        return [this.repeat(value, fn, depth)];
    }
    return [];
  }

  private conditional(node: ts.Expression, branches: ts.Expression[], depth: number): Element[] {
    const read = branches.map((b) => this.ofExpression(b, depth + 1)).filter((b) => b.length > 0);
    if (read.length === 0) return [];
    return [{ name: "", kind: "conditional", ...this.span(node), children: [], branches: read }];
  }

  /** A repeat of what `fn`, called for each item, returns. */
  private repeat(node: ts.Node, fn: ts.SignatureDeclaration, depth: number): Element {
    const span = this.span(node);
    return { name: "", kind: "repeat", ...span, children: [], branches: [this.ofReturns(fn, span, depth)] };
  }

  private ofJsx(node: ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment, depth: number): Element {
    if (ts.isJsxFragment(node))
      return { name: "", kind: "group", ...this.span(node), children: this.children(node.children, depth) };
    const opening = ts.isJsxElement(node) ? node.openingElement : node;
    const name = opening.tagName.getText(this.source.file);
    const children = ts.isJsxElement(node) ? this.children(node.children, depth) : [];
    const element: Element = { name, ...this.span(node), children };
    const attributes = new Map<string, ts.JsxAttribute>();
    for (const a of opening.attributes.properties)
      if (ts.isJsxAttribute(a) && ts.isIdentifier(a.name)) attributes.set(a.name.text, a);
    for (const [prop, attribute] of attributes) {
      const value = attribute.initializer;
      if (!RENDER_ITEM.has(prop) || !value || !ts.isJsxExpression(value) || !value.expression) continue;
      const fn = unwrapped(value.expression);
      if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))
        element.children.push(this.repeat(attribute, fn, depth));
    }
    if (LISTS.test(name) && Number(literalOf(attributes.get("numColumns")) ?? 1) > 1)
      element.kind = "lazy-grid";
    element.holding = this.isRow(attributes) ? "stack-h" : "stack-v";
    return element;
  }

  private children(children: ts.NodeArray<ts.JsxChild>, depth: number): Element[] {
    return children.flatMap((child): Element[] => {
      if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) {
        if (depth < MAX_DEPTH) return [this.ofJsx(child, depth + 1)];
        this.cut = true;
        return [];
      }
      if (ts.isJsxExpression(child) && child.expression)
        return this.ofExpression(child.expression, depth + 1);
      return [];
    });
  }

  /** Whether a view's style or class names lay its children out in a row. */
  private isRow(attributes: Map<string, ts.JsxAttribute>): boolean {
    const className = literalOf(attributes.get("className"));
    if (className !== undefined && ROW_CLASS.test(className)) return true;
    const style = attributes.get("style")?.initializer;
    const expression = style && ts.isJsxExpression(style) ? style.expression : undefined;
    return expression ? this.direction(expression) === "row" : false;
  }

  /** The `flexDirection` a style sets, the last one written winning: in place, a sheet's, or in a list of them. */
  private direction(style: ts.Expression): "row" | "column" | undefined {
    const value = unwrapped(style);
    if (ts.isArrayLiteralExpression(value))
      return value.elements.reduce<"row" | "column" | undefined>((d, e) => this.direction(e) ?? d, undefined);
    const object = ts.isObjectLiteralExpression(value)
      ? value
      : this.sheets.get(value.getText(this.source.file));
    if (!object) return undefined;
    let out: "row" | "column" | undefined;
    for (const p of object.properties)
      if (ts.isPropertyAssignment(p) && p.name && propertyName(p.name) === "flexDirection") {
        const written = stringValue(p.initializer);
        if (written !== undefined) out = ROW.test(written) ? "row" : "column";
      }
    return out;
  }
}

/** An attribute's value written as a string or a number: `numColumns={2}`, `className="flex-row"`. */
function literalOf(attribute: ts.JsxAttribute | undefined): string | undefined {
  const value = attribute?.initializer;
  if (!value) return undefined;
  if (ts.isStringLiteral(value)) return value.text;
  if (!ts.isJsxExpression(value) || !value.expression) return undefined;
  const expression = unwrapped(value.expression);
  if (ts.isNumericLiteral(expression)) return expression.text;
  return stringValue(expression);
}
