import { type ColorFindings, type NamedColor, nameKey } from "../scan/palette.js";
import { normalizeHex, rgbToHex } from "../scan/tokens.js";
import { lineNumbers, locator } from "./source-text.js";
import { memberOf, ownerAt, qualifiedOwnerAt } from "./swift-owners.js";
import { tokenIndexAt } from "./swift-tokens.js";
import { matchesInCode, matchesPerLine, type SwiftSource, tokensOf } from "./swiftui-sources.js";
import { swiftThemes } from "./swiftui-themes.js";
import { valueAt } from "./value-locations.js";

// Colour patterns are built from these parts so each reads like the Swift it matches.
/** `Color(`, its UIKit and AppKit forms, or `.init(` where a colour is declared (`let ink: Color = .init(hex: …)`). */
const COLOR_CALL = String.raw`(?:\b(?:Color|UIColor|NSColor)|\.init)\(\s*`;
const NUMBER = String.raw`(\d+(?:\.\d+)?)`;
/** A channel as Swift writes it: a 0–1 number, or `187 / 255`. */
const CHANNEL = String.raw`${NUMBER}(?:\s*\/\s*(255)(?:\.0)?)?`;
const NEXT = String.raw`\s*,\s*`;
const labelled = (label: string, value: string) => String.raw`${label}:\s*${value}`;
const ALPHA = `(?:${NEXT}${labelled("(?:opacity|alpha)", NUMBER)})?`;
const pattern = (...parts: string[]) => new RegExp(parts.join(""), "g");

/** `Color(red: …)`, its UIKit and AppKit forms, `UIColor(displayP3Red: …)`, `#colorLiteral(…)` and `.init(red: …)`. */
const RGB = pattern(
  String.raw`(?:\b(?:Color|UIColor|NSColor)|#colorLiteral|\.init)\(\s*`,
  String.raw`(?:\.(?:sRGB|displayP3|sRGBLinear)${NEXT})?`,
  labelled("(?:red|displayP3Red)", CHANNEL),
  NEXT,
  labelled("green", CHANNEL),
  NEXT,
  labelled("blue", CHANNEL),
  ALPHA,
);
const WHITE = pattern(COLOR_CALL, labelled("white", NUMBER), ALPHA);
const HSB = pattern(
  COLOR_CALL,
  labelled("hue", NUMBER),
  NEXT,
  labelled("saturation", NUMBER),
  NEXT,
  labelled("brightness", NUMBER),
  ALPHA,
);
/** `Color(hex: "#3366E6")` or `Color("#3366E6")`. A bare `Color("Face")` is an asset name, not hex. */
const HEX_TEXT = pattern(COLOR_CALL, String.raw`(?:hex:\s*"#?|"#)([0-9A-Fa-f]{3,8})"`);
/** `Color(hex: 0x3366E6)` or `UIColor(0x3366E6)`. */
const HEX_NUMBER = pattern(COLOR_CALL, String.raw`(?:hex:\s*)?0x([0-9A-Fa-f]{6,8})\b`);
/** A hex helper that takes opacity from the top byte (`a = (argb & 0xFF000000) >> 24`, `(a, r, g, b) = …`) means the
 * app writes eight hex digits opacity first, as on Android; otherwise they're read opacity last, as in CSS. */
const OPACITY_FIRST =
  /\b(?:a|alpha|opacity)\s*=\s*[^\n,;]{0,80}>>\s*24\b|\(\s*a\s*,\s*r\s*,\s*g\s*,\s*b\s*\)\s*=/;

/** `let brand = ` or `static let brand: Color = Color(uiColor: ` just before a colour value (on the same line or the
 * one above), naming it. `static` marks a colour declared on a type rather than a local variable. */
