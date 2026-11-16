/** The MCP tools for the app's components: finding one to reuse, reading it, and saving a picture of it. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CATEGORIES, type ComponentInfo, firstLines, inventory } from "../catalog/components.js";
import { readSources } from "../catalog/sources.js";
import { writeCatalog } from "../output/reports.js";
import { outputDir } from "../output/write.js";
import {
  loadPreviews,
  PREVIEW_RULES,
  type Preview,
  previewVariables,
  problemWith,
  savePreview,
} from "../previews/previews.js";
import { plural } from "../scan/counting.js";
import { FRAMEWORK_NAMES, type ScanResult } from "../scan/types.js";
import { type Answer, appPath, failure, MAX_LISTED, withApp } from "./app.js";

/** How many lines of a component's code get_component returns. */
const MAX_CODE_LINES = 200;

type Repo = z.ZodOptional<z.ZodString>;

async function componentsOf(scan: ScanResult) {
  return { components: inventory(scan, await readSources(scan)), outDir: await outputDir(scan.root) };
}

async function withPreviews(scan: ScanResult) {
  const { components, outDir } = await componentsOf(scan);
  return { components, previews: await loadPreviews(outDir, components) };
}

function pictureNote(preview: Preview | undefined): string {
  if (!preview) return "";
  if ("problem" in preview) return " · picture left out, redraw it";
  return preview.stale ? " · picture out of date" : " · has a picture";
}

/** `3×`, and the places that may be another component of the same name. */
const usedTimes = (c: ComponentInfo) =>
  `${c.uses}×${c.sharedUses ? ` (and ${c.sharedUses}× that may be another ${c.name})` : ""}`;

const brief = (c: ComponentInfo) =>
  `- ${c.name} (${c.kind === "screen" ? "screen" : c.category}, ${FRAMEWORK_NAMES[c.framework]}) ${c.file}:${c.line} · used ${usedTimes(c)}${c.params.length ? ` · ${c.params.join(", ")}` : ""}`;

/** The one component named `name` (in `file`, when given), or why there isn't one. */
function pick(
  root: string,
  components: ComponentInfo[],
  name: string,
  file?: string,
): ComponentInfo | string {
  const matches = components.filter((c) => c.name === name && (!file || c.file === appPath(root, file)));
  if (!matches.length)
    return `No component named ${name}${file ? ` in ${file}` : ""}. Use find_components to search.`;
  if (matches.length > 1)
    return `${matches.length} components are named ${name}: pass file (${matches.map((c) => c.file).join(", ")}).`;
  return matches[0] as ComponentInfo;
}

function describe(c: ComponentInfo, preview: Preview | undefined, scan: ScanResult): string {
  const code = firstLines(c.source, MAX_CODE_LINES);
  const tokens = scan.frameworks.find((f) => f.framework === c.framework)?.tokens;
  const variables = tokens ? previewVariables(tokens).join("; ") : "";
  const picture =
    preview && !("problem" in preview) && !preview.stale
      ? "Picture: saved."
      : `Picture: ${preview ? "redraw it with save_preview" : "none yet"}. ${PREVIEW_RULES}\nCSS variables: ${variables || "none (use neutral colours)"}`;
  return [
    `${c.name} · ${c.kind === "screen" ? "screen" : c.category} · ${FRAMEWORK_NAMES[c.framework]} · ${c.file}:${c.line}`,
    `Parameters: ${c.params.join(", ") || "none"}`,
    `Colours: ${c.colors.join(", ") || "none"}`,
    `Text styles: ${c.typeStyles.join(", ") || "none"}`,
    `Used ${usedTimes(c)}${c.usedIn.length ? ` in ${c.usedIn.slice(0, 8).join(", ")}` : ""}`,
    ...(code ? ["```", code, "```"] : ["Its declaration couldn't be read."]),
    picture,
  ].join("\n");
}

export function registerComponentTools(server: McpServer, repo: Repo, rootOf: (r?: string) => string): void {
  const name = z.string().describe("The component's name, from find_components");
  const file = z.string().optional().describe("The component's file, when two components share the name");

  server.registerTool(
    "find_components",
    {
      title: "Find components",
      description:
        "Call before creating a view, to reuse one the app has. Returns its components (buttons, rows, cards, headers…) most used first, with each one's file, uses and parameters.",
      inputSchema: {
        repo,
        query: z.string().optional().describe("Part of a name, e.g. Button or Card"),
        category: z.enum(CATEGORIES).optional(),
        includeScreens: z.boolean().optional().describe("Also list whole screens"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ repo: r, query, category, includeScreens }) =>
      withApp(rootOf(r), async (scan): Promise<Answer> => {
        const { components, previews } = await withPreviews(scan);
        const q = query?.toLowerCase();
        const found = components.filter(
          (c) =>
            (includeScreens || c.kind === "component") &&
            (!category || c.category === category) &&
            (!q || c.name.toLowerCase().includes(q)),
        );
        if (!found.length) return "No matching components.";
        const shown = found.slice(0, MAX_LISTED);
        const more =
          found.length > shown.length ? ` (showing ${shown.length}; narrow with query or category)` : "";
        const lines = shown.map((c) => `${brief(c)}${pictureNote(previews.get(c.id))}`);
        return `${plural(found.length, "component")}${more}:\n${lines.join("\n")}`;
      }),
  );

  server.registerTool(
    "get_component",
    {
      title: "Get a component",
      description:
        "One component's code, parameters, the colours and text styles it uses and where it's used, with how to draw a picture of it when it has none.",
      inputSchema: { repo, name, file },
      annotations: { readOnlyHint: true },
    },
    ({ repo: r, name: wanted, file: inFile }) =>
      withApp(rootOf(r), async (scan): Promise<Answer> => {
        const { components, previews } = await withPreviews(scan);
        const found = pick(scan.root, components, wanted, inFile);
        return typeof found === "string" ? failure(found) : describe(found, previews.get(found.id), scan);
      }),
  );

  server.registerTool(
    "save_preview",
    {
      title: "Save a picture of a component",
      description: `Saves an HTML picture of a component into designlane/previews/ and rebuilds designlane/catalog.html with it. Read the component with get_component first. ${PREVIEW_RULES}`,
      inputSchema: { repo, name, file, html: z.string().describe("The HTML fragment") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    ({ repo: r, name: wanted, file: inFile, html }) => {
      const problem = problemWith(html);
      if (problem) return Promise.resolve(failure(problem));
      return withApp(rootOf(r), async (scan): Promise<Answer> => {
        const { components, outDir } = await componentsOf(scan);
        const found = pick(scan.root, components, wanted, inFile);
        if (typeof found === "string") return failure(found);
        const saved = await savePreview(outDir, found, html);
        const catalog = await writeCatalog(scan, components, outDir);
        return `Saved ${appPath(scan.root, saved)}, and updated ${appPath(scan.root, catalog)}.`;
      });
    },
  );
}
