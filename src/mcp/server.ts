/** The MCP server: hands a coding agent the app's design system while it builds, so new screens match the app. */

import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toDesignMd } from "../output/design-md.js";
import { linkNotes, type NamedLink, namedLinks, OPENING_WORDS } from "../output/screen-links.js";
import type { ScanResult, ScreenRef } from "../scan/types.js";
import { MAX_LISTED, withApp } from "./app.js";
import { registerComponentTools } from "./component-tools.js";
import { registerDriftTool } from "./drift-tool.js";

const INSTRUCTIONS = `Designlane reads this app's design system from its code.
When you build or change UI in this app:
1. Call get_design_system first. Prefer the app's most used colours, text styles, spacing and corner radii over new values.
2. Write values the way the app's code does. A token name is only a label: before using a name in code, search the code for it. If it isn't there (like hex-33a854 or system-15-semibold), write the value itself, in the app's own style.
3. Call find_components before creating a view, and reuse an existing component when one fits; get_component shows its code and parameters.
4. Call get_screen_links before adding or changing navigation, to open screens the way the app already does.
5. After writing UI code, call check_drift with the files you changed, and fix what it lists.
To add pictures to the catalog (designlane/catalog.html), read a component with get_component, then draw it with save_preview.
If a tool says only part of the app was read, its lists are incomplete.`;

const listed = (v: ScreenRef) => `- ${v.name} (${v.kind}) ${v.file}:${v.line}`;

function views(scan: ScanResult, query?: string, kind?: ScreenRef["kind"]): string {
  const q = query?.toLowerCase();
  const found = scan.frameworks
    .flatMap((f) => f.screens)
    .filter((v) => (!kind || v.kind === kind) && (!q || v.name.toLowerCase().includes(q)));
  if (!found.length) return "No matching views.";
  const shown = found.slice(0, MAX_LISTED);
  const more = found.length > shown.length ? ` (showing ${shown.length}; narrow with query or kind)` : "";
  return `${found.length} view${found.length === 1 ? "" : "s"}${more}:\n${shown.map(listed).join("\n")}`;
}

/** A server reading the app at `defaultRoot`, or at the `repo` a tool call names. */
export function createServer(defaultRoot: string, version: string): McpServer {
  const server = new McpServer({ name: "designlane", version }, { instructions: INSTRUCTIONS });
  const repo = z
    .string()
    .optional()
    .describe(`The app's folder. Defaults to ${defaultRoot}; a relative path is read from there`);
  const rootOf = (r?: string) => path.resolve(defaultRoot, r ?? ".");
  const annotations = { readOnlyHint: true } as const;

  server.registerTool(
    "get_design_system",
    {
      title: "Get the design system",
      description:
        "Call before building or restyling any UI in the app. Returns its DESIGN.md: colours and text styles most used first, with use counts and the file each is declared in, plus spacing, corner radii, screens and components. Token names are labels: search the code for one before using it.",
      inputSchema: { repo },
      annotations,
    },
    ({ repo: r }) => withApp(rootOf(r), toDesignMd),
  );

  server.registerTool(
    "find_views",
    {
      title: "Find views",
      description:
        "Call before creating a view, to reuse one the app already has. Returns its screens and components whose names contain the query, with the file and line of each.",
      inputSchema: {
        repo,
        query: z.string().optional().describe("Part of a name, e.g. Button or Row"),
        kind: z.enum(["screen", "component"]).optional(),
      },
      annotations,
    },
    ({ repo: r, query, kind }) => withApp(rootOf(r), (scan) => views(scan, query, kind)),
  );

  server.registerTool(
    "get_screen_links",
    {
      title: "Get screen links",
      description:
        "Call to see how the app moves between screens before adding or changing navigation. Returns which screen opens which, how (pushed, a dialog or a sheet) and the file and line where the code does it, for screens whose names contain the query.",
      inputSchema: { repo, query: z.string().optional().describe("Part of a screen's name, e.g. Settings") },
      annotations,
    },
    ({ repo: r, query }) => withApp(rootOf(r), (scan) => screenLinks(scan, query)),
  );

  registerComponentTools(server, repo, rootOf);
  registerDriftTool(server, repo, rootOf);
  return server;
}

function screenLinks(scan: ScanResult, query?: string): string {
  const notes = linkNotes(scan.frameworks).join(" ");
  const q = query?.toLowerCase();
  const found = namedLinks(scan.frameworks).filter(
    (l) => !q || l.fromName.toLowerCase().includes(q) || l.toName.toLowerCase().includes(q),
  );
  if (!found.length) return ["No links between screens found.", notes].filter(Boolean).join(" ");
  const shown = found.slice(0, MAX_LISTED);
  const more = found.length > shown.length ? ` (showing ${shown.length}; narrow with query)` : "";
  const line = (l: NamedLink) =>
    `- ${l.fromName} → ${l.toName} (${OPENING_WORDS[l.opening]}) ${l.file}:${l.line}`;
  const listed = `${found.length} link${found.length === 1 ? "" : "s"}${more}:\n${shown.map(line).join("\n")}`;
  return notes ? `${listed}\n\n${notes}` : listed;
}
