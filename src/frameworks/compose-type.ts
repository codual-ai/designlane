/**
 * A Compose app's type scale: the roles its Material `Typography` sets (`bodyLarge = TextStyle(…)`), Material's
 * defaults for roles the code reads without setting, the app's own named styles (`val Heading = TextStyle(…)`), and
 * styles written inline.
 */

import type { TypeFindings, TypeUse } from "../scan/type-scale.js";
import type { CodeSpan, TypeLocations, TypeStyle, ValueKind, ValueLocation } from "../scan/types.js";
import { familyOf, fontFamilies } from "./compose-fonts.js";
import {
  type Argument,
  assignedName,
  callArguments,
  declaredIn,
  isDeclared,
  prefixesOf,
  Spans,
} from "./kotlin-calls.js";
import { type KotlinSource, spanIn } from "./kotlin-sources.js";
import { MATERIAL_DEFAULTS, SYSTEM, sizeOf, weightOf } from "./material-type.js";
import { through, valueAt, withLocations } from "./value-locations.js";

interface Style {
  family?: string;
  size?: number;
  weight?: string;
  /** Where each value is written: in the call, or, through the name of the style it copies, in that style. */
  locations: TypeLocations;
}

/** The shared type scale's findings, plus the styles the app names: Material roles and its own. */
export interface ComposeType extends TypeFindings {
  named: TypeStyle[];
}

export function composeType(sources: KotlinSource[]): ComposeType {
  const families = fontFamilies(sources);
  const bases = namedStyles(sources, families);
  const typography = typographyRoles(sources, families, bases);
  const roles = usedRoles(sources, typography);
  const uses = inlineStyles(sources, families, bases, typography.spans);
  const helperFonts: TypeUse[] = [...new Set(families.values())].map((family) => ({
    kind: "custom",
    family,
    weight: "regular",
  }));
  return { named: [...roles, ...countUses(sources, appStyles(bases))], uses, helperFonts };
}

/** How much of a call's start is read to tell what it is. */
const MAX_CALL_HEAD = 200;

/** The styles the code has read so far by name, for a `.copy(…)` of one to start from. */
type Bases = Map<string, Style>;

/** What a `TextStyle(…)`, or a `.copy(…)` of another style, sets. A copy starts from what it copies: a Material role
 * (`baseline.titleLarge`) from its default, a style the app names from that style. */
