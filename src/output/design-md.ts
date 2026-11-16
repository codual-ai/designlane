/**
 * The scan as a DESIGN.md (Google's design.md format, version alpha): tokens in the front matter, and short prose
 * that only states what the code shows: how often each value is used and where it came from. Coding agents read it
 * to build new screens that match the app.
 */

import path from "node:path";
import { plural } from "../scan/counting.js";
import { weightLabel } from "../scan/type-scale.js";
import { FRAMEWORK_NAMES, type FrameworkScan, type ScanResult, SUPPORTED_FRAMEWORKS } from "../scan/types.js";
import { linkNotes, namedLinks, OPENING_WORDS } from "./screen-links.js";
import { dimensionKey, keyedColors, keyedStyles } from "./token-names.js";

/** How many colours and text styles are described one per line; the rest follow briefly. */
const MOST_USED_LISTED = 12;
/** How many screens and components the overview names; the rest are counted. */
const MAX_VIEWS_NAMED = 30;
/** Colour names that say which colour is the app's own: the format asks for a `primary`, which points at one of
 * these rather than at a guess. */
const PRIMARY_NAMES = [/^accent(color)?$/i, /^(brand|tint)$/i];
/** Plain words YAML 1.1 reads as true, false or null, so a key that's one of them is quoted. */
const YAML_WORDS = /^(?:y|yes|n|no|true|false|on|off|null)$/i;

type Yaml = { [key: string]: string | number | Yaml | Yaml[] };

/** Strings are always quoted, since `#` starts a comment. */
const scalar = (v: string | number) => (typeof v === "number" ? String(v) : JSON.stringify(v));
const yamlKey = (k: string) => (/^[A-Za-z_][\w-]*$/.test(k) && !YAML_WORDS.test(k) ? k : JSON.stringify(k));

function yaml(obj: Yaml, indent = ""): string {
  return Object.entries(obj)
    .map(([k, v]) => {
      if (Array.isArray(v)) {
        const items = v.map((item) => `${indent}  - ${yaml(item, `${indent}    `).trimStart()}`);
        return `${indent}${yamlKey(k)}:\n${items.join("\n")}`;
      }
      if (typeof v === "object") return `${indent}${yamlKey(k)}:\n${yaml(v, `${indent}  `)}`;
      return `${indent}${yamlKey(k)}: ${scalar(v)}`;
    })
    .join("\n");
}

const px = (n: number) => `${n}px`;

/** Names listed in prose, with how many more there are. */
function named(names: string[]): string {
  const shown = names.slice(0, MAX_VIEWS_NAMED).join(", ");
  return names.length > MAX_VIEWS_NAMED ? `${shown}, and ${names.length - MAX_VIEWS_NAMED} more` : shown;
}

interface Part {
  tokens: Yaml;
  prose: string[];
}

type Prefix = (f: FrameworkScan) => string;

/** A value listed in prose: in full among the most used, or briefly among the rest. */
interface Listed {
  detailed: string;
  brief: string;
}

/** The most used values one per line, then every other one briefly, so nothing is left out and the system the app
 * leans on still stands out from its one-offs. */
function mostUsedThenTheRest(lines: Listed[], one: string, many: string): string[] {
  const rest = lines.slice(MOST_USED_LISTED);
  const top = lines.slice(0, MOST_USED_LISTED).map((line) => line.detailed);
  if (!rest.length) return top;
  return [
    ...top,
    `\nAlso used, ${plural(rest.length, `more ${one}`, `more ${many}`)}: ${rest.map((line) => line.brief).join(", ")}.`,
  ];
}

