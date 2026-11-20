/** catalog.html: one offline page showing the app's colours, text styles, spacing, corner radii and every component,
 * read from its code. Everything from the code is escaped, and nothing is fetched. */

import path from "node:path";
import { CATEGORIES, type Category, type ComponentInfo, firstLines } from "../catalog/components.js";
import { type Preview, previewDocument } from "../previews/previews.js";
import { plural } from "../scan/counting.js";
import { weightLabel } from "../scan/type-scale.js";
import { FRAMEWORK_NAMES, type FrameworkScan, type ScaleStep, type ScanResult } from "../scan/types.js";
import { CATALOG_CSS, CATALOG_SCRIPT } from "./catalog-style.js";
import { cssFontFamily, isHexColor } from "./css-values.js";
import { dimensionKey, keyedColors, keyedStyles } from "./token-names.js";

const CATEGORY_LABELS: Record<Category, string> = {
  button: "Buttons",
  list: "Rows and list items",
  card: "Cards and panels",
  header: "Headers and bars",
  input: "Inputs",
  label: "Labels and badges",
  media: "Images and icons",
  screen: "Screen-like components",
  other: "Other components",
};

/** How many lines of a component's code a card shows. */
const MAX_CODE_LINES = 60;
/** How many files a card lists as using a component. */
const MAX_USED_IN = 20;
/** The widest spacing bar, in pixels. */
const MAX_BAR = 320;
/** Corner radii are drawn up to this, so a pill's 999 still fits its box. */
const MAX_DRAWN_RADIUS = 32;
/** The page fetches nothing and runs only its own search; frames are left to each picture's own sandbox. */
const PAGE_POLICY =
  "script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/** Text and attribute values from the code, escaped for HTML. */
export const escapeHtml = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const fill = (hex: string | undefined) => (hex && isHexColor(hex) ? hex : "transparent");

function swatches(colors: FrameworkScan["tokens"]["colors"]): string {
  return keyedColors(colors)
    .map(({ color: c, key }) => {
      const dark = c.dark
        ? `<span style="background:${fill(c.dark)}" title="Dark ${escapeHtml(c.dark)}"></span>`
        : "";
      const values = `${escapeHtml(c.light)}${c.dark ? ` · dark ${escapeHtml(c.dark)}` : ""}`;
      const how = c.reference ? `<br><span class="mono muted">${escapeHtml(c.reference)}</span>` : "";
      return `<div class="swatch"><div class="chip"><span style="background:${fill(c.light)}" title="Light ${escapeHtml(c.light)}"></span>${dark}</div><div class="meta"><b>${escapeHtml(key)}</b><span class="mono">${values}</span>${how}<br><span class="muted">${plural(c.uses, "use")} · <span class="mono">${escapeHtml(c.source)}</span></span></div></div>`;
    })
    .join("");
}

function colorSection(f: FrameworkScan): string {
  const { colors, themes = [] } = f.tokens;
  const own = colors.length
    ? `<h3>Colours (${colors.length})</h3><div class="grid">${swatches(colors)}</div>`
    : "";
  const others = themes.map(
    (t) =>
      `<h3>Theme: ${escapeHtml(t.name)} (${plural(t.colors.length, "colour")})</h3><div class="grid">${swatches(t.colors)}</div>`,
  );
  return own + others.join("");
}

function typeSection(f: FrameworkScan): string {
  const styles = keyedStyles(f.tokens.typeStyles, f.platforms[0]);
  if (!styles.length) return "";
  const rows = styles.map(({ style, key, values }) => {
    const family = values.fontFamily ? cssFontFamily(values.fontFamily) : "inherit";
    const size = values.fontSize !== undefined ? `font-size:${Math.min(values.fontSize, 64)}px;` : "";
    const weight = values.fontWeight !== undefined ? `font-weight:${values.fontWeight};` : "";
    const described = [
      values.fontFamily,
      values.fontSize !== undefined && `${values.fontSize}pt`,
      !style.inherits?.includes("weight") && weightLabel(style.weight),
    ]
      .filter(Boolean)
      .join(" ");
    const how = style.reference ? ` · <span class="mono">${escapeHtml(style.reference)}</span>` : "";
    return `<div class="style"><p style="font-family:${escapeHtml(family)};${size}${weight}">${escapeHtml(key)}</p><span class="muted">${escapeHtml(described)} · ${plural(style.uses, "use")}${how}</span></div>`;
  });
  const fonts = f.tokens.fonts.length
    ? `<p class="sub">Custom fonts: ${escapeHtml(f.tokens.fonts.join(", "))}</p>`
    : "";
  return `<h3>Text styles (${styles.length})</h3>${fonts}<div class="styles">${rows.join("")}</div>`;
}

