/**
 * Plans the code edit for a change made to a token in a design tool: the one span of one file to rewrite, with the new
 * value written as the code writes the old one, or a plain reason it can't be done safely. Refusing whenever it's
 * unsure is what makes an edit safe to open as a pull request without a person checking where it lands.
 */

import { lineNumbers } from "../frameworks/source-text.js";
import type { CodeSpan, ValueKind } from "../scan/types.js";
import { namesHold, namesNothing } from "./alias-copy.js";
import { isOperatorAfter, isOperatorBefore, nextCode, quotedSpan, WORD } from "./code-scan.js";
import {
  COLOR_PROPERTIES,
  type EditProperty,
  editableTokens,
  findToken,
  PROPERTY_NAMES,
  type TokenValue,
  type ValueLocation,
  valueLabel,
} from "./edit-tokens.js";
import { COLOR_EDITOR, FAMILY_EDITOR, SIZE_EDITOR, type ValueEditor, WEIGHT_EDITOR } from "./editors.js";
import { languageOf, MAX_VALUE_LENGTH, QUOTES, type SpanText, spliced } from "./notation.js";
import { type ReadSource, readingOnce, sourceOf, textOf } from "./read-source.js";
import { dependents, ownerOf, sharers } from "./sharers.js";

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

/** A name on the way to a value: `colors.blue0`, `Palette.Yellow500`, `@color/blue600`, `colors.brand[500]`. */
const NAME = /^[@?]?[A-Za-z_$][\w.$/[\]"'-]*$/;
const HEX_NUMBER = /^0[xX][0-9a-fA-F]+$/;
/** A color's name with opacity calls after it: `Palette.grey.withAlphaComponent(0.6)`, the call maybe on the next line. */
const WITH_OPACITY = /^[A-Za-z_$.][\w.$]*\s*\.(?:withAlphaComponent|opacity)\(/;

const refuse = (reason: string): EditPlan => ({ ok: false, reason });
const at = (span: CodeSpan) => `${span.file}:${span.line}`;

/** The edit that makes `change` in the code, from where `tokensFile` (a parsed tokens.json) says the value is
 * written, reading files with `read`. Throws when `tokensFile` isn't a tokens.json Designlane writes. */
export async function planEdit(
  tokensFile: unknown,
  readFile: ReadSource,
  change: TokenChange,
): Promise<EditPlan> {
  const read = readingOnce(readFile);
  const { colors, textStyles } = editableTokens(tokensFile);
  const isColor = COLOR_PROPERTIES.some((property) => property === change.property);
  const found = findToken(isColor ? colors : textStyles, change.token);
  if ("reason" in found) return refuse(found.reason);
  const what = valueLabel(found.token.key, change.property);
  const value = found.token.values.find((v) => v.property === change.property);
  if (!value) return refuse(`tokens.json gives ${found.token.key} no ${PROPERTY_NAMES[change.property]}.`);
  if (!value.location) {
    return refuse(
      `tokens.json doesn't say where ${what} is written: the code may work it out from another value. Change it in the code.`,
    );
  }
  const kindRefusal = KIND_REFUSALS[value.location.kind];
  if (kindRefusal) return refuse(`${what} can't be changed on its own: ${kindRefusal}.`);
  const all = [...colors, ...textStyles];
  const owner = (span: CodeSpan) => ownerOf(all, span);
  const target = await targetOf(value.location, { key: found.token.key, isColor, read, owner });
  if ("reason" in target) return refuse(target.reason);
  const others = [...sharers(all, value, target.span), ...(await dependents(all, found.token, read))];
  if (others.length > 0) {
    return refuse(
      `Changing ${what} (${at(target.span)}) would also change ${list(others)}. Give each its own value in the code first, or change it there by hand.`,
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

interface TargetContext {
  /** The key of the token being changed. */
  key: string;
  isColor: boolean;
  read: ReadSource;
  /** The key of the token whose own value is written at a span, if any. */
  owner: (span: CodeSpan) => string | undefined;
}

/** Where the edit goes. A colour reaching its value through a name (`link: colors.blue0`) gets its own value in place
 * of the name, so the colours sharing the name keep theirs; a text style's names are styles it builds on, which it
 * can't take a value in place of. */
async function targetOf(
  location: ValueLocation,
  { key, isColor, read, owner }: TargetContext,
): Promise<Target | { reason: string }> {
  const file = await sourceOf(read, location.file);
  const language = languageOf(location.file);
  if ("reason" in file) return file;
  if (!language) return { reason: `Designlane doesn't edit ${location.file}'s kind of file.` };
  const fileText = file.source;
  const text = spanText(fileText, location);
  if ("reason" in text) return text;
  // A value with a call after it (`.opacity(0.5)`, `'#112233'.slice(0, 4)`) is no longer the value tokens.json has.
  if (fileText[nextCode(fileText, quotedSpan(fileText, location).end)] === ".") {
    return { reason: changedSince(location, text) };
  }
  const value = { text: text.text, kind: location.kind, language, fileText, span: location };
  const own = location.via?.[0];
  if (!own) return { value, span: location, before: text.text, quote: "" };
  const ownFile = await sourceOf(read, own.file);
  if ("reason" in ownFile) return ownFile;
  const name = spanText(ownFile.source, own);
  if ("reason" in name) return { reason: changedSince(own, name) };
  const withOpacity = await firstNameWithOpacity(location.via ?? [], read);
  if (withOpacity) {
    return {
      reason: `${key} is \`${withOpacity.text}\` (${at(withOpacity.span)}): another color at its own opacity. Change that color, or give ${key} its own value in the code.`,
    };
  }
  if (!NAME.test(name.text)) return { reason: changedSince(own, name) };
  if (!isColor) {
    return { reason: `it comes from \`${name.text}\` (${at(own)}), which other styles may build on too.` };
  }
  // A literal only compiles in place of a name in the file it's copied from (which has what it needs imported), and
  // only when it doesn't take its type from where it's written (Swift's `.init(hex: …)`). An enum's number
  // (`case red_800 = 0x73140D`) is no color in place of its name.
  if (
    own.file !== location.file ||
    text.text.startsWith(".") ||
    HEX_NUMBER.test(text.text) ||
    !namesNothing(text.text, location.kind)
  ) {
    const from = owner(location) ?? `\`${name.text}\``;
    return {
      reason: `${key} takes its colour from ${from} (${at(own)}), whose value can't be copied there safely. Change ${from}, or give ${key} its own value in the code.`,
    };
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
  const outer = quotedSpan(fileText, span);
  const isComputed = isOperatorAfter(fileText, outer.end) || isOperatorBefore(fileText, outer.start);
  return runsOn || runsIn || isComputed ? { reason: changedSince(span, { text }) } : { text };
}

/** The first name on the way to a value that has opacity calls after it, which makes the value another color. */
async function firstNameWithOpacity(
  via: CodeSpan[],
  read: ReadSource,
): Promise<{ text: string; span: CodeSpan } | undefined> {
  for (const span of via) {
    const text = textOf(await read(span.file))?.slice(span.start, span.end);
    if (text !== undefined && WITH_OPACITY.test(text)) return { text, span };
  }
  return undefined;
}

function changedSince(span: CodeSpan, found?: { text: string } | { reason: string }) {
  const now = found && "text" in found ? ` now reads \`${found.text}\`` : " has changed";
  return `${at(span)}${now}: the code changed since designlane last ran. Run designlane again.`;
}

function list(items: string[]): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
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
  if (readings.length === 0) return refuse(`Designlane can't safely rewrite ${written} for ${what}.`);
  const matching = readings.filter((reading) => editor.same(reading.value, old));
  if (matching.length === 0) return refuse(changedSince(value.span, value));
  const texts = new Set(matching.map((reading) => reading.write(to, old)));
  const [after] = texts;
  if (texts.size > 1) {
    return refuse(`${written} could be read more than one way, so its new value could be too.`);
  }
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
