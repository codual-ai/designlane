/**
 * Plans the code edit for a change made to a token in a design tool: the one span of one file to rewrite, with the new
 * value written as the code writes the old one, or a plain reason it can't be done safely. Refusing whenever it's
 * unsure is what makes an edit safe to open as a pull request without a person checking where it lands.
 */

import { lineNumbers } from "../frameworks/source-text.js";
import type { CodeSpan, ValueKind } from "../scan/types.js";
import {
  COLOR_PROPERTIES,
  type EditableToken,
  type EditProperty,
  editableTokens,
  findToken,
  type TokenValue,
  type ValueLocation,
} from "./edit-tokens.js";
import { COLOR_EDITOR, FAMILY_EDITOR, SIZE_EDITOR, type ValueEditor, WEIGHT_EDITOR } from "./editors.js";
import { languageOf, MAX_VALUE_LENGTH, QUOTES, type SpanText, spliced } from "./notation.js";

/** A file's text by its path relative to the app's root, or undefined when there's no such file. */
export type ReadSource = (file: string) => Promise<string | undefined>;

export interface TokenChange {
  /** The token's key in tokens.json, or how the code refers to it (`Theme.surface`). */
  token: string;
  property: EditProperty;
  /** `#rrggbb` or `#rrggbbaa` for a colour, a number for a size or weight, a name for a family. */
  value: string;
}

/** One span of one file and what to write in its place. */
export interface TextEdit {
  file: string;
  line: number;
  start: number;
  end: number;
  before: string;
  after: string;
}

export type EditPlan = { ok: true; edit: TextEdit } | { ok: false; reason: string };