function styleAt(
  source: KotlinSource,
  at: number,
  families: Map<string, string>,
  bases: Bases,
): Style | undefined {
  const call = source.code.slice(at, at + MAX_CALL_HEAD).match(/^(?:TextStyle|([\w.]+)\.copy)\s*\(/);
  if (!call) return undefined;
  const copied = call[1] ?? "";
  const material = copied ? MATERIAL_DEFAULTS[copied.split(".").at(-1) ?? ""] : undefined;
  const named = copied && !material ? bases.get(copied) : undefined;
  const { args } = callArguments(source, at + call[0].length - 1);
  const arg = (name: string) => args.find((a) => a.name === name);
  const [family, size, weight] = [arg("fontFamily"), arg("fontSize"), arg("fontWeight")];
  const points = size ? sizeOf(size.value) : undefined;
  const inherited = named ? copiedLocations(named.locations, spanIn(source, at, at + copied.length)) : {};
  // A size the copy sets that can't be read replaces the base's, so the base's place is no longer the style's.
  if (size && points === undefined) delete inherited.fontSize;
  const locations: TypeLocations = {
    ...inherited,
    ...(family && { fontFamily: argumentAt(source, family, familyKind(family.value)) }),
    ...(points !== undefined && size && { fontSize: argumentAt(source, size, "expression") }),
    ...(weight && { fontWeight: argumentAt(source, weight, "expression") }),
  };
  return {
    ...(material ?? named),
    ...(family && { family: familyOf(family.value, families) }),
    ...(points !== undefined && { size: points }),
    ...(weight && { weight: weightOf(weight.value) }),
    locations,
  };
}

/** Where the values a copy takes from the style it copies are written: in that style, through the name it's copied
 * by. */
const copiedLocations = (locations: TypeLocations, name: CodeSpan): TypeLocations =>
  Object.fromEntries(Object.entries(locations).map(([key, location]) => [key, through(location, [name])]));

/** Where an argument's value is written, as a value of `kind`. */
const argumentAt = (source: KotlinSource, argument: Argument, kind: ValueKind) =>
  valueAt(spanIn(source, argument.at, argument.at + argument.value.length), kind);

/** A name, `Inter` or `Theme.Inter`. */
const DOTTED_NAME = /^[A-Za-z_]\w*(?:\.\w+)*$/;

/** A family named by the app's own `FontFamily` constant (`Inter`) is an identifier; one written out
 * (`FontFamily.Serif`, `FontFamily(Font(…))`) is an expression. */
const familyKind = (written: string): ValueKind =>
  DOTTED_NAME.test(written) && !written.startsWith("FontFamily.") ? "identifier" : "expression";

interface Typography {
  roles: Map<string, TypeStyle>;
  /** `Typography(defaultFontFamily = …)`, which every role it doesn't set takes. */
  defaultFamily?: Family;
  /** Where each `Typography(…)` is written, so its styles aren't counted again as written inline. */
  spans: Map<KotlinSource, Spans>;
}

/** A role as a text style, its family the one the whole typography sets (`defaultFamily`) when it sets none. */
const roleStyle = (role: string, style: Style, defaultFamily: Family): TypeStyle => {
  const familyAt = style.locations.fontFamily ?? (style.family ? undefined : defaultFamily.location);
  const locations = { ...style.locations, ...(familyAt && { fontFamily: familyAt }) };
  return {
    name: role,
    kind: "text-style",
    family: style.family ?? defaultFamily.name,
    ...(style.size !== undefined && { size: style.size }),
    weight: style.weight ?? "regular",
    reference: `MaterialTheme.typography.${role}`,
    uses: 0,
    ...withLocations(locations),
  };
};

/** A family a whole type scale takes, and where it's written. */
interface Family {
  name: string;
  location?: ValueLocation;
}

const SYSTEM_FAMILY: Family = { name: SYSTEM };

/** Every `val Name = TextStyle(…)` the app declares, by how the code refers to it; the first of a name is the app's
 * own, as sources come with the app's code first. */
function namedStyles(sources: KotlinSource[], families: Map<string, string>): Bases {
  const bases: Bases = new Map();
  for (const source of sources) {
    for (const m of source.code.matchAll(/(?<![\w.])TextStyle\s*\(/g)) {
      const at = m.index ?? 0;
      const name = assignedName(source.code, at);
      const owner = name ? declaredIn(source, at) : undefined;
      const style = owner !== undefined ? styleAt(source, at, families, bases) : undefined;
      const reference = owner ? `${owner}.${name}` : name;
      if (name && reference && style && !bases.has(reference)) bases.set(reference, style);
    }
  }
  return bases;
}

/** The roles each Material `Typography(…)` sets, the first setting of each the app's own, as in `namedStyles`. */
function typographyRoles(sources: KotlinSource[], families: Map<string, string>, bases: Bases): Typography {
  const found: Typography = { roles: new Map(), spans: new Map() };
  for (const source of sources) {
    for (const m of source.code.matchAll(/(?<![\w.])Typography\s*\(/g)) {
      const at = m.index ?? 0;
      if (isDeclared(source.code, at)) continue;
      const { args, close } = callArguments(source, at + m[0].length - 1);
      const spans = found.spans.get(source) ?? new Spans();
      spans.add(at + 1, close);
      found.spans.set(source, spans);
      const defaultArg = args.find((a) => a.name === "defaultFontFamily");
      const family: Family = defaultArg
        ? {
            name: familyOf(defaultArg.value, families),
            location: argumentAt(source, defaultArg, familyKind(defaultArg.value)),
          }
        : SYSTEM_FAMILY;
      if (defaultArg && !found.defaultFamily) found.defaultFamily = family;
      for (const arg of args) {
        const role = arg.name ?? "";
        const style = role in MATERIAL_DEFAULTS ? styleAt(source, arg.at, families, bases) : undefined;
        if (style && !found.roles.has(role)) found.roles.set(role, roleStyle(role, style, family));
      }
    }
  }
  return found;
}

/** Every role the code reads, with its uses: as set, or as Material's default. */
function usedRoles(sources: KotlinSource[], { roles, defaultFamily }: Typography): TypeStyle[] {
  for (const { code } of sources) {
    for (const m of code.matchAll(/\bMaterialTheme\.typography\.(\w+)\b/g)) {
      const role = m[1] ?? "";
      const defaults = MATERIAL_DEFAULTS[role];
      const style =
        roles.get(role) ??
        (defaults && roleStyle(role, { ...defaults, locations: {} }, defaultFamily ?? SYSTEM_FAMILY));
      if (!style) continue;
      roles.set(role, style);
      style.uses++;
    }
  }
  return [...roles.values()];
}

/** `TextStyle(…)`s written where they're used: outside the type scale, and not ones the app names. */
function inlineStyles(
  sources: KotlinSource[],
  families: Map<string, string>,
  bases: Bases,
  scale: Typography["spans"],
): TypeUse[] {
  const uses: TypeUse[] = [];
  for (const source of sources) {
    const inScale = scale.get(source)?.start();
    for (const m of source.code.matchAll(/(?<![\w.])TextStyle\s*\(/g)) {
      const at = m.index ?? 0;
      if (inScale?.contains(at) || isDeclared(source.code, at)) continue;
      // A style the app names is read with the bases, as one of its own.
      if (assignedName(source.code, at) && declaredIn(source, at) !== undefined) continue;
      const style = styleAt(source, at, families, bases);
      if (!style || isEmpty(style)) continue;
      uses.push({
        kind: style.family && style.family !== SYSTEM ? "custom" : "system",
        family: style.family ?? SYSTEM,
        ...(style.size !== undefined && { size: style.size }),
        weight: style.weight ?? "regular",
        file: source.rel,
      });
    }
  }
  return uses;
}

/** A style setting none of the values a type scale is made of (only a colour, say). */
const isEmpty = (style: Style) =>
  style.size === undefined && style.family === undefined && style.weight === undefined;

/** The app's named styles that set any of a type scale's values, as its own. */
function appStyles(bases: Bases): Map<string, TypeStyle> {
  const styles = new Map<string, TypeStyle>();
  for (const [reference, style] of bases) {
    if (isEmpty(style)) continue;
    const name = reference.split(".").at(-1) ?? reference;
    styles.set(reference, { ...roleStyle(name, style, SYSTEM_FAMILY), kind: "app", reference });
  }
  return styles;
}

/** The app's named styles, each with how many times the code names it. */
function countUses(sources: KotlinSource[], styles: Map<string, TypeStyle>): TypeStyle[] {
  if (styles.size === 0) return [];
  for (const { code } of sources)
    for (const m of code.matchAll(/(?<![\w.])((?:[A-Za-z_]\w*\.)*[A-Za-z_]\w*)\b(?!\s*=[^=])/g)) {
      // `Heading.copy(…)` is a use of `Heading`.
      for (const path of prefixesOf(m[1] ?? "")) {
        const style = styles.get(path);
        if (style) {
          style.uses++;
          break;
        }
      }
    }
  return [...styles.values()];
}
