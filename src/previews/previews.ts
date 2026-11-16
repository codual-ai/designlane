/** Pictures of components, drawn in HTML by a coding agent from their code, kept inert and offline. */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ComponentInfo } from "../catalog/components.js";
import { cssFontFamily, isHexColor } from "../output/css-values.js";
import { keyedColors, tokenKey } from "../output/token-names.js";
import type { DesignTokens } from "../scan/types.js";

const PREVIEWS_DIR = "previews";
const MAX_BYTES = 100_000;
/** Fetches nothing and runs nothing: on each picture's page, and atop each saved file, so opening one alone is safe. */
const PREVIEW_POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";
const POLICY_TAG = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_POLICY}">`;
/** Atop each saved picture, `designmap-preview` on one saved before the rename to Designlane. */
const HEADER =
  /^<!-- design(?:lane|map)-preview source=([0-9a-f]+) -->\n(?:<meta http-equiv="Content-Security-Policy" content="[^"\n]*">\n)?/;
/** A browser reads an attribute after a space, a `/` or a quote: `<svg/onload=…>`. */
const SCRIPTED = /<script\b|[\s/"']on[a-z]+\s*=|javascript:|vbscript:/i;
/** Character references can spell a URL or a scheme past the checks below (`&#104;ttp`, `javascript&colon;`). */
const ENCODED = /&(?:#|colon;|sol;|tab;|newline;|lpar;|rpar;|period;)/i;
const EMBEDDING = /<(?:iframe|frame|frameset|link|object|embed|meta|base|form|portal)\b/i;
/** `xmlns` names a namespace, not something fetched, so inline SVG keeps it. */
const NAMESPACE = /\sxmlns(?::\w+)?\s*=\s*(["'])[^"']*\1/gi;
const EXTERNAL = /https?:|ftp:|=\s*["']?\s*\/\/|url\(\s*["']?\s*\/\/|@import/i;

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);

/** One file per component, the same across runs and different for two components sharing a name. */
export const previewFile = (outDir: string, c: Pick<ComponentInfo, "name" | "file" | "framework">) =>
  path.join(
    outDir,
    PREVIEWS_DIR,
    `${tokenKey(c.name)}-${hash(`${c.framework}:${c.file}#${c.name}`).slice(0, 8)}.html`,
  );

export type Preview =
  /** `stale`: the component's code changed after the picture was drawn. */
  | { html: string; stale: boolean }
  /** The saved file breaks a rule (edited by hand since), so it isn't shown. */
  | { problem: string };

/** Why an agent's HTML can't be a preview, or undefined when it can: previews hold no scripts and fetch nothing. */
export function problemWith(html: string): string | undefined {
  if (!html.trim()) return "The HTML is empty.";
  if (Buffer.byteLength(html) > MAX_BYTES) return "The HTML is over 100 KB. Draw just the component.";
  if (SCRIPTED.test(html)) return "Remove scripts and event handlers: previews are still pictures.";
  if (ENCODED.test(html)) return "Write characters as themselves, not as &#…; or &colon; references.";
  if (EMBEDDING.test(html))
    return "Use plain HTML, inline SVG and <style> only (no iframe, link, object, embed, meta, base or form).";
  if (EXTERNAL.test(html.replace(NAMESPACE, "")))
    return "Remove external URLs and @import: previews open offline. Use inline SVG or a data: URL for images.";
  return undefined;
}

/** Saves the picture, refusing HTML that breaks a rule, and returns its file. */
export async function savePreview(outDir: string, c: ComponentInfo, html: string): Promise<string> {
  const problem = problemWith(html);
  if (problem) throw new Error(problem);
  const file = previewFile(outDir, c);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    `<!-- designlane-preview source=${hash(c.source)} -->\n${POLICY_TAG}\n${html.trim()}\n`,
  );
  return file;
}

/** The saved pictures of `components`, by id; a component without one has none. */
export async function loadPreviews(
  outDir: string,
  components: ComponentInfo[],
): Promise<Map<string, Preview>> {
  const out = new Map<string, Preview>();
  for (const c of components) {
    const text = await readPreview(previewFile(outDir, c));
    if (text === undefined) continue;
    const header = text.match(HEADER);
    const html = text.slice(header?.[0].length ?? 0);
    const problem = problemWith(html);
    out.set(c.id, problem ? { problem } : { html, stale: header?.[1] !== hash(c.source) });
  }
  return out;
}

async function readPreview(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return undefined;
    throw e;
  }
}

/** Each colour as a CSS variable, `--color-<key>`, and each custom font as `--font-<key>`, as tokens.json keys them. */
function variables(tokens: DesignTokens) {
  const colors = keyedColors(tokens.colors).filter(({ color }) => isHexColor(color.light));
  return {
    light: colors.map(({ color, key }) => `--color-${key}: ${color.light};`),
    dark: colors.flatMap(({ color, key }) =>
      color.dark && isHexColor(color.dark) ? [`--color-${key}: ${color.dark};`] : [],
    ),
    fonts: tokens.fonts.map((font) => `--font-${tokenKey(font)}: ${cssFontFamily(font)};`),
  };
}

/** The CSS variables a picture can use, for telling the agent: each with what it is in the code. */
export function previewVariables(tokens: DesignTokens): string[] {
  return [
    ...keyedColors(tokens.colors).map(
      ({ color, key }) => `--color-${key} (${color.light}${color.dark ? `, dark ${color.dark}` : ""})`,
    ),
    ...tokens.fonts.map((font) => `--font-${tokenKey(font)} (${font})`),
  ];
}

/** A whole page for one picture, with the app's variables (switching in dark mode) and a policy that fetches nothing
 * and runs nothing, on top of the sandbox the catalog shows it in. */
export function previewDocument(html: string, tokens: DesignTokens): string {
  const { light, dark, fonts } = variables(tokens);
  return `<!doctype html><html><head><meta charset="utf-8">
${POLICY_TAG}
<style>:root{color-scheme:light dark;${[...light, ...fonts].join("")}}
@media (prefers-color-scheme:dark){:root{${dark.join("")}}}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{display:grid;place-items:center;padding:16px;background:Canvas;color:CanvasText;font:15px/1.4 -apple-system,system-ui,sans-serif;overflow:hidden}</style>
</head><body>${html}</body></html>`;
}

export const PREVIEW_RULES =
  "Draw it as one HTML fragment (with <style> tags if needed) that looks like the component on a phone, at its real size in CSS pixels (1pt = 1dp = 1px), within 393 × 300 (a phone's width). Use the app's CSS variables below rather than literal colours, so it follows light and dark; realistic content from the code (no lorem ipsum); and inline SVG for icons. No scripts, event handlers, external URLs or linked images: the catalog shows pictures offline in a sandbox. Draw what the code shows, not an idealised version.";