const PROPERTY_NAMES: Record<EditProperty, string> = {
  light: "colour",
  dark: "dark colour",
  family: "font family",
  size: "font size",
  weight: "font weight",
};
/** A name on the way to a value: `colors.blue0`, `Palette.Yellow500`, `@color/blue600`, `colors.brand[500]`. */
const NAME = /^[@?]?[A-Za-z_$][\w.$/[\]"'-]*$/;
/** The last part of a name: `blue0` of `colors.blue0`, `500` of `colors.brand[500]`, `blue600` of `@color/blue600`. */
const LAST_PART = /([\w$-]+)["'\]]*$/;
const WORD = /[\w$]/;
const SPACE = /[ \t]/;
const OPERATORS = new Set(["+", "-", "*", "/", "%"]);
/** What follows a `/` that starts a comment. */
const COMMENT_SECOND = new Set(["/", "*"]);

/** The span where a token writes its own value: the first name on its way to the value, or the value itself. */
const ownSpan = (location: ValueLocation): CodeSpan => location.via?.[0] ?? location;
const refuse = (reason: string): EditPlan => ({ ok: false, reason });
const at = (span: CodeSpan) => `${span.file}:${span.line}`;

/** The edit that makes `change` in the code, from where `tokensFile` (a parsed tokens.json) says the value is
 * written, reading files with `read`. Throws when `tokensFile` isn't a tokens.json Designmap writes. */
export async function planEdit(
  tokensFile: unknown,
  read: ReadSource,
  change: TokenChange,
): Promise<EditPlan> {
  const { colors, textStyles } = editableTokens(tokensFile);
  const isColor = COLOR_PROPERTIES.some((property) => property === change.property);
  const found = findToken(isColor ? colors : textStyles, change.token);
  if ("reason" in found) return refuse(found.reason);
  const what = `${found.token.key}'s ${PROPERTY_NAMES[change.property]}`;
  const value = found.token.values.find((v) => v.property === change.property);
  if (!value) return refuse(`tokens.json gives ${found.token.key} no ${PROPERTY_NAMES[change.property]}.`);
  if (!value.location) {
    return refuse(
      `tokens.json doesn't say where ${what} is written: the code may work it out from another value. Change it in the code.`,
    );
  }
  const kindRefusal = KIND_REFUSALS[value.location.kind];
  if (kindRefusal) return refuse(`${what} can't be changed on its own: ${kindRefusal}.`);
  const target = await targetOf(value.location, isColor, read);
  if ("reason" in target) return refuse(target.reason);
  const other = sharer([...colors, ...textStyles], value, target.span);
  if (other) {
    return refuse(
      `${what} is written where ${other} is (${at(target.span)}), so changing it changes both. Give it its own value in the code first, or change it there by hand.`,
    );
  }
  return rewrite(what, value, change.value, target);
}

/** Kinds of span no value of a text style can be rewritten in on its own. */
const KIND_REFUSALS: Partial<Record<ValueKind, string>> = {
  "family-name": "it's part of a font's name, which holds the family and the weight together",
  identifier: "the code names a font family declared elsewhere",
};

interface Target {
  /** Where the value is written, and that file's text. */
  value: SpanText & { span: ValueLocation };
  /** The span to replace: the value, or the token's own name for it when it reaches the value through names. */
  span: CodeSpan;
  /** The text there now. */
  before: string;
  /** Quotes the new text needs there, which a literal's span leaves out. */
  quote: string;
}

/** Where the edit goes. A colour reaching its value through a name (`link: colors.blue0`) gets its own value in place
 * of the name, so the colours sharing the name keep theirs; a text style's names are styles it builds on, which it
 * can't take a value in place of. */
async function targetOf(
  location: ValueLocation,
  isColor: boolean,
  read: ReadSource,
): Promise<Target | { reason: string }> {
  const fileText = await read(location.file);
  const language = languageOf(location.file);
  if (fileText === undefined) return { reason: `${location.file} isn't in the app any more.` };
  if (!language) return { reason: `Designmap doesn't edit ${location.file}'s kind of file.` };
  const text = spanText(fileText, location);
  if ("reason" in text) return text;
  // A value with a call after it (`.opacity(0.5)`) is no longer the value tokens.json has.
  if (fileText[location.end] === ".") return { reason: changedSince(location, text) };
  const value = { text: text.text, kind: location.kind, language, fileText, span: location };
  const own = location.via?.[0];
  if (!own) return { value, span: location, before: text.text, quote: "" };
  const ownText = await read(own.file);
  const name = ownText === undefined ? undefined : spanText(ownText, own);
  if (!name || "reason" in name || !NAME.test(name.text)) return { reason: changedSince(own, name) };
  if (!isColor) {
    return { reason: `it comes from \`${name.text}\` (${at(own)}), which other styles may build on too.` };
  }
  if (languageOf(own.file) !== language) {
    return { reason: `it names \`${name.text}\` (${at(own)}), whose value is written in another language.` };
  }
  const broken = await namesHold(location, read);
  if (broken) return { reason: changedSince(broken) };
  const opening = fileText[location.start - 1] ?? "";
  const quoted = location.kind === "literal" && QUOTES.has(opening) && fileText[location.end] === opening;
  return { value, span: own, before: name.text, quote: quoted ? opening : "" };
}

/** The text at `span`, when the file still has it where tokens.json says and it's still a whole name or value: one
 * that grew (`17` to `170`) would be half rewritten, and one now worked out (`17 * 2`) is no longer the value. A
 * member's span starts at its dot. */
function spanText(fileText: string, span: CodeSpan): { text: string } | { reason: string } {
  const isInFile = span.end <= fileText.length && span.end - span.start <= MAX_VALUE_LENGTH;
  if (!isInFile || lineNumbers(fileText, [span.start])[0] !== span.line) {
    return { reason: changedSince(span) };
  }
  const text = fileText.slice(span.start, span.end);
  const runsOn = WORD.test(fileText[span.end] ?? "");
  const runsIn = !text.startsWith(".") && WORD.test(fileText[span.start - 1] ?? "");
  const isComputed = isOperatorAfter(fileText, span.end) || isOperatorBefore(fileText, span.start);
  return runsOn || runsIn || isComputed ? { reason: changedSince(span, { text }) } : { text };
}

/** Whether an arithmetic operator follows `end`, past spaces; `//` and `/*` start a comment instead. */
function isOperatorAfter(text: string, end: number): boolean {
  let at = end;
  while (at < text.length && SPACE.test(text[at] ?? "")) at++;
  const next = text[at] ?? "";
  return OPERATORS.has(next) && !(next === "/" && COMMENT_SECOND.has(text[at + 1] ?? ""));
}

/** Whether an arithmetic operator comes before `start`, past spaces; the `/` ending a block comment isn't one. */
function isOperatorBefore(text: string, start: number): boolean {
  let at = start - 1;
  while (at > 0 && SPACE.test(text[at] ?? "")) at--;
  const previous = text[at] ?? "";
  return OPERATORS.has(previous) && !(previous === "/" && text[at - 1] === "*");
}

/** Whether each name on the way to a colour still names the next: its last part (`blue0` of `colors.blue0`) is
 * declared on the line of the next name or the value, so a name changed since the scan isn't followed blindly. */
async function namesHold(location: ValueLocation, read: ReadSource): Promise<CodeSpan | undefined> {
  const chain = [...(location.via ?? []), location];
  for (const [i, name] of chain.slice(0, -1).entries()) {
    const next = chain[i + 1];
    const [nameText, nextText] = await Promise.all([read(name.file), next && read(next.file)]);
    const part = LAST_PART.exec(nameText?.slice(name.start, name.end) ?? "")?.[1];
    if (!next || nextText === undefined || !part) return name;
    const declaration = nextText.slice(nextText.lastIndexOf("\n", next.start - 1) + 1, next.start);
    if (!hasWord(declaration, part)) return name;
  }
  return undefined;
}

function hasWord(text: string, word: string): boolean {
  for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) {
    if (!WORD.test(text[at - 1] ?? "") && !WORD.test(text[at + word.length] ?? "")) return true;
  }
  return false;
}

function changedSince(span: CodeSpan, found?: { text: string } | { reason: string }) {
  const now = found && "text" in found ? ` now reads \`${found.text}\`` : " has changed";
  return `${at(span)}${now}: the code changed since designmap last ran. Run designmap again.`;
}

/** Another token value written at `span` too, which an edit there would change as well. */
function sharer(tokens: EditableToken[], value: TokenValue, span: CodeSpan): string | undefined {
  for (const token of tokens) {
    for (const other of token.values) {
      if (other === value || !other.location) continue;
      const own = ownSpan(other.location);
      if (own.file === span.file && own.start < span.end && span.start < own.end) {
        return `${token.key}'s ${PROPERTY_NAMES[other.property]}`;
      }
    }
  }
  return undefined;
}

function rewrite(what: string, value: TokenValue, input: string, target: Target): EditPlan {
  switch (value.property) {
    case "light":
    case "dark":
      return rewriteWith(COLOR_EDITOR, what, value.old, input, target);
    case "size":
      return rewriteWith(SIZE_EDITOR, what, value.old, input, target);
    case "weight":
      return rewriteWith(WEIGHT_EDITOR, what, value.old, input, target);
    case "family":
      return rewriteWith(FAMILY_EDITOR, what, value.old, input, target);
  }
}

/** The edit writing `input` in the notation the code writes `old` in. */
function rewriteWith<T>(
  editor: ValueEditor<T>,
  what: string,
  old: T,
  input: string,
  target: Target,
): EditPlan {
  const { value, span, before, quote } = target;
  const to = editor.parse(input);
  if (to === undefined) return refuse(`\`${input}\` isn't ${editor.expected}.`);
  if (editor.same(old, to)) return refuse(`${what} is already ${editor.show(to)}.`);
  const readings = editor.readings(value);
  const written = `\`${value.text}\` (${at(value.span)})`;
  if (readings.length === 0) return refuse(`Designmap can't safely rewrite ${written} for ${what}.`);
  const matching = readings.filter((reading) => editor.same(reading.value, old));
  if (matching.length === 0) return refuse(changedSince(value.span, value));
  const texts = new Set(matching.map((reading) => reading.write(to, old)));
  const [after] = texts;
  if (texts.size > 1)
    return refuse(`${written} could be read more than one way, so its new value could be too.`);
  if (after === undefined) return refuse(`${written} can't hold ${editor.show(to)} written the same way.`);
  const { file, line, start, end } = span;
  return { ok: true, edit: { file, line, start, end, before, after: `${quote}${after}${quote}` } };
}

/** `text` with `edit` made, or an error when the text at its span isn't what it was planned against. */
export function applyEdit(text: string, edit: TextEdit): string {
  if (text.slice(edit.start, edit.end) !== edit.before) {
    throw new Error(`${edit.file}:${edit.line} changed since the edit was planned. Plan it again.`);
  }
  return spliced(text, [{ start: edit.start, end: edit.end, text: edit.after }]);
}
