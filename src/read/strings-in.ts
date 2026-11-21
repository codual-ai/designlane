/** The text one file shows people: words written in the code, and translated strings it names by key. */

import ts from "typescript";
import { eachNode, jsSource } from "../frameworks/js-sources.js";
import { kotlinSource } from "../frameworks/kotlin-sources.js";
import { type Locator, locator } from "../frameworks/source-text.js";
import { swiftSource } from "../frameworks/swiftui-sources.js";
import type { FrameworkId } from "../scan/types.js";
import type { StringUse } from "./schema.js";
import { decodeEntities, type StringTable } from "./string-table.js";

/** A string literal's contents in a file: offsets without its quotes, and its text with escapes read. */
interface Literal {
  start: number;
  end: number;
  text: string;
}

/** An escape after a backslash at `at`, as the text it stands for and how many characters it takes: `\n`,
 * Swift's `\u{1F600}`, Kotlin's `\u00E9` and `\$`. */
function escapeAt(text: string, at: number, swift: boolean): [string, number] {
  const unicode = swift ? /^u\{([0-9a-fA-F]{1,8})\}/ : /^u([0-9a-fA-F]{4})/;
  const code = unicode.exec(text.slice(at, at + 12));
  if (code) return [String.fromCodePoint(Number.parseInt(code[1] ?? "0", 16)), code[0].length];
  const c = text[at] ?? "";
  return [ESCAPES[c] ?? c, 1];
}
const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0" };

/** Where the string starting at `quote` inside an interpolation ends, or -1 when it doesn't on its line. */
function nestedEnd(text: string, quote: number): number {
  for (let i = quote + 1; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") return -1;
    if (c === "\\") i++;
    else if (c === '"') return i;
  }
  return -1;
}

/**
 * The one-line string literal at `quote` in Swift or Kotlin, or undefined for a multi-line or raw one. An
 * interpolation (`\(name)`, `${name}`) stays as written, strings and brackets inside it included.
 */
function literalAt(text: string, quote: number, swift: boolean): Literal | undefined {
  if (text[quote] !== '"' || text.startsWith('"""', quote)) return undefined;
  let out = "";
  let depth = 0;
  for (let i = quote + 1; i < text.length; i++) {
    const c = text[i] ?? "";
    if (c === "\n") return undefined;
    if (depth > 0) {
      if (c === '"') {
        const end = nestedEnd(text, i);
        if (end === -1) return undefined;
        out += text.slice(i, end + 1);
        i = end;
        continue;
      }
      out += c;
      if (c === "(" || c === "{") depth++;
      else if (c === ")" || c === "}") depth--;
      continue;
    }
    if (c === '"') return { start: quote + 1, end: i, text: out };
    if (c === "\\" && swift && text[i + 1] === "(") {
      out += "\\(";
      depth = 1;
      i++;
    } else if (c === "\\") {
      const [value, length] = escapeAt(text, i + 1, swift);
      out += value;
      i += length;
    } else if (!swift && c === "$" && text[i + 1] === "{") {
      out += "${";
      depth = 1;
      i++;
    } else out += c;
  }
  return undefined;
}

/** The string literal at `quote` when it's a whole argument, ended by `,` or `)`: in `Text("hi".uppercased())` the
 * text shown isn't the literal's. */
function argumentAt(text: string, quote: number, swift: boolean): Literal | undefined {
  const literal = literalAt(text, quote, swift);
  if (!literal) return undefined;
  const after = text[skipSpace(text, literal.end + 1)];
  return after === "," || after === ")" ? literal : undefined;
}

const skipSpace = (text: string, at: number) => {
  while (at < text.length && /\s/.test(text[at] ?? "")) at++;
  return at;
};

