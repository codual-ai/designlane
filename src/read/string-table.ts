/**
 * The app's translated strings: every key its strings files declare, in any language, and each key's text in the
 * app's default language, from Xcode string catalogs and `.strings` files, Android `strings.xml`, and the JSON
 * locale files React Native apps load. The default language is English, or Xcode's base localization; a string
 * catalog without English text gives its own source language's. Keys from every file, table and module share one
 * table.
 */

import { z } from "zod";

/** Every key the app's strings files declare, and the default-language text of those that have one. */
export interface StringTable {
  keys: ReadonlySet<string>;
  text: ReadonlyMap<string, string>;
}

/** One strings file's keys, and whether its texts are the default language's. */
export interface StringsFile {
  entries: [key: string, text: string][];
  default: boolean;
}

const LPROJ = /(?:^|\/)([\w-]+)\.lproj\/[^/]+\.strings$/;
const XCSTRINGS = /\.xcstrings$/;
const ANDROID_STRINGS = /(?:^|\/)res\/values(-[\w+-]+)?\/[^/]+\.xml$/;
/** `locales/en.json`, `i18n/en-US.json`, `locales/en/common.json`: by language, and by namespace in a folder. */
const LOCALE_JSON =
  /(?:^|\/)(?:locales?|i18n|translations?|langs?|messages|strings)\/(?:([a-z]{2,3}(?:[-_][A-Za-z]{2,4})?)\.json|([a-z]{2,3}(?:[-_][A-Za-z]{2,4})?)\/([\w-]+)\.json)$/;
/** Languages taken for the default: English, or Xcode's base localization. */
const DEFAULT_LANGUAGE = /^(?:en(?:[-_]\w+)?|Base)$/;
/** How deep a locale file's keys are read; deeper objects are left out. */
const MAX_DEPTH = 32;

/** Whether `rel` is a file of translated strings. */
export const isStringsFile = (rel: string) =>
  LPROJ.test(rel) || XCSTRINGS.test(rel) || ANDROID_STRINGS.test(rel) || LOCALE_JSON.test(rel);

/** A strings file's bytes as text: UTF-16 when it starts with that byte order mark (Xcode often saves `.strings`
 * files so), else UTF-8. */
export function decodeStrings(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  return bytes.toString("utf8");
}

const withoutBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/** A `.strings` file's strings, or its comments, which are blanked so an entry commented out isn't read. */
const STRINGS_TOKEN = /"(?:[^"\\\n]|\\.){0,20000}"|\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*/g;
/** `"key" = "value";`, each part a string with its escapes. */
const STRINGS_ENTRY = /"((?:[^"\\\n]|\\.){0,2000})"\s*=\s*"((?:[^"\\]|\\.){0,20000})"\s*;/g;

const C_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0" };
/** C-style escapes, `\n`, `\"` and `é`, read as `escapes` matches them: a `\u` escape and its four digits, or a
 * backslash and the character after it. */
const unescapeWith = (escapes: RegExp) => (s: string) =>
  s.replace(escapes, (_, c: string) =>
    c.length === 5 ? String.fromCharCode(Number.parseInt(c.slice(1), 16)) : (C_ESCAPES[c] ?? c),
  );
/** Escapes as `.strings` files write them, where `\U00E9` is `é` too. */
const unescapeC = unescapeWith(/\\([uU][0-9a-fA-F]{4}|.)/g);
/** Escapes as Android strings write them. */
const unescapeAndroid = unescapeWith(/\\(u[0-9a-fA-F]{4}|.)/g);

function dotStrings(text: string): [string, string][] {
  const blanked = text.replace(STRINGS_TOKEN, (token) =>
    token.startsWith('"') ? token : " ".repeat(token.length),
  );
  return [...blanked.matchAll(STRINGS_ENTRY)].map((m) => [unescapeC(m[1] ?? ""), unescapeC(m[2] ?? "")]);
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
/** A character reference's character, or undefined past Unicode's last. */
const codePoint = (value: number) => (value <= 0x10ffff ? String.fromCodePoint(value) : undefined);

/** XML's entities: named ones and character references; one naming no character stays as written. */
export const decodeEntities = (s: string, named: Record<string, string> = XML_ENTITIES) =>
  s.replace(
    /&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|\w{1,10});/g,
    (m, name: string) =>
      (name.startsWith("#x")
        ? codePoint(Number.parseInt(name.slice(2), 16))
        : name.startsWith("#")
          ? codePoint(Number(name.slice(1)))
          : named[name]) ?? m,
  );

/** An Android string's text as the app shows it: markup and quotes taken out, entities and escapes read; a CDATA
 * section's text is kept as written. */
const androidText = (s: string) =>
  unescapeAndroid(
    s
      .split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)
      .map((part) =>
        part.startsWith("<![CDATA[") ? part.slice(9, -3) : decodeEntities(part.replace(/<[^>]+>/g, "")),
      )
      .join("")
      .replace(/^"([\s\S]*)"$/, "$1"),
  );

/** A plural's items by quantity, found by scanning, so unclosed ones stay linear. */
function pluralItems(body: string): { quantity: string; text: string }[] {
  const out: { quantity: string; text: string }[] = [];
  const open = /<item\b([^>]*)>/g;
  for (let m = open.exec(body); m; m = open.exec(body)) {
    const close = body.indexOf("</item>", open.lastIndex);
    if (close === -1) break;
    out.push({
      quantity: /quantity\s*=\s*"(\w+)"/.exec(m[1] ?? "")?.[1] ?? "",
      text: body.slice(open.lastIndex, close),
    });
  }
  return out;
}

const NAME = /\bname\s*=\s*"([^"]{1,500})"/;

