/**
 * An app's type: every font its Swift code sets, each where it's set, with the app's own font helpers resolved
 * across files to the fonts they return.
 */

import { firstAtOrAfter } from "../scan/sorted.js";
import { type TypeFindings, type TypeUse, weightLabel } from "../scan/type-scale.js";
import { locator } from "./source-text.js";
import { type Argument, expressionAt } from "./swift-expressions.js";
import { type FontHelper, fontHelpers, type Range } from "./swift-font-helpers.js";
import { WEIGHTS } from "./swift-font-names.js";
import { FONT_TYPES, fontValues, type HelperReference, SIZE_LABELS } from "./swift-font-reading.js";
import { type FontSite, fontSites } from "./swift-font-sites.js";
import { ownerAt } from "./swift-owners.js";
import { type SwiftTokens, tokenIndexAt } from "./swift-tokens.js";
import { type SwiftSource, tokensOf } from "./swiftui-sources.js";

/** A helper's key: its type and name, with `()` for a function, which a type can declare beside a property. */
const helperKey = (owner: string, name: string, isFunction: boolean) =>
  `${owner}.${name}${isFunction ? "()" : ""}`;

/** Every place the Swift code sets a font: text styles, system sizes, custom fonts and the app's own helpers. */
export function swiftType(sources: SwiftSource[]): TypeFindings {
  const files = sources.map((source) => {
    const tokens = tokensOf(source);
    const sites = fontSites(tokens);
    const span = locator(source.rel, source.text);
    return { source, tokens, sites, span, helpers: fontHelpers(tokens, sites, span) };
  });
  const byKey = new Map<string, FontHelper>();
  for (const helper of files.flatMap((f) => f.helpers)) {
    const key = helperKey(helper.owner, helper.name, helper.isFunction);
    if (!byKey.has(key)) byKey.set(key, helper);
  }
  const uses: TypeUse[] = [];
  const helperFonts: TypeUse[] = [];
  const helperNames = new Set([...byKey.values()].map((h) => h.name));
  for (const { source, tokens, sites, span, helpers } of files) {
    const insideHelper = within(helpers.map((h) => h.body));
    const located = (use: TypeUse, at: number): TypeUse => ({
      ...use,
      file: source.rel,
      line: span(at, at).line,
    });
    for (const site of [...sites, ...qualifiedUses(tokens, sites, helperNames)]) {
      // A helper's own fonts count through its uses, and are kept where they're written.
      if (insideHelper(site.at)) continue;
      const value = site.value;
      const helper = "helper" in value ? resolve(value.helper, site, tokens, byKey) : undefined;
      const use = "font" in value ? value.font : helper && helperUse(helper, value.helper);
      if (use) uses.push(located(use, site.at));
    }
    for (const helper of helpers)
      for (const { font, at } of helper.written) helperFonts.push(located(font, at));
  }
  return { uses, helperFonts };
}

/** Helpers named on a type outside the places fonts were read (`var t: Font { Self.title }`, `L(font: x ??
 * AppFont.title)`), each read once. Only names some helper has are looked at. */
function qualifiedUses(file: SwiftTokens, sites: FontSite[], helperNames: Set<string>): FontSite[] {
  const read = within(sites.map((s) => [s.at, s.end] as Range));
  const found: FontSite[] = [];
  let readUntil = 0;
  file.tokens.forEach((token, i) => {
    const before = file.tokens[i - 1]?.text;
    if (token.kind !== "name" || !/^[A-Z]/.test(token.text) || before === "." || before === "\\") return;
    if (file.tokens[i + 1]?.text !== "." || token.start < readUntil || read(token.start)) return;
    const named = [file.tokens[i + 2]?.text, file.tokens[i + 4]?.text].some((n) => helperNames.has(n ?? ""));
    if (!named) return;
    const expression = expressionAt(file, token.start);
    if (!expression) return;
    readUntil = expression.end;
    for (const value of fontValues(expression)) {
      if ("helper" in value) found.push({ value, at: expression.start, end: expression.end });
    }
  });
  return found;
}

/** The helper a reference names: on the type it's written on (`Self` being the type it's written in), or, written
 * `.name`, on the type the place expects and then each font type. A call names a function before a property. */
function resolve(
  reference: HelperReference,
  site: FontSite,
  tokens: SwiftTokens,
  helpers: Map<string, FontHelper>,
): FontHelper | undefined {
  const owner =
    reference.owner === "Self" ? ownerAt(tokens, tokenIndexAt(tokens, reference.at)) : reference.owner;
  const owners = owner ? [owner] : [...(site.expects ? [site.expects] : []), ...FONT_TYPES];
  const kinds = reference.called ? [true, false] : [false, true];
  for (const o of owners) {
    for (const isFunction of kinds) {
      const helper = helpers.get(helperKey(o, reference.name, isFunction));
      if (helper) return helper;
    }
  }
  return undefined;
}

/** A use of `helper`, with the size and weight its call passes or a change after it sets. Named after the helper,
 * plus what the use changes: `brand 24 bold`. */
function helperUse(helper: FontHelper, reference: HelperReference): TypeUse {
  const passed = callArguments(reference.args);
  const weight = reference.weight ?? passed.weight ?? helper.font.weight;
  const size = reference.size ?? helper.font.size ?? (helper.sizeParameter ? passed.size : undefined);
  const name = [
    helper.name,
    size === helper.font.size ? undefined : size,
    weight === helper.font.weight ? undefined : weightLabel(weight),
  ].filter((part) => part !== undefined);
  // A use changing the helper's font is a style of its own whose other values are the helper's, so editing them
  // would change the helper too; what the use sets is written at the use, one of many.
  const { locations, ...font } = helper.font;
  return {
    ...font,
    ...(size === undefined ? {} : { size }),
    weight,
    style: name.join(" "),
    ...(name.length === 1 && locations && { locations }),
  };
}

/** The size and weight a helper call passes: labelled (`size: 17`, `weight: .bold`) or not (`17`, `.bold`). */
function callArguments(args: Argument[]): { size?: number; weight?: string } {
  const found: { size?: number; weight?: string } = {};
  for (const { label, value } of args) {
    const sizeArgument = label === undefined ? found.size === undefined : SIZE_LABELS.has(label);
    if (sizeArgument && value.kind === "number") found.size = value.value;
    const weightArgument = label === undefined || label === "weight";
    if (weightArgument && value.kind === "member" && WEIGHTS.has(value.name)) found.weight = value.name;
  }
  return found;
}

/** Whether an offset falls inside any of `ranges`, by binary search over them merged. */
function within(ranges: Range[]): (at: number) => boolean {
  const merged: Range[] = [];
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  const starts = merged.map(([start]) => start);
  return (at) => at < (merged[firstAtOrAfter(starts, at + 1) - 1]?.[1] ?? Number.NEGATIVE_INFINITY);
}
