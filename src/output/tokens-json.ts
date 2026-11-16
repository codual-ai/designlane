/**
 * The scan's design system as W3C design tokens (DTCG 2025.10), which Figma, Tokens Studio and Style Dictionary
 * import: only what the code names (`Theme.surface`, a typography style), since a value written in place changes
 * whenever a screen's layout does. DESIGN.md lists those values, and the spacing and radii the code uses.
 */

import path from "node:path";
import type { z } from "zod";
import {
  type ColorTheme,
  type ColorToken,
  FRAMEWORK_NAMES,
  type FrameworkId,
  type FrameworkScan,
  type Platform,
  type ScanResult,
  type TypeLocations,
  type TypeStyle,
} from "../scan/types.js";
import {
  isNamedStyle,
  keyedColors,
  keyedStyles,
  keyedThemes,
  type TypeValues,
  tokenKey,
} from "./token-names.js";
import type { ColorTokenEntry, ColorValue, DesignTokensFile } from "./tokens-schema.js";

/** A group of the file, as the schema types it. */
type Group<K extends "color" | "typography" | "theme"> = NonNullable<DesignTokensFile[K]>;

const round = (n: number) => Math.round(n * 1000) / 1000;
const channel = (hex: string, at: number) => round(Number.parseInt(hex.slice(at, at + 2), 16) / 255);
/** Sizes are in points; DTCG's nearest unit is px, which is what a point is at 1x. */
const px = (value: number) => ({ value, unit: "px" as const });
const uses = (n: number) => `${n} use${n === 1 ? "" : "s"}`;

/** `#rrggbb` or `#rrggbbaa` as a DTCG colour. */
export function colorValue(hex: string): z.input<typeof ColorValue> {
  const h = hex.replace("#", "");
  const value: z.input<typeof ColorValue> = {
    colorSpace: "srgb",
    components: [channel(h, 0), channel(h, 2), channel(h, 4)],
    hex: `#${h.slice(0, 6)}`,
  };
  if (h.length === 8) value.alpha = channel(h, 6);
  return value;
}

function colorEntry(color: ColorToken): z.input<typeof ColorTokenEntry> {
  return {
    $type: "color",
    $value: colorValue(color.light),
    $description: `From ${color.source}, ${uses(color.uses)}`,
    $extensions: {
      designlane: {
        ...(color.reference ? { reference: color.reference } : {}),
        source: color.source,
        ...(color.line ? { line: color.line } : {}),
        uses: color.uses,
        ...(color.dark ? { modes: { dark: colorValue(color.dark) } } : {}),
        ...(color.locations?.light || color.locations?.dark ? { locations: color.locations } : {}),
      },
    },
  };
}

/** Keys are given among every colour, as DESIGN.md gives them, so a colour has one key in both files. */
function colors(all: ColorToken[]): Group<"color"> {
  const group: Group<"color"> = { $description: "Most used first" };
  for (const { color, key } of keyedColors(all)) if (color.kind !== "inline") group[key] = colorEntry(color);
  return group;
}

/** Each other theme as a group of its colours, named as the code names it, which a sync knows it by. */
function themes(all: ColorTheme[]): Group<"theme"> {
  const group: Group<"theme"> = {
    $description:
      "The app's other themes, each with its own colours in Light and Dark; `color` is the default theme's",
  };
  for (const { theme, key } of keyedThemes(all)) {
    group[key] = {
      $description: `The ${theme.name} theme`,
      $extensions: { designlane: { name: theme.name } },
      color: colors(theme.colors),
    };
  }
  return group;
}

/** Each text style as a group of the values the code sets. A DTCG typography token needs line height and letter
 * spacing too, which the code rarely sets, so the values stand as their own tokens rather than as one invented. */
function typography(all: TypeStyle[], platform: Platform | undefined): Group<"typography"> {
  const group: Group<"typography"> = { $description: "Most used first" };
  for (const { style, key, values } of keyedStyles(all, platform)) {
    const { fontFamily, fontSize, fontWeight } = values;
    if (!isNamedStyle(style) || (!fontFamily && fontSize === undefined && fontWeight === undefined)) continue;
    const locations = locationsOf(style, values);
    group[key] = {
      $description: `${style.name}, ${uses(style.uses)}`,
      $extensions: {
        designlane: {
          name: style.name,
          ...(style.reference ? { reference: style.reference } : {}),
          uses: style.uses,
          ...(locations ? { locations } : {}),
        },
      },
      ...(fontFamily ? { fontFamily: { $type: "fontFamily", $value: fontFamily } } : {}),
      ...(fontSize !== undefined ? { fontSize: { $type: "dimension", $value: px(fontSize) } } : {}),
      ...(fontWeight !== undefined ? { fontWeight: { $type: "fontWeight", $value: fontWeight } } : {}),
    };
  }
  return group;
}

/** Where the values a text style's group holds are written: none for a value the group leaves out. */
function locationsOf(style: TypeStyle, values: TypeValues): TypeLocations | undefined {
  const held = Object.entries(style.locations ?? {}).filter(([key]) => key in values);
  return held.length > 0 ? Object.fromEntries(held) : undefined;
}

/**
 * The tokens of one of the app's frameworks, `framework`, which a project with more than one must name. A scan that
 * couldn't read the whole app says so, so a sync doesn't take what it missed for what the code dropped.
 */
export function toDesignTokens(scan: ScanResult, framework?: FrameworkId): DesignTokensFile {
  if (!framework && scan.frameworks.length > 1) {
    const all = scan.frameworks.map((f) => FRAMEWORK_NAMES[f.framework]).join(" and ");
    throw new Error(`${scan.root} has ${all} code: name the framework whose tokens to write.`);
  }
  const app = path.basename(scan.root);
  const partial = scan.truncated || scan.unreadable.length > 0;
  const read = scan.frameworks.find((f) => !framework || f.framework === framework);
  // An empty file would read as an app with no tokens rather than the wrong app.
  if (framework && !read) throw new Error(`${scan.root} has no ${FRAMEWORK_NAMES[framework]} code.`);
  const several = scan.frameworks.length > 1 && read;
  const file: DesignTokensFile = {
    $description: several
      ? `Read from the ${FRAMEWORK_NAMES[read.framework]} code of ${app} by Designlane`
      : `Read from the code of ${app} by Designlane`,
    $extensions: { designlane: { app, ...(partial ? { partial: true } : {}) } },
  };
  return read ? withTokens(file, read) : file;
}

function withTokens(file: DesignTokensFile, framework: FrameworkScan): DesignTokensFile {
  const { tokens } = framework;
  const platform = framework.platforms[0];
  if (platform && file.$extensions) file.$extensions.designlane.platform = platform;
  const color = colors(tokens.colors);
  if (Object.keys(color).length > 1) file.color = color;
  const theme = themes(tokens.themes ?? []);
  if (Object.keys(theme).length > 1) file.theme = theme;
  const type = typography(tokens.typeStyles, platform);
  if (Object.keys(type).length > 1) file.typography = type;
  // A family only styles written in place use is left out; one no style names, a helper mixing several, is kept.
  const inFamily = (f: string) => tokens.typeStyles.filter((s) => s.family === f);
  const fonts = tokens.fonts.filter((f) => inFamily(f).length === 0 || inFamily(f).some(isNamedStyle));
  if (fonts.length) {
    file.fontFamily = Object.fromEntries(fonts.map((f) => [tokenKey(f), { $type: "fontFamily", $value: f }]));
  }
  return file;
}