const DECLARED =
  /\b(static\s+)?(?:let|var)\s+(\w+)(?:\s*:\s*([\w.]+))?\s*=(?:\s*(?:Color|UIColor|NSColor)\(\s*(?:uiColor:|nsColor:)?)?\s*$/;
/** How much of the text before a colour value to read for its name. */
const DECLARED_CHARS = 120;

/** `Color("Brand")` and `UIColor(named: "Brand")`, references to asset catalog colours (not `Color("#…")`). */
const ASSET_REFERENCE = /\b(?:Color\(\s*|UIColor\(\s*named:\s*)"([^"#][^"]*)"/g;
/** SwiftGen's generated accessors: `Asset.Colors.Brand.primary.swiftUIColor`. */
const GENERATED_REFERENCE = /\bAsset\.Colou?rs((?:\.\w+)+)/g;
const GENERATED_ACCESSOR = /^(?:color|swiftUIColor|uiColor|nsColor)$/;

/** Where a name is a colour: `Color.x`, `UIColor.x`, `Color(.x)`, or an argument of a colour modifier. */
const COLOR_MEMBER = [
  /\b(?:Color|UIColor|NSColor)\.(\w+)/g,
  /\bColor\(\s*(?:uiColor:\s*|nsColor:\s*)?\.(\w+)/g,
];
const COLOR_ARGUMENTS =
  /\.(?:foregroundColor|foregroundStyle|background|fill|stroke|tint|accentColor|border|listRowBackground)\(([^\n]*?)\)|\.shadow\([^()\n]*\bcolor:\s*\.(\w+)/g;
/** A gradient's colours, read on their own so a modifier around the gradient can't hide them. */
const GRADIENT_COLORS = /\bcolors:\s*\[([^\]\n]*)\]/g;
/** `.red` at the start of an argument (`.foregroundStyle(.red, .blue)`, `cond ? .red : .gray`), not `Color(.red)`,
 * which `COLOR_MEMBER` already counts. */
const IMPLICIT_MEMBER = /(?:^|[\s,?:])\.(\w+)/g;
/** `Theme.surface`, `Theme.Dark.surface` or `Self.surface`: a member of a named type, a colour when that type declares
 * a colour of that name. The member is only looked at, so in a chain each type and the name after it are read. */
const TYPE_MEMBER = /\b([A-Z]\w*)\.(?=(\w+))/g;
/** Types whose members `COLOR_MEMBER` already counts. */
const COLOR_TYPES = new Set(["Color", "UIColor", "NSColor"]);
/** From the first nested call to the end of an argument list. */
const NESTED_CALL = /\w+\(.*$/;

const SWIFTUI_SYSTEM = new Set([
  "black",
  "blue",
  "brown",
  "clear",
  "cyan",
  "gray",
  "green",
  "indigo",
  "mint",
  "orange",
  "pink",
  "purple",
  "red",
  "teal",
  "white",
  "yellow",
  "primary",
  "secondary",
  "accentColor",
]);
const UIKIT_SYSTEM =
  /^(?:(?:secondary|tertiary)?[sS]ystem\w*|(?:secondary|tertiary|quaternary)?[lL]abel|(?:opaque)?[sS]eparator|link|placeholderText|darkText|lightText|darkGray|lightGray)$/;
const isSystem = (name: string) => SWIFTUI_SYSTEM.has(name) || UIKIT_SYSTEM.test(name);

/** Every colour the Swift code defines, names, pastes inline or takes from the platform. */
export function swiftColors(sources: SwiftSource[], assets: NamedColor[]): ColorFindings {
  const opacityFirst = opacityFirstIn(sources);
  const found: ColorFindings = { named: [...assets], references: [], literals: [], system: [] };
  // Colours declared on a type (`static let red`), which take over the platform colour of the same name, and the
  // type each is declared on, so `Theme.surface` counts as a use of `surface`.
  const typeMembers = new Set<string>();
  const owners = new Map<string, Set<string>>();
  const values = new Map(sources.map((source) => [source, [...literals(source, opacityFirst)]]));
  const byStart = new Map(
    [...values].map(([source, found]) => [source, new Map(found.map((value) => [value.start, value]))]),
  );
  const themes = swiftThemes(sources, (source, offset) => byStart.get(source)?.get(offset));
  for (const source of sources) {
    const declaredHere: { color: NamedColor; start: number }[] = [];
    const inTheme = themes.valueStarts.get(source.rel);
    const span = locator(source.rel, source.text);
    for (const { hex, prefix, isInit, start, end } of values.get(source) ?? []) {
      if (inTheme?.has(start)) continue;
      const declared = DECLARED.exec(prefix);
      // `.init(red: …)` is only a colour when declared as one: `let ink: Color = .init(…)`.
      if (isInit && !/Color$/.test(declared?.[3] ?? "")) continue;
      const name = declared?.[2];
      if (!name) {
        found.literals.push({ hex, file: source.rel });
        continue;
      }
      let reference = name;
      if (declared[1]) {
        typeMembers.add(nameKey(name));
        const tokens = tokensOf(source);
        const at = tokenIndexAt(tokens, start);
        const owner = ownerAt(tokens, at);
        if (owner) owners.set(owner, (owners.get(owner) ?? new Set()).add(nameKey(name)));
        reference = memberOf(qualifiedOwnerAt(tokens, at), name);
      }
      const locations = end ? { locations: { light: valueAt(span(start, end), "expression") } } : {};
      declaredHere.push({
        color: { name, light: hex, source: source.rel, reference, kind: "code", ...locations },
        start,
      });
    }
    // The line each colour is declared on, which orders same-named ones in a file by declaration, not by value.
    declaredHere.sort((a, b) => a.start - b.start);
    const lines = lineNumbers(
      source.text,
      declaredHere.map((d) => d.start),
    );
    for (const [i, { color }] of declaredHere.entries()) found.named.push({ ...color, line: lines[i] ?? 1 });
    for (const { m } of matchesPerLine(source, ASSET_REFERENCE)) {
      const name = m[1] ?? "";
      found.references.push({ name, reference: `Color("${name}")` });
    }
    for (const { m } of matchesPerLine(source, GENERATED_REFERENCE)) {
      found.references.push({ name: generatedName(m[1] ?? "") });
    }
  }
  found.named.push(...themes.named);
  if (themes.themes.length > 0) found.themes = themes.themes;
  // A colour declared on a type takes over a platform one (`static let primary` makes `.primary` the app's); a
  // local variable or an asset doesn't: Xcode generates no symbol for an asset named like a platform colour, except
  // `.accentColor`, which is the `AccentColor` asset.
  const appNames = new Set(found.named.map((c) => nameKey(c.name)));
  const assetNames = new Set(found.named.filter((c) => c.kind === "asset").map((c) => nameKey(c.name)));
  const takesOver = (name: string, key: string) =>
    typeMembers.has(key) || (name === "accentColor" && assetNames.has(key));
  for (const source of sources) {
    for (const m of matchesInCode(source, TYPE_MEMBER)) {
      const name = m[2] ?? "";
      let owner = m[1] ?? "";
      if (owner === "Self") {
        const tokens = tokensOf(source);
        owner = ownerAt(tokens, tokenIndexAt(tokens, m.index ?? 0));
      }
      if (!COLOR_TYPES.has(owner) && owners.get(owner)?.has(nameKey(name))) {
        found.references.push({ name, reference: memberOf(owner, name) });
      }
    }
    for (const name of colorNames(source)) {
      const key = nameKey(name);
      if (appNames.has(key) && (!isSystem(name) || takesOver(name, key))) {
        found.references.push({ name });
      } else if (isSystem(name)) {
        found.system.push(name);
      }
    }
  }
  return found;
}

/** Names used where a colour goes, so `case .error:` or a `background` variable is never mistaken for one. */
function* colorNames(source: SwiftSource) {
  for (const pattern of COLOR_MEMBER) for (const { m } of matchesPerLine(source, pattern)) yield m[1] ?? "";
  for (const { m } of matchesPerLine(source, COLOR_ARGUMENTS)) {
    if (m[2]) yield m[2];
    // Only the argument itself: a nested call (`Color(uiColor: .x)`) is counted by `COLOR_MEMBER`.
    const own = (m[1] ?? "").replace(NESTED_CALL, "");
    for (const arg of own.matchAll(IMPLICIT_MEMBER)) yield arg[1] ?? "";
  }
  for (const { m } of matchesPerLine(source, GRADIENT_COLORS)) {
    for (const arg of (m[1] ?? "").matchAll(IMPLICIT_MEMBER)) yield arg[1] ?? "";
  }
}

/** Whether the app's hex helper reads eight digits opacity first (see `OPACITY_FIRST`). */
export const opacityFirstIn = (sources: SwiftSource[]) => sources.some((s) => OPACITY_FIRST.test(s.code));

/** Where the call whose `(` is at `open` ends, just past its `)`, or undefined when it doesn't close. */
export type CallEnd = (open: number) => number | undefined;

/** `CallEnd` from the file's tokens, which every reader of it shares. */
const tokenCallEnd =
  (source: SwiftSource): CallEnd =>
  (open) => {
    const tokens = tokensOf(source);
    return tokens.tokens[tokens.match[tokenIndexAt(tokens, open)] ?? -1]?.end;
  };

/** Colour values anywhere in the file, including calls split over lines, with the text just before each and where
 * the call ends (found by `callEnd`), when it does. */
export function* literals(
  source: SwiftSource,
  opacityFirst: boolean,
  callEnd: CallEnd = tokenCallEnd(source),
) {
  const at = (m: RegExpMatchArray) => {
    const start = m.index ?? 0;
    const prefix = source.text.slice(Math.max(0, start - DECLARED_CHARS), start);
    const end = callEnd(start + m[0].indexOf("("));
    return { prefix, isInit: source.text.startsWith(".init", start), start, ...(end ? { end } : {}) };
  };
  const channel = (value?: string, per255?: string) => Number(value ?? 0) / (per255 ? 255 : 1);
  const alpha = (value?: string) => (value === undefined ? 1 : Number(value));
  for (const m of matchesInCode(source, RGB)) {
    const [r, g, b] = [channel(m[1], m[2]), channel(m[3], m[4]), channel(m[5], m[6])];
    yield { hex: rgbToHex(r, g, b, alpha(m[7])), ...at(m) };
  }
  for (const m of matchesInCode(source, WHITE)) {
    const white = Number(m[1]);
    yield { hex: rgbToHex(white, white, white, alpha(m[2])), ...at(m) };
  }
  for (const m of matchesInCode(source, HSB)) {
    const [r, g, b] = hsbToRgb(Number(m[1]), Number(m[2]), Number(m[3]));
    yield { hex: rgbToHex(r, g, b, alpha(m[4])), ...at(m) };
  }
  // The app's own helper decides the order of eight hex digits, text or number alike.
  const ordered = (digits: string) =>
    digits.length === 8 && opacityFirst ? digits.slice(2) + digits.slice(0, 2) : digits;
  for (const hexPattern of [HEX_TEXT, HEX_NUMBER]) {
    for (const m of matchesInCode(source, hexPattern)) {
      const hex = normalizeHex(ordered(m[1] ?? ""));
      if (hex) yield { hex, ...at(m) };
    }
  }
}

/** Hue, saturation and brightness (each 0–1) as red, green and blue (each 0–1). */
function hsbToRgb(h: number, s: number, v: number): [number, number, number] {
  const k = (n: number) => (n + h * 6) % 6;
  const f = (n: number) => v - v * s * Math.max(0, Math.min(k(n), 4 - k(n), 1));
  return [f(5), f(3), f(1)];
}

/** `.Brand.primary.swiftUIColor` → `primary`: the colour's own name, without SwiftGen's trailing accessor. */
function generatedName(path: string): string {
  const parts = path.split(".").filter(Boolean);
  if (GENERATED_ACCESSOR.test(parts.at(-1) ?? "")) parts.pop();
  return parts.at(-1) ?? "";
}