/** A value to draw, and its label: a named step's reference and uses, or a bare value's key. */
interface Drawn {
  value: number;
  label: string;
}

/** The scales the code names, drawn with each step's reference; without one, every value the code writes. A named
 * scale is followed by the values written in place, listed but not drawn. */
function scaleSection(f: FrameworkScan): string {
  const named = (steps: ScaleStep[] = []): Drawn[] =>
    steps.map((s) => ({ value: s.value, label: `${s.reference} · ${s.value} · ${plural(s.uses, "use")}` }));
  const bare = (values: number[], prefix: string): Drawn[] =>
    [...values].sort((a, b) => a - b).map((v) => ({ value: v, label: `${dimensionKey(prefix, v)} · ${v}` }));
  const scales = f.tokens.scales;
  const spacing = scales?.spacing.length ? named(scales.spacing) : bare(f.tokens.spacing, "space");
  const radii = scales?.radii.length ? named(scales.radii) : bare(f.tokens.radii, "radius");
  const widest = Math.max(1, ...spacing.map((d) => d.value));
  const bars = spacing.map(
    (d) =>
      `<div><span class="bar" style="width:${Math.max(2, (d.value / widest) * MAX_BAR)}px"></span>${escapeHtml(d.label)}</div>`,
  );
  const corners = radii.map(
    (d) =>
      `<div><span style="border-radius:${Math.min(d.value, MAX_DRAWN_RADIUS)}px"></span>${escapeHtml(d.label)}</div>`,
  );
  const inPlace = (values: number[]) =>
    values.length
      ? `<p class="sub">Written in place: ${escapeHtml([...values].sort((a, b) => a - b).join(", "))}</p>`
      : "";
  return [
    bars.length
      ? `<h3>${scales?.spacing.length ? "Spacing scale" : "Spacing the code uses"}</h3><div class="scale">${bars.join("")}</div>${scales?.spacing.length ? inPlace(f.tokens.spacing) : ""}`
      : "",
    corners.length
      ? `<h3>${scales?.radii.length ? "Corner radius scale" : "Corner radii the code uses"}</h3><div class="radii">${corners.join("")}</div>${scales?.radii.length ? inPlace(f.tokens.radii) : ""}`
      : "",
  ].join("");
}

function foundations(scan: ScanResult): string {
  const several = scan.frameworks.length > 1;
  return scan.frameworks
    .map((f) => {
      const heading = several
        ? `<h3 style="color:var(--ink);font-size:17px">${FRAMEWORK_NAMES[f.framework]}</h3>`
        : "";
      const parts = colorSection(f) + typeSection(f) + scaleSection(f);
      return (
        heading + (parts || `<p class="sub">No colours, text styles, spacing or corner radii found.</p>`)
      );
    })
    .join("");
}

function picture(
  c: ComponentInfo,
  preview: Preview | undefined,
  tokens: FrameworkScan["tokens"] | undefined,
): string {
  if (!preview || !tokens) return "";
  if ("problem" in preview)
    return `<span class="warn">Picture left out: ${escapeHtml(preview.problem)}</span>`;
  const stale = preview.stale
    ? `<span class="warn">The code changed after this picture was drawn.</span>`
    : "";
  return `<div class="picture"><iframe title="${escapeHtml(`Picture of ${c.name}`)}" sandbox="" loading="lazy" srcdoc="${escapeHtml(previewDocument(preview.html, tokens))}"></iframe></div>${stale}`;
}

function tags(values: string[], swatch?: Map<string, string>): string {
  if (!values.length) return "";
  const tag = (v: string) =>
    `<span class="tag">${swatch ? `<i style="background:${fill(swatch.get(v))}"></i>` : ""}${escapeHtml(v)}</span>`;
  return `<div class="tags">${values.map(tag).join("")}</div>`;
}

interface CardContext {
  previews: Map<string, Preview>;
  tokens: Map<string, FrameworkScan["tokens"]>;
  swatches: Map<string, Map<string, string>>;
}

