/**
 * Every way an app's code can name one of its tokens, each leading to the token's key and value: the index a file's
 * uses are looked up in. Built once per framework, and again for a view whose changes redefine tokens.
 */

import { isNamedStyle, keyedColors, keyedStyles, keyedThemes } from "../output/token-names.js";
import type { ColorToken, DesignTokens, FrameworkId, Platform } from "../scan/types.js";
import type { TokenRef, TypeValue } from "./schema.js";

export type Named =
  | { kind: "color"; token: TokenRef; value: string; declared?: Declared }
  | { kind: "typeStyle"; token: TokenRef; value: TypeValue; declared?: Declared }
  /** A color or text style read from a theme declared outside the app, so its value isn't in the code. */
  | { kind: "unresolved"; of: "color" | "typeStyle"; token: TokenRef };

/** Where a token is declared, so its own declaration isn't counted as a use of it. */
interface Declared {
  file: string;
  line: number;
}

export interface TokenIndex {
  /** By a dotted name the code writes: `Theme.brand`, `colors.blue[500]`, `R.color.brand`. */
  paths: Map<string, Named[]>;
  /** By an implicit member, without its dot: `.brand` in Swift. */
  members: Map<string, Named[]>;
  /** By a call given one string, as written with no spaces: `Color("Brand")`. */
  calls: Map<string, Named[]>;
  /** Custom font families, which a font's own name (`"Inter-Bold"`) can name. */
  fonts: string[];
  /** The places tokens' values are written, to tell a token's definition from a value written in place. */
  definitions: Map<string, [number, number][]>;
  /** Each token's key, by its group (colours of one theme, or text styles) and what it is, a line apart: for a view
   * to keep the keys its base gave. */
  keys: Map<string, string>;
  /** Colors the app's themes declare, by their member's name: read through whichever theme the user picks (`theme.tintColor`,
   * `colors.tintColor`), so through a variable of any name. */
  themed: Map<string, Named[]>;
  /** Theme objects the code reads from that are declared outside the app (`CompanyTheme`). */
  outside: readonly string[];
}

/** A reference that's a call on a name, `colorResource(R.color.brand)`, by what it's called with. */
const NAMED_CALL = /^[\w.]+\(([\w.[\]]+)\)$/;
/** A call given one string: `Color("Brand")`, `UIColor(named: "Brand")` written as `UIColor("Brand")`. */
const STRING_CALL = /^([A-Za-z_][\w.]*)\(\s*(?:named:\s*)?"([^"\n]+)"\s*\)$/;
/** Swift types whose members a value of their type names without the type: `.ink` for `Color.ink`. */
const IMPLICIT_OWNER = /^(?:Color|UIColor|ShapeStyle|Font|UIFont)\.(\w+)$/;

const add = (map: Map<string, Named[]>, key: string, named: Named) => {
  const same = map.get(key);
  if (!same) map.set(key, [named]);
  else if (!same.includes(named)) same.push(named);
};

/** `Color("Brand")` as the index keys a call: no spaces inside it. */
export const callKey = (name: string, text: string) => `${name}("${text}")`;

/** An asset colour as Xcode's generated symbol names it: `AccentColor` is `.accentColor`. */
const assetSymbol = (name: string) => name.charAt(0).toLowerCase() + name.slice(1).replace(/[^\w]/g, "");

function addReference(index: TokenIndex, reference: string, named: Named, framework: FrameworkId): void {
  const call = STRING_CALL.exec(reference);
  if (call) add(index.calls, callKey(call[1] ?? "", call[2] ?? ""), named);
  const inner = NAMED_CALL.exec(reference)?.[1];
  if (inner) add(index.paths, inner, named);
  else if (!call) add(index.paths, reference, named);
  const member = framework === "swiftui" ? IMPLICIT_OWNER.exec(reference)?.[1] : undefined;
  if (member) add(index.members, member, named);
}

