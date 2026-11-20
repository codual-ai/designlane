/**
 * Text styles, spacing and corner radii from Tailwind class names (NativeWind, Uniwind): `text-lg font-semibold`,
 * `p-4`, `rounded-xl`, at Tailwind's own sizes or the ones a config sets.
 */

import ts from "typescript";
import { inherited, type TypeUse } from "../scan/type-scale.js";
import { type JsSource, lineOf, propertyName, unwrapped } from "./js-sources.js";
import { familyAndWeight } from "./rn-fonts.js";
import { eachClassList } from "./tailwind-classes.js";
import { type Located, type Resolver, themeGroups } from "./tailwind-config.js";

/** Tailwind's text sizes, in points. */
const FONT_SIZES: Record<string, number> = {
  xs: 12,
  sm: 14,
  base: 16,
  lg: 18,
  xl: 20,
  "2xl": 24,
  "3xl": 30,
  "4xl": 36,
  "5xl": 48,
  "6xl": 60,
  "7xl": 72,
  "8xl": 96,
  "9xl": 128,
};
const FONT_WEIGHTS: Record<string, string> = {
  thin: "thin",
  extralight: "ultraLight",
  light: "light",
  normal: "regular",
  medium: "medium",
  semibold: "semibold",
  bold: "bold",
  extrabold: "heavy",
  black: "black",
};
/** Tailwind's own family classes and other `font-*` utilities, which name no family the app loads. */
const GENERIC_CLASS = /^(?:sans|serif|mono|italic|not-italic|stretch-\w+|features-\w+|\[.*\])$/;
/** Tailwind's corner radii, in points; `rounded` alone is `DEFAULT`. */
const RADII: Record<string, number> = { sm: 2, DEFAULT: 4, md: 6, lg: 8, xl: 12, "2xl": 16, "3xl": 24 };
/** Tailwind's spacing step, in points: `p-4` is 16. */
const SPACING_STEP = 4;
/** A negative margin (`-m-2`) pulls rather than spaces. */
const SPACING =
  /^(?:p[xytrblse]?|m[xytrblse]?|gap(?:-[xy])?|space-[xy])-(\d+(?:\.\d+)?|\[\d+(?:\.\d+)?px\]|[a-z][\w-]*)$/;
const RADIUS = /^rounded(?:-(?:[trblse]|tl|tr|br|bl|ss|se|es|ee))?(?:-(\w+|\[\d+(?:\.\d+)?px\]))?$/;
/** A CSS length in points: `25px`, `1.5rem`. */
const LENGTH = /^(\d+(?:\.\d+)?)(px|rem)?$/;

export interface TailwindType {
  uses: TypeUse[];
  spacing: number[];
  radii: number[];
}

/** The text styles, spacing and radii Tailwind classes set, at the sizes the project's configs give them;
 * `cssFonts` the families a CSS `@theme` names, by class name. */
export function tailwindType(sources: JsSource[], cssFonts: Record<string, string> = {}): TailwindType {
  const sizes = { ...FONT_SIZES, ...configLengths(sources, "fontSize") };
  const radii = { ...RADII, ...configLengths(sources, "borderRadius") };
  const spacing = configLengths(sources, "spacing");
  const families = { ...cssFonts, ...configFamilies(sources) };
  const found: TailwindType = { uses: [], spacing: [], radii: [] };
  for (const source of sources) {
    eachClassList(source, (node, text) => {
      // Each variant (`md:`, `dark:`) is a style of its own over the classes without one.
      const byVariant = new Map<string, string[]>();
      for (const written of text.split(/\s+/)) {
        const at = written.lastIndexOf(":");
        const variant = written.slice(0, at + 1);
        const c = written.slice(at + 1).replace(/^!|!$/g, "");
        byVariant.set(variant, [...(byVariant.get(variant) ?? []), c]);
      }
      const base = byVariant.get("") ?? [];
      for (const [variant, classes] of byVariant)
        readClasses(
          variant === "" ? classes : [...base, ...classes],
          { sizes, radii, spacing, families },
          found,
          {
            source,
            node,
            only: variant === "" ? undefined : classes,
          },
        );
    });
  }
  return found;
}

interface Scales {
  sizes: Record<string, number>;
  radii: Record<string, number>;
  /** A config's own spacing steps (`gutter: "24px"`), over Tailwind's four points a step. */
  spacing: Record<string, number>;
  families: Record<string, string>;
}

/** Where the classes are written; for a variant, `only` its own classes, which alone add spacing and radii and make
 * it a text style of its own. */
interface At {
  source: JsSource;
  node: ts.Node;
  only?: string[] | undefined;
}

