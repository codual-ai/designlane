import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { run } from "../../src/cli/run.js";
import { editableTokens } from "../../src/edit/edit-tokens.js";
import { scanRepo, toDesignTokens } from "../../src/index.js";
import { createServer } from "../../src/mcp/server.js";
import { loadPreviews, savePreview } from "../../src/previews/previews.js";
import { mergeAgentTokens } from "../../src/scan/agent-tokens.js";
import { readTokensFile } from "../../src/sync/tokens-file.js";
import { catalogOf, named, swift } from "../helpers/catalog.js";
import { beforeRename } from "../helpers/old-names.js";
import { tempDir } from "../helpers/temp.js";
import { tokensJson } from "../helpers/tokens-json.js";

const THEME = "App/Theme.swift";
const APP = {
  [THEME]: swift("enum Theme { static let brand = Color(red: 0.2, green: 0.4, blue: 0.9) }"),
  "App/Home.swift": swift(
    "struct Home: View { var body: some View { NavigationStack { Text(t).navigationTitle(t).tint(Theme.brand) } } }",
  ),
};
const FIXTURE = path.join(process.cwd(), "tests/fixtures/swiftui-app");

async function designlane(...argv: string[]) {
  const out: string[] = [];
  const error: string[] = [];
  const code = await run(argv, { out: (t) => out.push(t), error: (t) => error.push(t) });
  return { code, out: out.join("\n"), error: error.join("\n") };
}

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

describe("a tokens.json written before the rename to Designlane", () => {
  const written = async () => JSON.stringify(toDesignTokens(await scanRepo(FIXTURE)));
  const themed = tokensJson({
    app: "shop",
    platform: "android",
    partial: true,
    colors: [{ key: "brand", hex: "#3366cc", dark: "#6699ff" }],
    styles: [{ key: "title", size: 22, weight: 700 }],
    themes: [{ name: "Desert", colors: [{ key: "brand", hex: "#cc6633" }] }],
  });

  it("syncs as the same file written now, its app, platform and themes too", async () => {
    for (const json of [await written(), themed]) {
      expect(beforeRename(json)).not.toContain('"designlane"');
      expect(readTokensFile(JSON.parse(beforeRename(json)))).toEqual(readTokensFile(JSON.parse(json)));
    }
  });

  it("gives an edit the same tokens and the places their values are written", async () => {
    const json = await written();
    expect(editableTokens(JSON.parse(beforeRename(json)))).toEqual(editableTokens(JSON.parse(json)));
  });

  it("reads a file's own data, not the old copy, when a file has both", () => {
    const json = JSON.parse(tokensJson({ app: "shop", colors: [{ key: "brand", hex: "#3366cc" }] }));
    json.$extensions.designmap = { app: "old" };
    expect(readTokensFile(json).app).toBe("shop");
  });
});

describe("an app set up before the rename", () => {
  it("keeps its designmap/ folder, writing there and making no designlane/ beside it", async () => {
    const root = await tempDir({ ...APP, "designmap/tokens.json": "{}\n" });
    expect((await designlane(root)).code).toBe(0);
    const tokens = JSON.parse(await readFile(path.join(root, "designmap", "tokens.json"), "utf8"));
    expect(tokens.$extensions.designlane.app).toBe(path.basename(root));
    expect(await exists(path.join(root, "designmap", "DESIGN.md"))).toBe(true);
    expect(await exists(path.join(root, "designlane"))).toBe(false);
  });

  it("keeps designmap/ when designlane/ holds only the agent's file", async () => {
    const root = await tempDir({ ...APP, "designmap/tokens.json": "{}\n", "designlane/agent.json": "{}\n" });
    expect((await designlane(root)).code).toBe(0);
    expect(await exists(path.join(root, "designmap", "DESIGN.md"))).toBe(true);
    expect(await exists(path.join(root, "designlane", "DESIGN.md"))).toBe(false);
  });

  it("writes into designlane/ once it has a tokens file", async () => {
    const root = await tempDir({ ...APP, "designmap/tokens.json": "{}\n", "designlane/tokens.json": "{}\n" });
    expect((await designlane(root)).code).toBe(0);
    expect(await readFile(path.join(root, "designmap", "tokens.json"), "utf8")).toBe("{}\n");
    expect(await exists(path.join(root, "designlane", "DESIGN.md"))).toBe(true);
  });

  it("removes a tokens file of the other layout it wrote under the old name", async () => {
    const root = await tempDir(APP);
    expect((await designlane(root)).code).toBe(0);
    const other = path.join(root, "designlane", "tokens.android.json");
    await writeFile(
      other,
      beforeRename(tokensJson({ app: "shop", colors: [{ key: "brand", hex: "#3366cc" }] })),
    );
    expect((await designlane(root)).error).toContain("removed");
    expect(await exists(other)).toBe(false);
  });

  it("edits from designmap/tokens.json, written under the old name, when there's no designlane/ one", async () => {
    const root = await tempDir(APP);
    expect((await designlane(root, "--out", path.join(root, "designmap"))).code).toBe(0);
    const file = path.join(root, "designmap", "tokens.json");
    await writeFile(file, beforeRename(await readFile(file, "utf8")));
    const { code, out } = await designlane(
      "edit",
      "Theme.brand",
      "light",
      "#de2413",
      "--dir",
      root,
      "--dry-run",
    );
    expect(code).toBe(0);
    expect(out).toContain(`+++ b/${THEME}`);
  });

  it("never counts the agent's file in designmap/ as code bearing it out", async () => {
    const root = await tempDir({
      "package.json": '{ "dependencies": { "react-native": "0.76.0" } }',
      "src/Home.tsx": 'import { View } from "react-native";\nexport const Home = () => <View />;',
      "designmap/agent.json": '{ "colors": { "ghost": { "light": "#999999" } } }',
    });
    const { dropped } = await mergeAgentTokens(await scanRepo(root), {
      colors: { ghost: { light: "#999999" } },
    });
    expect(dropped).toEqual(["ghost"]);
  });

  it("saves a coding agent's picture into designmap/, with the catalog", async () => {
    const root = await tempDir({ ...APP, "designmap/tokens.json": "{}\n" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer(root, "0.0.0").connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    await client.callTool({ name: "save_preview", arguments: { name: "Home", html: "<b>Home</b>" } });
    expect(await exists(path.join(root, "designmap", "catalog.html"))).toBe(true);
    expect(await exists(path.join(root, "designlane"))).toBe(false);
  });

  it("shows a component's picture saved before the rename", async () => {
    const { components } = await catalogOf(APP);
    const home = named(components, "Home");
    const outDir = await tempDir();
    const file = await savePreview(outDir, home, "<b>Home</b>");
    await writeFile(file, (await readFile(file, "utf8")).replace("designlane-preview", "designmap-preview"));
    expect((await loadPreviews(outDir, [home])).get(home.id)).toEqual({
      html: "<b>Home</b>\n",
      stale: false,
    });
  });
});
