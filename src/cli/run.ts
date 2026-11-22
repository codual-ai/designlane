import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { writeOutputs } from "../output/write.js";
import { mergeAgentTokens } from "../scan/agent-tokens.js";
import { plural } from "../scan/counting.js";
import { isFolder, readGaps } from "../scan/files.js";
import { scanRepo } from "../scan/index.js";
import { scanNotes } from "../scan/notes.js";
import { FRAMEWORK_NAMES, type ScanResult, SUPPORTED_FRAMEWORKS } from "../scan/types.js";
import { AGENT_PROMPT } from "./agent-prompt.js";
import { type Output, UsageError } from "./command.js";
import { DOCTOR_USAGE, doctor } from "./doctor.js";
import { EDIT_USAGE, edit } from "./edit.js";

const HELP = `designlane: map a mobile app's design system from its code

Usage
  designlane [dir]  Read the app in dir (default: here) and write tokens.json, DESIGN.md, catalog.html and drift.md
                    into designlane/
  designlane mcp [dir]
                    Run the MCP server, so a coding agent reads the app's design system while it builds
  designlane prompt
                    Print instructions for a coding agent to read the app's design system into designlane/agent.json
${EDIT_USAGE}
${DOCTOR_USAGE}

Let a coding agent read an app whose setup Designlane's own reading misses
  claude -p "$(npx designlane prompt)" --allowedTools Read Glob Grep Write
  designlane --from-agent designlane/agent.json

Add to Claude Code
  claude mcp add designlane -- designlane mcp /path/to/app

Options
  --out <dir>       Write the files here instead
  --json            Print the whole scan as JSON instead of writing files
  --no-write        Print what was found, and write nothing
  --from-agent <file>
                    Add the colours and text styles a coding agent read (see prompt), those the code bears out
  -v, --version
  -h, --help
`;

/** Runs the command line with `argv` (without `node` and the script), and returns the exit code. */
export async function run(argv: string[], io: Output): Promise<number> {
  try {
    if (argv[0] === "edit") return await edit(argv.slice(1), io);
    if (argv[0] === "doctor") return await doctor(argv.slice(1), io);
    const { values, positionals } = parse(argv);
    if (values.help) return done(io.out, HELP);
    if (values.version) return done(io.out, await version());
    if (positionals[0] === "prompt") return done(io.out, AGENT_PROMPT);
    const serving = positionals[0] === "mcp";
    const root = await appFolder(serving ? positionals.slice(1) : positionals);
    // Awaited here, so a usage error thrown while mapping is caught below.
    return await (serving ? serve(root) : map(root, values, io));
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    io.error(`designlane: ${e.message}`);
    return e.code;
  }
}

/** The app folder the arguments name, or the current folder when they name none. */
async function appFolder(folders: string[]): Promise<string> {
  if (folders.length > 1) throw new UsageError(`expected one folder, got ${folders.length}\n\n${HELP}`, 2);
  const root = path.resolve(folders[0] ?? ".");
  if (!(await isFolder(root))) throw new UsageError(`not a folder: ${root}`, 1);
  return root;
}

/** Reads the app and writes tokens.json and DESIGN.md, or prints the scan with `--json`. */
async function map(
  root: string,
  values: { out?: string; json?: boolean; "no-write"?: boolean; "from-agent"?: string },
  { out, error }: Output,
): Promise<number> {
  let scan = await scanRepo(root);
  const gaps = readGaps(scan);
  if (gaps) error(`designlane: ${gaps}`);
  for (const note of scanNotes(scan)) error(`designlane: ${note}`);
  const agentFile = values["from-agent"];
  if (agentFile) {
    const merge = await fromAgent(scan, path.resolve(agentFile));
    scan = merge.scan;
    // With --json, stdout is the scan alone.
    (values.json ? error : out)(`Added ${plural(merge.added, "token")} from ${agentFile}`);
    if (merge.dropped.length) {
      const some = merge.dropped.slice(0, 5).join(", ");
      error(
        `designlane: left out ${plural(merge.dropped.length, "token")} the code doesn't bear out: ${some}${merge.dropped.length > 5 ? ", …" : ""}`,
      );
    }
  }
  if (values.json) return done(out, JSON.stringify(scan, null, 2));
  if (scan.frameworks.length === 0)
    throw new UsageError(`no ${SUPPORTED_FRAMEWORKS} code found in ${scan.root}`, 1);
  out(summary(scan));
  if (values["no-write"]) return 0;
  const written = await writeOutputs(scan, values.out ? path.resolve(values.out) : undefined);
  const files = [...written.tokens, written.design, written.catalog, written.drift];
  out(`Wrote ${files.map(shown).join("\n      ")}`);
  if (written.removed.length) {
    const now = written.tokens.map(shown).join(" or ");
    error(
      `designlane: removed ${written.removed.map(shown).join(", ")}, as the repo now has ${scan.frameworks.length === 1 ? "one app" : "more than one app"}: connect each Figma file to ${now}.`,
    );
  }
  return 0;
}

async function fromAgent(scan: ScanResult, file: string) {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    throw new UsageError(`couldn't read ${file}: ${(e as Error).message}`, 1);
  }
  try {
    return await mergeAgentTokens(scan, json);
  } catch (e) {
    throw new UsageError((e as Error).message, 1);
  }
}

/** Serves MCP over stdin and stdout until the agent disconnects; stdout belongs to the protocol from here on. */
async function serve(root: string): Promise<number> {
  // The MCP library loads only for this command, not for every map.
  const { createServer } = await import("../mcp/server.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  await createServer(root, await version()).connect(new StdioServerTransport());
  return 0;
}

function parse(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        out: { type: "string" },
        json: { type: "boolean" },
        "no-write": { type: "boolean" },
        "from-agent": { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (e) {
    throw new UsageError(`${(e as Error).message}\n\n${HELP}`, 2);
  }
}

function done(out: Output["out"], text: string): number {
  out(text);
  return 0;
}

/** What was found, in a few lines. */
function summary(scan: ScanResult): string {
  const several = scan.frameworks.length > 1;
  return scan.frameworks
    .map(({ framework, screens, tokens }) => {
      const pages = screens.filter((s) => s.kind === "screen").length;
      const colours = tokens.colors.length;
      const styles = tokens.typeStyles.length;
      const views = `${plural(pages, "screen")}, ${plural(screens.length - pages, "component")}`;
      const lines = [
        `${path.basename(scan.root)}${several ? ` (${FRAMEWORK_NAMES[framework]})` : ""}: ${views}`,
        `  ${plural(colours, "colour")}, ${plural(styles, "text style")}`,
      ];
      const top = tokens.colors.slice(0, 3).map((c) => `${c.name} (${c.uses})`);
      if (top.length) lines.push(`  most used colours: ${top.join(", ")}`);
      const themes = (tokens.themes ?? []).map((t) => t.name);
      if (themes.length) lines.push(`  ${plural(themes.length, "other theme")}: ${themes.join(", ")}`);
      return lines.join("\n");
    })
    .join("\n");
}

/** A path relative to where the command was run, unless it's outside it. */
function shown(file: string): string {
  const relative = path.relative(process.cwd(), file);
  return relative.startsWith("..") ? file : relative;
}

async function version(): Promise<string> {
  const manifest = new URL("../../package.json", import.meta.url);
  return JSON.parse(await readFile(manifest, "utf8")).version;
}
