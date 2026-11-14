/** Tailwind class names in a React Native app's code: where lists of them are written, and the colours they use
 * (`bg-primary-500`, `dark:text-muted`). */

import ts from "typescript";
import { accessPath, eachNode, type JsSource, propertyName } from "./js-sources.js";

/** Utility prefixes that take a colour: `bg-`, `text-`, `border-t-` and the rest. */
const COLOR_UTILITY =
  /^(?:bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|fill|stroke|from|via|to|divide|outline|decoration|placeholder|shadow|accent|caret)-(.+)$/;
/** Where class names are written: a `className`-like prop, or a class helper's arguments (`cn(…)`, `tw\`…\``). */
const CLASS_PROP = /^(?:className|class|tw|\w+Class(?:Name)?)$/;
const CLASS_HELPER = /^(?:cn|cx|clsx|classnames|classNames|twMerge|twJoin|tw|cva|tv)$/;

/** A string's text written as it is: quoted, or a template's text parts. */
const isTextPart = (node: ts.Node): node is ts.LiteralLikeNode =>
  ts.isStringLiteral(node) ||
  ts.isNoSubstitutionTemplateLiteral(node) ||
  ts.isTemplateHead(node) ||
  ts.isTemplateMiddle(node) ||
  ts.isTemplateTail(node);

/** Every string under a node: quoted, or a template's text parts. */
function stringsIn(node: ts.Node): string[] {
  const out: string[] = [];
  eachNode(node, (inner) => {
    if (isTextPart(inner)) out.push(inner.text);
    return true;
  });
  return out;
}

/** A word only a class name is: `p-4`, `md:text-lg`, `bg-primary/50`, `flex`. */
const CLASS_WORD = /^!?-?(?:[\w-]+:)*[a-z][\w-]*(?:-(?:[\w.%]+|\[[^\]\s]+\]))+(?:\/[\w.]+)?!?$/;
const BARE_CLASS =
  /^(?:flex|grid|hidden|block|inline|contents|absolute|relative|italic|underline|uppercase|lowercase|capitalize|truncate|grow|shrink|rounded|border|shadow)$/;

/** A string of nothing but class names, at least one with a value (`text-lg`, not just `flex`). */
function looksLikeClasses(text: string): boolean {
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
      if (isTextPart(inner)) texts.push(inner.text);
      return true;
    });
    const base = texts.join(" ");
    if (branches.length === 0) visit(node, base);
    for (const branch of branches) visit(branch, `${base} ${stringsIn(branch).join(" ")}`);
    return false;
  });
}

/** The colour names a string's class names use: `dark:bg-primary-500/50` uses `primary-500`. */
export function classColors(text: string): string[] {
  return text.split(/\s+/).flatMap((word) => {
    const utility = word.slice(word.lastIndexOf(":") + 1).replace(/^!|!$/g, "");
    const name = utility.match(COLOR_UTILITY)?.[1]?.replace(/\/[\w.[\]%]+$/, "");
    return name ? [name] : [];
  });
}