function readClasses(classes: string[], scales: Scales, found: TailwindType, { source, node, only }: At) {
  let size: number | undefined;
  let weight: string | undefined;
  let family: string | undefined;
  // Whether a class sets the family, though not one Designlane can name (`font-mono`).
  let familySet = false;
  let ownText = only === undefined;
  for (const c of classes) {
    const own = only === undefined || only.includes(c);
    // `text-base/5` sets a line height too; `text-[17px]` a size of its own.
    const text = c.match(/^text-([^/]+)(?:\/.+)?$/)?.[1];
    const arbitrary = text?.match(/^\[(\d+(?:\.\d+)?)px\]$/);
    if (arbitrary) scales.sizes[text ?? ""] = Number(arbitrary[1]);
    const fontWord = c.match(/^font-(.+)$/)?.[1];
    const sets =
      (text !== undefined && scales.sizes[text] !== undefined) ||
      (fontWord !== undefined &&
        (FONT_WEIGHTS[fontWord] !== undefined || scales.families[fontWord] !== undefined));
    if (own && sets) ownText = true;
    if (text && scales.sizes[text] !== undefined) size = scales.sizes[text];
    if (fontWord && FONT_WEIGHTS[fontWord]) weight = FONT_WEIGHTS[fontWord];
    else if (fontWord && scales.families[fontWord] !== undefined) {
      family = scales.families[fontWord];
      familySet = true;
    }
    // Tailwind's own stacks: `font-sans` is the platform's font; its serif and monospace stacks have no one family.
    else if (fontWord === "sans") [family, familySet] = ["System", true];
    else if (fontWord === "serif" || fontWord === "mono") [family, familySet] = [undefined, true];
    // `font-[Inter]`, `font-[Open_Sans]`: a family of its own, with spaces written as underscores.
    else if (fontWord?.startsWith("[") && fontWord.endsWith("]"))
      [family, familySet] = [fontWord.slice(1, -1).replace(/_/g, " "), true];
    // A family class neither the config nor a `@theme` declares (`font-inter`) names the family it loads.
    else if (fontWord && /^[a-z][a-z0-9-]*$/.test(fontWord) && !GENERIC_CLASS.test(fontWord)) {
      family = fontWord.replace(/(?:^|-)(\w)/g, (_, c: string) => c.toUpperCase());
      familySet = true;
    }
    if (!own) continue;
    const space = c.match(SPACING)?.[1];
    if (space) {
      const value = space.startsWith("[")
        ? Number.parseFloat(space.slice(1))
        : (scales.spacing[space] ?? Number(space) * SPACING_STEP);
      if (value > 0) found.spacing.push(value);
    }
    const radius = c.match(RADIUS);
    if (radius) {
      const key = radius[1] ?? "DEFAULT";
      const value = key.startsWith("[") ? Number.parseFloat(key.slice(1)) : scales.radii[key];
      if (value !== undefined && value > 0) found.radii.push(value);
    }
  }
  if (size === undefined || !ownText) return;
  const read: { family: string; weight?: string } = !familySet
    ? { family: "System" }
    : family === undefined
      ? { family: "" }
      : familyAndWeight(family);
  const inherits = inherited({ family: !familySet, weight: weight === undefined && !read.weight });
  found.uses.push({
    kind: read.family === "System" ? "system" : "custom",
    family: read.family,
    size,
    weight: weight ?? read.weight ?? "regular",
    ...(inherits && { inherits }),
    file: source.rel,
    line: lineOf(node),
  });
}

/** The lengths a config's `theme[key]` and `theme.extend[key]` set, in points: `"3xl": ["25px", …]`. */
function configLengths(sources: JsSource[], key: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { groups, resolver } of themeGroups(sources, key)) {
    for (const group of groups) {
      for (const [name, value] of entries(group, resolver)) {
        const first = ts.isArrayLiteralExpression(value) ? value.elements[0] : value;
        const text = first && stringOf(first);
        const m = text?.match(LENGTH);
        if (m) out[name] = Number(m[1]) * (m[2] === "rem" ? 16 : 1);
      }
    }
  }
  return out;
}

/** The families a config's `fontFamily` names, by their class name (`font-inter`), the first of each list. */
function configFamilies(sources: JsSource[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { groups, resolver } of themeGroups(sources, "fontFamily")) {
    for (const group of groups) {
      for (const [name, value] of entries(group, resolver)) {
        const first = ts.isArrayLiteralExpression(value) ? value.elements[0] : value;
        const text = first && stringOf(first);
        if (text) out[name] = text.replace(/^["']|["']$/g, "");
      }
    }
  }
  return out;
}

function entries(group: Located, resolver: Resolver): [string, ts.Expression][] {
  const object = resolver.object(group);
  if (!object) return [];
  return object.node.properties.flatMap((p) => {
    const name = ts.isPropertyAssignment(p) ? propertyName(p.name) : undefined;
    return name !== undefined && ts.isPropertyAssignment(p) ? [[name, unwrapped(p.initializer)]] : [];
  });
}

const stringOf = (node: ts.Expression) => {
  const inner = unwrapped(node);
  return ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner) ? inner.text : undefined;
};