function card(c: ComponentInfo, context: CardContext): string {
  const text = [c.name, c.category, c.file, ...c.params, ...c.colors, ...c.typeStyles]
    .join(" ")
    .toLowerCase();
  const placed = c.uses ? `used ${c.uses}× in ${plural(c.usedIn.length, "file")}` : "not placed elsewhere";
  const uses = c.sharedUses ? `${placed}, and ${c.sharedUses}× that may be another ${c.name}` : placed;
  const where = c.usedIn.length
    ? `<details><summary>Where it's used</summary><pre>${escapeHtml(c.usedIn.slice(0, MAX_USED_IN).join("\n"))}${c.usedIn.length > MAX_USED_IN ? "\n…" : ""}</pre></details>`
    : "";
  const code = c.source
    ? `<details><summary>Code</summary><pre>${escapeHtml(firstLines(c.source, MAX_CODE_LINES))}</pre></details>`
    : "";
  return `<article class="card" data-text="${escapeHtml(text)}" data-category="${c.category}" data-kind="${c.kind}">
${picture(c, context.previews.get(c.id), context.tokens.get(c.framework))}
<span class="kind">${c.kind === "screen" ? "Screen" : CATEGORY_LABELS[c.category]}</span>
<div class="top"><span class="name">${escapeHtml(c.name)}</span><span class="uses">${uses}</span></div>
<span class="mono muted">${escapeHtml(c.file)}:${c.line}</span>
${tags(c.params)}${tags(c.colors, context.swatches.get(c.framework))}${tags(c.typeStyles)}${where}${code}
</article>`;
}

function componentSection(components: ComponentInfo[], context: CardContext): string {
  const parts = components.filter((c) => c.kind === "component");
  const screens = components.filter((c) => c.kind === "screen");
  const grid = [...parts].sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category));
  const counts = CATEGORIES.map((category) => ({
    category,
    n: parts.filter((c) => c.category === category).length,
  })).filter((x) => x.n);
  const filter = (category: string, label: string, pressed: boolean) =>
    `<button type="button" data-category-filter="${category}" aria-pressed="${pressed}">${label}</button>`;
  const filters =
    counts.length > 1
      ? `<div class="filters" role="group" aria-label="Filter components by kind">${filter("", `All (${parts.length})`, true)}${counts.map((x) => filter(x.category, `${CATEGORY_LABELS[x.category]} (${x.n})`, false)).join("")}</div>`
      : "";
  const cards = (list: ComponentInfo[]) => list.map((c) => card(c, context)).join("");
  return `<h2 id="components">Components</h2>
<p class="sub">Grouped by kind, most used first. Parameters, colours and text styles are as the code writes them.</p>
<div class="toolbar"><input id="search" type="search" placeholder="Search names, files, parameters, colours…" aria-label="Search components and screens"></div>
<p class="muted" id="shown" aria-live="polite"></p>
${filters}
${grid.length ? `<div class="cards">${cards(grid)}</div>` : `<p class="sub">No components found.</p>`}
${screens.length ? `<h2 id="screens">Screens (${screens.length})</h2><div class="cards">${cards(screens)}</div>` : ""}`;
}

/** The whole page, with the saved `previews` (by component id) on their cards. */
export function toCatalogHtml(
  scan: ScanResult,
  components: ComponentInfo[],
  previews: Map<string, Preview> = new Map(),
): string {
  const name = path.basename(scan.root);
  const context: CardContext = {
    previews,
    tokens: new Map(scan.frameworks.map((f) => [f.framework, f.tokens])),
    swatches: new Map(
      scan.frameworks.map((f) => [
        f.framework,
        new Map(keyedColors(f.tokens.colors).map(({ color, key }) => [key, color.light])),
      ]),
    ),
  };
  const built = scan.frameworks.map((f) => FRAMEWORK_NAMES[f.framework]).join(" and ");
  const pictured = components.filter((c) => previews.has(c.id)).length;
  const partial = scan.truncated || scan.unreadable.length > 0;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${PAGE_POLICY}">
<title>${escapeHtml(name)} design system</title>
<style>${CATALOG_CSS}</style>
</head>
<body>
<header>
<div class="eyebrow">Designlane · ${built}</div>
<h1>${escapeHtml(name)}</h1>
<p class="sub">${plural(components.filter((c) => c.kind === "component").length, "component")} and ${plural(components.filter((c) => c.kind === "screen").length, "screen")}, with the colours, text styles, spacing and corner radii the code uses. Every value says where in the code it comes from.</p>
${partial ? `<p class="sub warn">Only part of the app was read, so this page is incomplete.</p>` : ""}
<nav><a href="#foundations">Foundations</a><a href="#components">Components</a></nav>
</header>
<main>
<h2 id="foundations">Foundations</h2>
${foundations(scan)}
${componentSection(components, context)}
</main>
<footer>Made by Designlane from the code. ${pictured ? `${pictured} of ${plural(components.length, "view")} have a picture, drawn by a coding agent from the code: close to the real thing, not exact.` : "To add pictures, connect Designlane's MCP server to your coding agent and ask it to draw your components."}</footer>
<script>${CATALOG_SCRIPT}</script>
</body>
</html>
`;
}
