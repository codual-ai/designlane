/** The SwiftUI Shop fixture scanned by designmap, pushed to a GitHub on a local server, and a Figma file connected to
 * it and synced: what the end-to-end design-to-code tests start from. */

import { cp, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import type { FigmaChange, PlannedEdit, ToWindow } from "../../figma-plugin/src/messages.js";
import { run } from "../../src/cli/run.js";
import { useGitHubServer } from "./figma-fetch.js";
import { plugin } from "./figma-plugin.js";
import { type Access, type GitHubServer, startGitHubServer } from "./github-server.js";
import { tempDir } from "./temp.js";

export const REPO = "octo/shop";
export const BRANCH = "main";
export const TOKENS_PATH = "designmap/tokens.json";
export const READ_TOKEN = "github_pat_read";
export const WRITE_TOKEN = "github_pat_write";
/** The Figma collection a sync makes for the app, named after its folder. */
export const COLLECTION = "Shop (Designmap)";

const FIXTURE = path.join(process.cwd(), "tests/fixtures/swiftui-app");
const PAYWALL = "Shop/Views/PaywallView.swift";
const TYPOGRAPHY = "Shop/Theme/Typography.swift";
/** The paywall's title font, written inline in the fixture, which the edit engine can't change. */
const INLINE_FONT = '.font(.custom("Inter", size: 34))\n                        .bold()';
/** The same title in a text style of its own, which the edit engine can find in the code. */
const DISPLAY_STYLE =
  'import SwiftUI\n\nextension Font {\n    static let display: Font = .custom("Inter", size: 34)\n}\n';
const TOKENS: Record<string, Access> = { [READ_TOKEN]: "read", [WRITE_TOKEN]: "write" };

const servers: GitHubServer[] = [];

/** Stops every server the tests started. */
export const closeServers = () => Promise.all(servers.splice(0).map((server) => server.close()));

/** Runs the designmap CLI as `node dist/cli/main.js` does, failing on a non-zero exit. */
export async function designmap(...argv: string[]): Promise<void> {
  const error: string[] = [];
  const code = await run(argv, { out: () => {}, error: (text) => error.push(text) });
  if (code !== 0) throw new Error(`designmap ${argv.join(" ")} exited ${code}: ${error.join("\n")}`);
}

/** The Shop fixture copied into a temporary folder, its title given a text style, and scanned. */
async function scannedShop(): Promise<string> {
  const app = path.join(await tempDir(), "Shop");
  await cp(FIXTURE, app, { recursive: true });
  const paywall = await readFile(path.join(app, PAYWALL), "utf8");
  if (!paywall.includes(INLINE_FONT)) throw new Error(`the fixture's paywall no longer sets ${INLINE_FONT}`);
  await writeFile(path.join(app, PAYWALL), paywall.replace(INLINE_FONT, ".font(.display)"));
  await writeFile(path.join(app, TYPOGRAPHY), DISPLAY_STYLE);
  await designmap(app);
  return app;
}

/** A copy of `app` with `changed` written over its files. */
export async function copyOf(app: string, changed: Map<string, string> = new Map()): Promise<string> {
  const copy = await tempDir();
  await cp(app, copy, { recursive: true });
  for (const [file, text] of changed) await writeFile(path.join(copy, file), text);
  return copy;
}

/** Every file in `folder`, by its path there with forward slashes. */
export async function filesIn(folder: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    files.set(path.relative(folder, file).split(path.sep).join("/"), await readFile(file, "utf8"));
  }
  return files;
}

/** The scanned Shop pushed to `octo/shop` on a local GitHub, and a Figma file connected to it and synced. */
export async function connectedShop() {
  const app = await scannedShop();
  const server = await startGitHubServer({
    repo: REPO,
    branch: BRANCH,
    files: await filesIn(app),
    tokens: TOKENS,
  });
  servers.push(server);
  useGitHubServer(server);
  const figma = plugin();
  let id = 0;
  const reply = async (message: unknown): Promise<ToWindow> => {
    await figma.session(message);
    const last = figma.last();
    if (!last) throw new Error("the plugin sent nothing");
    return last;
  };
  const connect = {
    type: "connect",
    id: ++id,
    repo: REPO,
    branch: BRANCH,
    path: TOKENS_PATH,
    token: READ_TOKEN,
  };
  expect(await reply(connect)).toMatchObject({ type: "plan", id });
  expect(await reply({ type: "apply", id })).toMatchObject({ type: "applied" });

  return {
    app,
    server,
    fake: figma.fake,
    /** Checks the repo again: the changes made in Figma the plan found. */
    async check(): Promise<FigmaChange[]> {
      const plan = await reply({ type: "fetch", id: ++id });
      if (plan.type !== "plan") throw new Error(`expected a plan, got ${JSON.stringify(plan)}`);
      return plan.summary.figmaChanges;
    },
    async planEdits(changes: FigmaChange[]): Promise<PlannedEdit[]> {
      const edits = await reply({ type: "planEdits", id, changes: changes.map((change) => change.id) });
      if (edits.type !== "edits") throw new Error(`expected edits, got ${JSON.stringify(edits)}`);
      return edits.edits;
    },
    openPullRequest: (changes: FigmaChange[], token?: string) =>
      reply({
        type: "openPullRequest",
        id,
        changes: changes.map((change) => change.id),
        ...(token === undefined ? {} : { token }),
      }),
    /** What the plugin asked GitHub to write, after the first `from` requests. */
    writesSince: (from = 0) => server.requests.slice(from).filter((request) => request.method !== "GET"),
  };
}

export type ConnectedShop = Awaited<ReturnType<typeof connectedShop>>;