function colorPart(frameworks: FrameworkScan[], prefix: Prefix): Part {
  const tokens: Yaml = {};
  const prose: string[] = [];
  for (const f of frameworks) {
    const lines: Listed[] = [];
    for (const { color: c, key: own, darkKey } of keyedColors(f.tokens.colors)) {
      const key = `${prefix(f)}${own}`;
      tokens[key] = c.light;
      if (darkKey) tokens[`${prefix(f)}${darkKey}`] = c.dark ?? "";
      const where = c.kind === "inline" ? "written without a name, first in" : "from";
      const referredTo = c.reference ? ` as \`${c.reference}\`` : "";
      const dark = darkKey ? ` (dark \`${c.dark}\`, as ${prefix(f)}${darkKey})` : "";
      lines.push({
        detailed: `- **${key}** \`${c.light}\`${dark}: ${plural(c.uses, "use")}, ${where} \`${c.source}\`${referredTo}.`,
        brief: `${key} \`${c.light}\` ×${c.uses}`,
      });
    }
    prose.push(...mostUsedThenTheRest(lines, "colour", "colours"));
    const { systemColors } = f.tokens;
    if (systemColors.length) {
      const list = systemColors.map((s) => `${s.name} (${s.uses})`).join(", ");
      prose.push(`\nPlatform colours, which follow the system's own palette: ${list}.`);
    }
  }
  const keys = Object.keys(tokens);
  const own = PRIMARY_NAMES.map((p) => keys.find((k) => p.test(k))).find(Boolean);
  if (own && !("primary" in tokens)) {
    tokens.primary = `{colors.${own}}`;
    prose.unshift(`\`primary\` refers to ${own}, by its name.\n`);
  }
  return { tokens, prose };
}

/** Each of the app's other themes with its colours, all of them, since a theme is a whole set a designer switches to. */
function themesProse(frameworks: FrameworkScan[]): string[] {
  const several = frameworks.length > 1;
  return frameworks.flatMap((f) => {
    const themes = f.tokens.themes ?? [];
    if (!themes.length) return [];
    const heading = several ? `${FRAMEWORK_NAMES[f.framework]} themes` : "Themes";
    const intro = `Besides its default theme, whose colours are listed above, the app has ${plural(themes.length, "other theme")}, each with its own colours in Light and Dark.`;
    const each = themes.map((theme) => {
      const lines = keyedColors(theme.colors).map(({ color: c, key }) => {
        const dark = c.dark ? ` (dark \`${c.dark}\`)` : "";
        return `- **${key}** \`${c.light}\`${dark}: from \`${c.source}\` as \`${c.reference ?? c.name}\`.`;
      });
      return `### ${theme.name}\n\n${lines.join("\n")}`;
    });
    return [`## ${heading}\n\n${intro}\n\n${each.join("\n\n")}`];
  });
}

function typePart(frameworks: FrameworkScan[], prefix: Prefix): Part {
  const tokens: Yaml = {};
  const prose: string[] = [];
  const computed: string[] = [];
  for (const f of frameworks) {
    const lines: Listed[] = [];
    for (const { style, key: own, values } of keyedStyles(f.tokens.typeStyles, f.platforms[0])) {
      const key = `${prefix(f)}${own}`;
      const { fontFamily, fontSize, fontWeight } = values;
      if (!fontFamily && fontSize === undefined && fontWeight === undefined) {
        computed.push(`${style.name} (${plural(style.uses, "use")})`);
        continue;
      }
      tokens[key] = {
        ...(fontFamily ? { fontFamily } : {}),
        ...(fontSize !== undefined ? { fontSize: px(fontSize) } : {}),
        ...(fontWeight !== undefined ? { fontWeight } : {}),
      };
      const value = [fontFamily, fontSize !== undefined && px(fontSize), weightLabel(style.weight)];
      const via = style.reference ? `, as \`${style.reference}\`` : "";
      const described = value.filter(Boolean).join(" ");
      lines.push({
        detailed: `- **${key}** (${described}): ${plural(style.uses, "use")}${via}.`,
        brief: `${key} (${described}) ×${style.uses}`,
      });
    }
    prose.push(...mostUsedThenTheRest(lines, "text style", "text styles"));
    if (f.tokens.fonts.length) prose.push(`\nCustom font families: ${f.tokens.fonts.join(", ")}.`);
  }
  if (computed.length)
    prose.push(`\nAlso used, with a font the code works out as it runs: ${computed.join(", ")}.`);
  return { tokens, prose };
}