/** SwiftUI views and modifiers whose first argument is text people see; SwiftUI looks a literal up as a key. */
const SWIFT_SHOWN =
  /(?<![\w.])(?:Text|Button|Label|Toggle|Picker|Section|Link|Menu|NavigationLink|TextField|SecureField|Stepper|DatePicker|LabeledContent|ShareLink|ContentUnavailableView|ProgressView)\s*\(|\.(?:navigationTitle|navigationSubtitle|alert|confirmationDialog|help|badge)\s*\(/g;
/** Calls naming a translated string by its key. */
const SWIFT_LOCALIZED =
  /(?<![\w.])(?:NSLocalizedString|LocalizedStringKey|LocalizedStringResource)\s*\(|(?<![\w.])String\s*\(\s*localized\s*:/g;

function swiftStrings(rel: string, text: string, table: StringTable): Found[] {
  const { code } = swiftSource(rel, text);
  const out: Found[] = [];
  const read = (pattern: RegExp, use: (literal: Literal, verbatim: boolean) => Found) => {
    for (const m of code.matchAll(pattern)) {
      let at = skipSpace(text, (m.index ?? 0) + m[0].length);
      const verbatim = text.startsWith("verbatim:", at);
      if (verbatim) at = skipSpace(text, at + "verbatim:".length);
      const literal = argumentAt(text, at, true);
      if (literal) out.push(use(literal, verbatim));
    }
  };
  read(SWIFT_SHOWN, (literal, verbatim) =>
    !verbatim && table.keys.has(literal.text) ? localized(literal, literal.text, table) : shown(literal),
  );
  read(SWIFT_LOCALIZED, (literal) => localized(literal, literal.text, table));
  return out;
}

/** `Text(`, matched in blanked code: what follows is read from the text, where the string is. */
const KOTLIN_TEXT = /(?<![\w.])Text\s*\(/g;
/** `text =`, matched where an argument starts in blanked code. */
const NAMED_TEXT = /text\s*=/y;
/** A string resource by its name: `stringResource(R.string.x)`, `context.getString(R.string.x)`, plurals too. */
const KOTLIN_RESOURCE =
  /(?:(?<![\w.])(?:stringResource|pluralStringResource)|(?<!\w)(?:getString|getText|getQuantityString))\s*\(\s*(?:id\s*=\s*)?R\.(?:string|plurals)\.(\w+)/g;
/** How far a call's arguments are searched for `text =`. */
const MAX_ARGUMENTS = 4000;

/** Where the value of the call's own `text =` argument starts, the call's `(` at `open` in blanked code, or
 * undefined when it has none; a `text =` inside another argument (`Modifier.semantics { text = … }`) isn't it. */
function namedText(code: string, open: number): number | undefined {
  let depth = 0;
  const last = Math.min(code.length, open + MAX_ARGUMENTS);
  for (let i = open; i < last; i++) {
    const c = code[i] ?? "";
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") {
      if (--depth === 0) return undefined;
    } else if (depth === 1 && c === "t" && !/[\w.]/.test(code[i - 1] ?? "")) {
      NAMED_TEXT.lastIndex = i;
      if (NAMED_TEXT.test(code)) return NAMED_TEXT.lastIndex;
    }
  }
  return undefined;
}

function kotlinStrings(rel: string, text: string, table: StringTable): Found[] {
  const { code } = kotlinSource(rel, text);
  const out: Found[] = [];
  for (const m of code.matchAll(KOTLIN_TEXT)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    // The text comes first, or is named among the arguments: `Text(modifier = m, text = "Hi")`.
    const named = namedText(code, open);
    const literal =
      argumentAt(text, skipSpace(text, open + 1), false) ??
      (named === undefined ? undefined : argumentAt(text, skipSpace(text, named), false));
    if (literal) out.push(shown(literal));
  }
  for (const m of code.matchAll(KOTLIN_RESOURCE)) {
    const key = m[1] ?? "";
    const end = (m.index ?? 0) + m[0].length;
    out.push(localized({ start: end - key.length, end, text: key }, key, table));
  }
  return out;
}

/** Props whose string is text people see. */
const JS_SHOWN_PROPS = new Set([
  "title",
  "subtitle",
  "label",
  "placeholder",
  "text",
  "message",
  "description",
  "headerTitle",
  "tabBarLabel",
]);
/** Navigation options whose string is a screen's title. */
const JS_OPTIONS = new Set(["options", "screenOptions"]);
/** Translation functions: `t("cart.title")`, `i18n.t(…)`, `translate(…)`, `intl.formatMessage({ id })`. */
const JS_TRANSLATE = new Set(["t", "translate", "__"]);
/** The entities JSX text and attribute strings can hold, beside XML's. */
const JSX_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  bull: "•",
};

/** JSX text as React shows it: each line's indentation and line break taken out, lines joined by a space,
 * same-line spaces kept, entities read. */
function jsxText(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/);
  const kept = lines
    .map((line, i) => {
      const start = i === 0 ? line : line.trimStart();
      return i === lines.length - 1 ? start : start.trimEnd();
    })
    .filter((line) => line !== "");
  return decodeEntities(kept.join(" ").trim(), JSX_ENTITIES);
}

/** Components naming a translated string by a prop. */
const JS_KEY_PROPS: Record<string, string> = { Trans: "i18nKey", FormattedMessage: "id" };

const isString = (node: ts.Node | undefined): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
  !!node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
const jsLiteral = (node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral): Literal => ({
  start: node.getStart() + 1,
  end: node.getEnd() - 1,
  text: node.text,
});
const nameOf = (node: ts.Node | undefined) =>
  node && (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) ? node.text : undefined;
const tagOf = (node: ts.Node): string | undefined => {
  const element = ts.isJsxElement(node)
    ? node.openingElement
    : ts.isJsxSelfClosingElement(node)
      ? node
      : undefined;
  return element && ts.isIdentifier(element.tagName) ? element.tagName.text : undefined;
};

/** The string a JSX attribute is given, written as `"…"` (whose entities JSX reads) or `{"…"}`. */
function attributeString(attribute: ts.JsxAttribute) {
  const value = attribute.initializer;
  if (value && ts.isStringLiteral(value)) return value;
  const inner = value && ts.isJsxExpression(value) ? value.expression : undefined;
  return isString(inner) ? inner : undefined;
}

function jsStrings(rel: string, text: string, table: StringTable): Found[] {
  const source = jsSource(rel, text);
  const out: Found[] = [];
  eachNode(source.file, (node) => {
    // `<Trans i18nKey>`'s children are the key's default text, read through its key instead; without a key they're
    // its text.
    if (tagOf(node) === "Trans") {
      const opening = ts.isJsxElement(node) ? node.openingElement : (node as ts.JsxSelfClosingElement);
      for (const p of opening.attributes.properties)
        if (ts.isJsxAttribute(p) && nameOf(p.name) === "i18nKey") {
          const key = attributeString(p);
          if (key) {
            out.push(localized(jsLiteral(key), key.text, table));
            return false;
          }
        }
    }
    if (ts.isJsxText(node)) {
      const raw = node.getText();
      const trimmed = raw.trim();
      if (trimmed) {
        const start = node.getStart() + raw.indexOf(trimmed);
        out.push(shown({ start, end: start + trimmed.length, text: jsxText(raw) }));
      }
    } else if (
      ts.isJsxExpression(node) &&
      isString(node.expression) &&
      node.expression.text.trim() !== "" &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    )
      out.push(shown(jsLiteral(node.expression)));
    else if (ts.isJsxAttribute(node)) {
      const name = nameOf(node.name) ?? "";
      const value = attributeString(node);
      const tag = node.parent.parent.tagName;
      const keyProp = ts.isIdentifier(tag) ? JS_KEY_PROPS[tag.text] : undefined;
      if (value && keyProp === name) out.push(localized(jsLiteral(value), value.text, table));
      else if (value && JS_SHOWN_PROPS.has(name)) {
        const literal = jsLiteral(value);
        const written =
          value === node.initializer ? decodeEntities(literal.text, JSX_ENTITIES) : literal.text;
        out.push(shown({ ...literal, text: written }));
      }
    } else if (ts.isPropertyAssignment(node) && isString(node.initializer) && inOptions(node)) {
      if (JS_SHOWN_PROPS.has(nameOf(node.name) ?? "")) out.push(shown(jsLiteral(node.initializer)));
    } else if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
      const called = nameOf(callee) ?? "";
      const [first] = node.arguments;
      if (JS_TRANSLATE.has(called) && isString(first))
        out.push(localized(jsLiteral(first), first.text, table));
      else if (called === "formatMessage" && first && ts.isObjectLiteralExpression(first))
        for (const p of first.properties)
          if (ts.isPropertyAssignment(p) && nameOf(p.name) === "id" && isString(p.initializer))
            out.push(localized(jsLiteral(p.initializer), p.initializer.text, table));
    }
    return true;
  });
  return out;
}

/** Whether a property is one of a navigator's or screen's options: `options={{ title: "Cart" }}`. */
function inOptions(node: ts.PropertyAssignment): boolean {
  const object = node.parent;
  const holder = object.parent;
  const attribute = holder && ts.isJsxExpression(holder) ? holder.parent : undefined;
  return !!attribute && ts.isJsxAttribute(attribute) && JS_OPTIONS.has(nameOf(attribute.name) ?? "");
}

/** A use before its span is placed in the file. */
type Found =
  | { kind: "literal"; text: string; start: number; end: number }
  | { kind: "localized"; key: string; text: string | null; start: number; end: number };

const shown = ({ start, end, text }: Literal): Found => ({ kind: "literal", text, start, end });
const localized = ({ start, end }: Literal, key: string, table: StringTable): Found => ({
  kind: "localized",
  key,
  text: table.text.get(key) ?? null,
  start,
  end,
});

/** The text `text`, the file `rel` of `framework`'s code, shows people, in the order it's written. */
export function stringsIn(
  framework: FrameworkId,
  rel: string,
  text: string,
  table: StringTable,
): StringUse[] {
  const found =
    framework === "swiftui"
      ? swiftStrings(rel, text, table)
      : framework === "compose"
        ? kotlinStrings(rel, text, table)
        : jsStrings(rel, text, table);
  const at: Locator = locator(rel, text);
  return found
    .sort((a, b) => a.start - b.start)
    .map(({ start, end, ...use }) => ({ ...use, span: at(start, end) }));
}