/** `<string name="k">…</string>` and `<plurals name="k">` (its `other` item, or its first), each by name; one
 * written `<string name="k"/>` is empty. Tags are found by scanning, so a file with unclosed ones stays linear. */
function androidStrings(text: string): [string, string][] {
  const xml = text.replace(/<!--[\s\S]*?(?:-->|$)/g, (c) => " ".repeat(c.length));
  const out: [string, string][] = [];
  const tag = /<(string|plurals)(?=[\s>/])([^>]*)>/g;
  for (let m = tag.exec(xml); m; m = tag.exec(xml)) {
    const [, element, attributes = ""] = m;
    const name = NAME.exec(attributes)?.[1];
    if (attributes.endsWith("/")) {
      if (name && element === "string") out.push([name, ""]);
      continue;
    }
    const close = xml.indexOf(`</${element}>`, tag.lastIndex);
    if (close === -1) break;
    const body = xml.slice(tag.lastIndex, close);
    tag.lastIndex = close;
    if (!name) continue;
    if (element === "string") out.push([name, androidText(body)]);
    else {
      const items = pluralItems(body);
      const item = items.find((i) => i.quantity === "other") ?? items[0];
      if (item) out.push([name, androidText(item.text)]);
    }
  }
  return out;
}

/** A JSON object's string leaves by dotted path: `{ cart: { title: "Cart" } }` holds `cart.title`. */
function leaves(value: unknown, prefix: string, out: [string, string][], depth = 0): void {
  if (typeof value === "string") {
    if (prefix) out.push([prefix, value]);
  } else if (depth < MAX_DEPTH && value && typeof value === "object" && !Array.isArray(value))
    for (const [key, inner] of Object.entries(value))
      leaves(inner, prefix ? `${prefix}.${key}` : key, out, depth + 1);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(withoutBom(text));
  } catch {
    return undefined;
  }
}

const UnitSchema = z.object({ value: z.string() }).loose();
/** A string's text in one language: written once, or as plural variations (`other` is the one shown). */
const LocalizationSchema = z
  .object({
    stringUnit: UnitSchema.optional(),
    variations: z
      .object({
        plural: z.record(z.string(), z.object({ stringUnit: UnitSchema.optional() }).loose()).optional(),
      })
      .loose()
      .optional(),
  })
  .loose();
const CatalogSchema = z
  .object({
    sourceLanguage: z.string().optional(),
    strings: z
      .record(z.string(), z.object({ localizations: z.record(z.string(), z.unknown()).optional() }).loose())
      .optional(),
  })
  .loose();

/** A localization's text, or undefined when it has none written. */
function localizationText(localization: unknown): string | undefined {
  const parsed = LocalizationSchema.safeParse(localization);
  if (!parsed.success) return undefined;
  const plural = parsed.data.variations?.plural;
  return (
    parsed.data.stringUnit?.value ?? (plural?.other ?? Object.values(plural ?? {})[0])?.stringUnit?.value
  );
}

/** The catalog's keys, each with its English text, else its source language's: its own key when it has none
 * written, since a catalog's key is its source text. */
function xcstrings(text: string): [string, string][] {
  const catalog = CatalogSchema.safeParse(parseJson(text));
  if (!catalog.success) return [];
  const source = catalog.data.sourceLanguage ?? "en";
  return Object.entries(catalog.data.strings ?? {}).map(([key, entry]): [string, string] => {
    const localizations = entry.localizations ?? {};
    const english = Object.keys(localizations).find((language) => DEFAULT_LANGUAGE.test(language));
    const value =
      (english && localizationText(localizations[english])) ?? localizationText(localizations[source]) ?? key;
    return [key, value];
  });
}

/** The keys and texts `text`, the strings file `rel`, declares. */
export function stringsFile(rel: string, text: string): StringsFile {
  const content = withoutBom(text);
  if (XCSTRINGS.test(rel)) return { entries: xcstrings(content), default: true };
  const lproj = LPROJ.exec(rel);
  if (lproj) return { entries: dotStrings(content), default: DEFAULT_LANGUAGE.test(lproj[1] ?? "") };
  const android = ANDROID_STRINGS.exec(rel);
  if (android) return { entries: androidStrings(content), default: android[1] === undefined };
  const locale = LOCALE_JSON.exec(rel);
  if (!locale) return { entries: [], default: false };
  const own: [string, string][] = [];
  leaves(parseJson(content), "", own);
  const namespace = locale[3];
  // A namespace's file holds keys the code names with the namespace too: `t("common:save")`.
  const entries = namespace
    ? [...own, ...own.map(([k, v]): [string, string] => [`${namespace}:${k}`, v])]
    : own;
  return { entries, default: DEFAULT_LANGUAGE.test(locale[1] ?? locale[2] ?? "") };
}

/** The table of `files`, in the order given: the first default-language text of a key is its text. */
export function stringTable(files: Iterable<StringsFile>): StringTable {
  const keys = new Set<string>();
  const text = new Map<string, string>();
  for (const file of files)
    for (const [key, value] of file.entries) {
      keys.add(key);
      if (file.default && !text.has(key)) text.set(key, value);
    }
  return { keys, text };
}