function scalePart(
  frameworks: FrameworkScan[],
  prefix: Prefix,
  kind: string,
  values: (f: FrameworkScan) => number[],
) {
  const tokens: Yaml = {};
  for (const f of frameworks) {
    for (const v of [...values(f)].sort((a, b) => a - b))
      tokens[`${prefix(f)}${dimensionKey(kind, v)}`] = px(v);
  }
  return tokens;
}

export function toDesignMd(scan: ScanResult): string {
  const name = path.basename(scan.root);
  const { frameworks } = scan;
  const prefix = (f: FrameworkScan) => (frameworks.length > 1 ? `${f.framework}-` : "");
  const colors = colorPart(frameworks, prefix);
  const type = typePart(frameworks, prefix);
  const spacing = scalePart(frameworks, prefix, "space", (f) => f.tokens.spacing);
  const rounded = scalePart(frameworks, prefix, "radius", (f) => f.tokens.radii);

  const front: Yaml = {
    version: "alpha",
    name,
    description: `The design system of ${name}, read from its code by Designlane.`,
  };
  const omitted: Yaml[] = [];
  for (const [section, tokens, reason] of [
    ["colors", colors.tokens, "No colours found"],
    ["typography", type.tokens, "No text styles with a font, size or weight the code sets"],
    ["spacing", spacing, "No spacing values found"],
    ["rounded", rounded, "No corner radii found"],
  ] as const) {
    if (Object.keys(tokens).length) front[section] = tokens;
    else omitted.push({ section, reason });
  }
  omitted.push({ section: "components", reason: "Component tokens aren't read yet" });
  front.omitted = omitted;

  const sections = [`---\n${yaml(front)}\n---`, `# ${name}`, `## Overview\n\n${overview(scan, name)}`];
  if (colors.prose.length) sections.push(`## Colors\n\n${colors.prose.join("\n")}`);
  sections.push(...themesProse(frameworks));
  if (type.prose.length) sections.push(`## Typography\n\n${type.prose.join("\n")}`);
  if (Object.keys(spacing).length) {
    const values = Object.values(spacing).join(", ");
    sections.push(`## Layout\n\nEvery spacing value the UI code uses, smallest first: ${values}.`);
  }
  if (Object.keys(rounded).length) {
    const values = Object.values(rounded).join(", ");
    sections.push(`## Shapes\n\nEvery corner radius the UI code uses, smallest first: ${values}.`);
  }
  return `${sections.join("\n\n")}\n`;
}

/** How many links between screens the overview lists; the rest are counted. */
const MAX_LINKS_NAMED = 30;

function linksLine(frameworks: FrameworkScan[]): string {
  const all = namedLinks(frameworks).map(
    (l) => `${l.fromName} → ${l.toName}${l.opening === "push" ? "" : ` (${OPENING_WORDS[l.opening]})`}`,
  );
  const shown = all.slice(0, MAX_LINKS_NAMED);
  const more = all.length > shown.length ? `, and ${all.length - shown.length} more` : "";
  const listed = all.length ? `How screens open each other: ${shown.join("; ")}${more}.` : "";
  return [listed, ...(all.length ? linkNotes(frameworks).filter((n) => !n.startsWith("Links between")) : [])]
    .filter(Boolean)
    .join(" ");
}

function overview({ frameworks }: ScanResult, name: string): string {
  if (!frameworks.length) return `Designlane found no ${SUPPORTED_FRAMEWORKS} code in ${name}.`;
  const views = frameworks.flatMap((f) => f.screens);
  const screens = views.filter((v) => v.kind === "screen").map((v) => v.name);
  const components = views.filter((v) => v.kind === "component").map((v) => v.name);
  const built = frameworks.map((f) => FRAMEWORK_NAMES[f.framework]).join(" and ");
  return [
    `${name} is built with ${built}: ${plural(screens.length, "screen")} and ${plural(components.length, "component")}. Everything here was read from its code. Colours and text styles are listed most used first, with their use counts. Sizes are in points (dp on Android), written as px.`,
    screens.length ? `Screens: ${named(screens)}.` : "",
    components.length ? `Components: ${named(components)}.` : "",
    linksLine(frameworks),
  ]
    .filter(Boolean)
    .join("\n\n");
}
