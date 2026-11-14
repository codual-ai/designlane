/**
 * A SwiftUI app's selectable themes: types conforming to one protocol of colours (`protocol ColorSet { var tintColor:
 * Color { get } }`), each the light or dark version of a theme (`DesertLight` and `DesertDark`, or a `scheme: .dark`
 * member). The first theme the code declares is the app's default; every other one is a theme of its own.
 */

import type { NamedColor, ThemeFindings } from "../scan/palette.js";
import type { ValueLocation } from "../scan/types.js";
import { lineNumbers, locator } from "./source-text.js";
import { structs } from "./swift-source.js";
import { type SwiftTokens, tokenIndexAt } from "./swift-tokens.js";
import { type SwiftSource, tokensOf } from "./swiftui-sources.js";
import { valueAt, withLocations } from "./value-locations.js";

const PROTOCOL = /\bprotocol\s+([A-Z]\w*)/g;
/** A protocol's colour: `var tintColor: Color { get set }`. */
const COLOR_REQUIREMENT = /\bvar\s+(\w+)\s*:\s*(?:SwiftUI\.)?(?:Color|UIColor|NSColor)\b/g;
/** A stored member and where its value starts: `public var tintColor: Color = `. */
const MEMBER = /\b(?:let|var)\s+(\w+)\s*(?::\s*[\w.]+\s*)?=\s*/g;
/** A member set to a colour scheme: `var scheme: ColorScheme = .dark`, not `var weight: Font.Weight = .light`. */
const SCHEME_MEMBER = /scheme/i;
const SCHEME_VALUE = /\.(light|dark)\b/y;
/** `Light` or `Dark` as a whole word of a type's name: `DesertDark`, `DarkBlue`, not `Darkroom`. */
const SCHEME_WORD = /(Light|Dark)(?![a-z])/;
/** The platform colours whose value never changes, which a theme may set a colour to. */
const FIXED = /(?:\b(?:Color|UIColor|NSColor))?\.(white|black|clear)\b(?!\s*[.(])/y;
const FIXED_VALUES: Record<string, string> = { white: "#ffffff", black: "#000000", clear: "#00000000" };
/** How far after `protocol Name` its body's `{` can be. */
const MAX_HEADER_TOKENS = 64;

/** A colour value the code writes at an offset of a file, as `#rrggbb[aa]`, and where it ends, when it does. */
export type ColorReader = (source: SwiftSource, offset: number) => { hex: string; end?: number } | undefined;

/** A colour a theme type sets, and where. */
interface ThemeValue {
  hex: string;
  line: number;
  start: number;
  location?: ValueLocation;
}

export interface SwiftThemes {
  /** The default theme's colours, each known by its protocol's member (`ColorSet.tintColor`). */
  named: NamedColor[];
  themes: ThemeFindings[];
  /** Where each theme's colour values start, by file, so they aren't read again as colours of their own. */
  valueStarts: Map<string, Set<number>>;
}

/** One type conforming to a colour protocol: one scheme of one theme. */
interface ThemeType {
  protocol: string;
  theme: string;
  scheme?: "light" | "dark";
  source: SwiftSource;
  colors: Map<string, ThemeValue>;
}

/** The themes of every colour protocol whose conforming types include a light and a dark one; others, like
 * `PrimaryButton` and `SecondaryButton` sharing `ButtonColors`, are just types with colours. */
export function swiftThemes(sources: SwiftSource[], colorAt: ColorReader): SwiftThemes {
  const protocols = colorProtocols(sources);
  const byProtocol = new Map<string, ThemeType[]>();
  for (const source of sources) {
    for (const type of themeTypes(source, protocols, colorAt)) {
      const types = byProtocol.get(type.protocol);
      if (types) types.push(type);
      else byProtocol.set(type.protocol, [type]);
    }
  }
  const result: SwiftThemes = { named: [], themes: [], valueStarts: new Map() };
  const themes = new Map<string, ThemeFindings>();
  for (const [protocol, types] of byProtocol) {
    const schemes = new Set(types.map((type) => type.scheme));
    if (!schemes.has("light") || !schemes.has("dark")) continue;
    for (const type of types) {
      const starts = result.valueStarts.get(type.source.rel) ?? new Set<number>();
      for (const { start } of type.colors.values()) starts.add(start);
      result.valueStarts.set(type.source.rel, starts);
    }
    const [first, ...others] = pairedThemes(types);
    const members = protocols.get(protocol) ?? [];
    if (first) result.named.push(...themeColors(protocol, members, first[1]));
    for (const [name, pair] of others) {
      const theme = themes.get(name) ?? { name, colors: [] };
      theme.colors.push(...themeColors(protocol, members, pair));
      themes.set(name, theme);
    }
  }
  result.themes = [...themes.values()];
  return result;
}

/** Each protocol declaring colours, with them in the order it declares them. */
function colorProtocols(sources: SwiftSource[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const source of sources) {
    for (const m of source.code.matchAll(PROTOCOL)) {
      const body = bodyAfter(tokensOf(source), (m.index ?? 0) + m[0].length);
      if (!body) continue;
      const members = [...source.code.slice(body.start, body.end).matchAll(COLOR_REQUIREMENT)].map(
        (r) => r[1] ?? "",
      );
      if (members.length > 0 && m[1]) found.set(m[1], members);
    }
  }
  return found;
}

/** The text range inside the `{ … }` that follows `offset`, when it opens within a declaration's header. */
function bodyAfter(file: SwiftTokens, offset: number): { start: number; end: number } | undefined {
  const first = tokenIndexAt(file, offset);
  for (let k = first; k < file.tokens.length && k < first + MAX_HEADER_TOKENS; k++) {
    const token = file.tokens[k];
    if (!token || token.text === "}") return undefined;
    if (token.text !== "{") continue;
    const close = file.match[k] ?? -1;
    return {
      start: token.end,
      end: close === -1 ? file.text.length : (file.tokens[close]?.start ?? token.end),
    };
  }
  return undefined;
}

/** A struct conforming to a colour protocol, and what its body sets as the members are read. */
interface Conforming {
  name: string;
  protocol: string;
  members: Set<string>;
  scheme?: "light" | "dark";
  found: (ThemeValue & { member: string })[];
}

/** The structs in `source` conforming to a colour protocol, with the colours they set directly in their body. Each
 * member is read once, and given to the struct whose body it's directly in. */
function themeTypes(
  source: SwiftSource,
  protocols: Map<string, string[]>,
  colorAt: ColorReader,
): ThemeType[] {
  const tokens = tokensOf(source);
  const byBody = new Map<number, Conforming>();
  for (const struct of structs(source.code)) {
    const protocol = struct.conformances.map((c) => c.split(".").at(-1) ?? "").find((c) => protocols.has(c));
    if (!protocol) continue;
    const members = new Set(protocols.get(protocol));
    byBody.set(tokenIndexAt(tokens, struct.open), { name: struct.name, protocol, members, found: [] });
  }
  if (byBody.size === 0) return [];
  const declarations: number[] = [];
  const found: Conforming["found"] = [];
  const span = locator(source.rel, source.text);
  for (const m of source.code.matchAll(MEMBER)) {
    const declared = m.index ?? 0;
    const type = byBody.get(tokens.enclosing[tokenIndexAt(tokens, declared)] ?? -1);
    if (!type) continue;
    const start = declared + m[0].length;
    const member = m[1] ?? "";
    SCHEME_VALUE.lastIndex = start;
    const scheme = SCHEME_MEMBER.test(member) ? SCHEME_VALUE.exec(source.code)?.[1] : undefined;
    if (scheme === "light" || scheme === "dark") type.scheme = scheme;
    const read = type.members.has(member)
      ? (colorAt(source, start) ?? fixedColor(source.code, start))
      : undefined;
    if (!read) continue;
    const value: ThemeValue & { member: string } = {
      member,
      hex: read.hex,
      start,
      line: 1,
      ...(read.end ? { location: valueAt(span(start, read.end), "expression") } : {}),
    };
    type.found.push(value);
    found.push(value);
    declarations.push(declared);
  }
  // Every line found in one pass over the file, since there may be thousands of types.
  for (const [i, line] of lineNumbers(source.text, declarations).entries()) {
    const value = found[i];
    if (value) value.line = line;
  }
  return [...byBody.values()].map((type) => themeType(source, type));
}

/** A conforming struct as one scheme of a theme: `DesertDark` is `Desert`'s dark one, unless a member says otherwise. */
function themeType(source: SwiftSource, { name, protocol, scheme, found }: Conforming): ThemeType {
  const word = name.match(SCHEME_WORD)?.[1]?.toLowerCase();
  const own = scheme ?? (word === "light" || word === "dark" ? word : undefined);
  return {
    protocol,
    // Types named just `Light` and `Dark` are one theme, named for their protocol.
    theme: name.replace(SCHEME_WORD, "") || protocol,
    ...(own ? { scheme: own } : {}),
    source,
    colors: new Map(found.map(({ member, ...value }) => [member, value])),
  };
}

/** A platform colour that is the same in every scheme, `.white`, written at `offset` and not changed after
 * (`.white.opacity(0.5)`). */
function fixedColor(code: string, offset: number): { hex: string; end: number } | undefined {
  FIXED.lastIndex = offset;
  const name = FIXED.exec(code)?.[1];
  const hex = name ? FIXED_VALUES[name] : undefined;
  return hex ? { hex, end: FIXED.lastIndex } : undefined;
}

/** Each theme with its light and dark type, in the order the code declares them; a type with no scheme is light. */
function pairedThemes(types: ThemeType[]): [string, { light?: ThemeType; dark?: ThemeType }][] {
  const themes = new Map<string, { light?: ThemeType; dark?: ThemeType }>();
  for (const type of types) {
    const pair = themes.get(type.theme) ?? {};
    if (type.scheme === "dark") pair.dark ??= type;
    else pair.light ??= type;
    themes.set(type.theme, pair);
  }
  return [...themes];
}

/** A theme's colours, each its light type's value with its dark type's, known by the protocol's member. */
function themeColors(
  protocol: string,
  members: string[],
  { light, dark }: { light?: ThemeType; dark?: ThemeType },
): NamedColor[] {
  return members.flatMap((member) => {
    const lightValue = light?.colors.get(member);
    const darkValue = dark?.colors.get(member);
    const first = lightValue ?? darkValue;
    const type = lightValue ? light : dark;
    if (!first || !type) return [];
    const darkAt = lightValue && darkValue?.location;
    return [
      {
        name: member,
        light: first.hex,
        ...(lightValue && darkValue && darkValue.hex !== lightValue.hex ? { dark: darkValue.hex } : {}),
        source: type.source.rel,
        reference: `${protocol}.${member}`,
        line: first.line,
        kind: "code",
        ...withLocations({
          ...(first.location && { light: first.location }),
          ...(darkAt && { dark: darkAt }),
        }),
      },
    ];
  });
}