function addColor(index: TokenIndex, color: ColorToken, token: TokenRef, framework: FrameworkId): void {
  if (!color.reference) return;
  const declared = color.line ? { file: color.source, line: color.line } : undefined;
  const named: Named = { kind: "color", token, value: color.light, ...(declared && { declared }) };
  addReference(index, color.reference, named, framework);
  if (framework === "swiftui" && color.kind === "asset") {
    add(index.members, assetSymbol(color.name), named);
    add(index.paths, `Color.${assetSymbol(color.name)}`, named);
  }
  for (const location of [color.locations?.light, color.locations?.dark])
    if (location) addDefinition(index, location);
}

function addDefinition(
  index: TokenIndex,
  { file, start, end }: { file: string; start: number; end: number },
): void {
  const spans = index.definitions.get(file);
  if (spans) spans.push([start, end]);
  else index.definitions.set(file, [[start, end]]);
}

/** Hands out keys that stay what `previous` gave each token, so a view and its base name a token alike; a token new
 * to the view gets its own key, numbered when one of the base's tokens holds it already. */
function keeper(index: TokenIndex, previous: TokenIndex | undefined) {
  const held = new Map<string, Set<string>>();
  for (const [id, key] of previous?.keys ?? []) {
    const group = id.slice(0, id.indexOf("\n"));
    held.set(group, (held.get(group) ?? new Set()).add(key));
  }
  return (group: string, identity: string, fresh: string): string => {
    const id = `${group}\n${identity}`;
    let key = previous?.keys.get(id);
    if (key === undefined) {
      const taken = held.get(group) ?? new Set<string>();
      key = fresh;
      for (let n = 2; taken.has(key); n++) key = `${fresh}-${n}`;
      held.set(group, taken.add(key));
    }
    index.keys.set(id, key);
    return key;
  };
}

/** The index of `tokens`, as `framework`'s code on `platform` names them, keeping the keys `previous` gave. */
export function tokenIndex(
  tokens: DesignTokens,
  framework: FrameworkId,
  platform: Platform,
  previous?: TokenIndex,
  outside: readonly string[] = [],
): TokenIndex {
  const index: TokenIndex = {
    paths: new Map(),
    members: new Map(),
    calls: new Map(),
    fonts: tokens.fonts,
    definitions: new Map(),
    keys: new Map(),
    themed: new Map(),
    outside,
  };
  // A default color another theme declares too is the same member in each (`ColorSet.tintColor`), so which one the
  // code reads depends on the theme the user picks.
  const inThemes = new Set((tokens.themes ?? []).flatMap((t) => t.colors.flatMap((c) => c.reference ?? [])));
  const keyOf = keeper(index, previous);
  const colorRef = (color: ColorToken, theme: string | undefined, fresh: string): TokenRef => ({
    key: keyOf(`color|${theme ?? ""}`, color.reference ?? color.name, fresh),
    ...(theme && { theme }),
    ...(color.reference && { reference: color.reference }),
  });
  for (const { color, key } of keyedColors(tokens.colors)) {
    const themed = color.reference !== undefined && inThemes.has(color.reference);
    const token = { ...colorRef(color, undefined, key), ...(themed && { themed: true as const }) };
    addColor(index, color, token, framework);
    const member = color.reference?.split(".").at(-1);
    if (themed && member) add(index.themed, member, { kind: "color", token, value: color.light });
  }
  for (const { theme } of keyedThemes(tokens.themes ?? []))
    for (const { color, key } of keyedColors(theme.colors))
      addColor(index, color, colorRef(color, theme.name, key), framework);
  for (const { style, key, values } of keyedStyles(tokens.typeStyles, platform)) {
    if (!isNamedStyle(style)) continue;
    const named: Named = {
      kind: "typeStyle",
      token: {
        key: keyOf("style|", `${style.reference ?? ""}|${style.name}`, key),
        ...(style.reference && { reference: style.reference }),
      },
      value: {
        ...(values.fontFamily && { family: values.fontFamily }),
        ...(values.fontSize !== undefined && { size: values.fontSize }),
        ...(values.fontWeight !== undefined && { weight: values.fontWeight }),
      },
    };
    for (const location of Object.values(style.locations ?? {})) addDefinition(index, location);
    if (style.reference) addReference(index, style.reference, named, framework);
    else if (framework === "swiftui" && style.kind === "text-style") add(index.members, style.name, named);
  }
  return index;
}
