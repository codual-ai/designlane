import { chmod, readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createServer } from "../../src/mcp/server.js";
import { tempDir } from "../helpers/temp.js";

const APP = {
  "App/Theme.swift":
    "import SwiftUI\nenum Theme { static let brand = Color(red: 0.2, green: 0.4, blue: 0.9) }",
  "App/Home.swift": [
    "import SwiftUI",
    "struct Home: View {",
    "  var body: some View { NavigationStack { List { PriceRow() }.navigationTitle(t).tint(Theme.brand) } }",
    "}",
    "struct PriceRow: View { var body: some View { Text(p) } }",
  ].join("\n"),
};

/** A client connected to a server reading `root`. */
async function connect(root: string) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(root, "1.2.3").connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as { text: string }[];
  return { text: first?.text ?? "", isError: result.isError === true };
}

describe("MCP server", () => {
  it("tells the agent to use the app's own names, and offers read-only tools", async () => {
    const client = await connect(await tempDir(APP));
    expect(client.getServerVersion()).toMatchObject({ name: "designlane", version: "1.2.3" });
    expect(client.getInstructions()).toContain("1. Call get_design_system first.");
    const { tools } = await client.listTools();
    expect(tools.map((t) => [t.name, t.annotations?.readOnlyHint])).toEqual([
      ["get_design_system", true],
      ["find_views", true],
      ["get_screen_links", true],
      ["find_components", true],
      ["get_component", true],
      ["save_preview", false],
      ["check_drift", true],
    ]);
  });

  describe("components", () => {
    const SHOP = {
      ...APP,
      "App/Home.swift": [
        "import SwiftUI",
        "struct Home: View {",
        "  var body: some View { NavigationStack { List { PriceRow(price: p); PriceRow(price: q) }.navigationTitle(t).tint(Theme.brand) } }",
        "}",
        "struct PriceRow: View { let price: String; var body: some View { Text(price).foregroundStyle(Theme.brand) } }",
      ].join("\n"),
      "App/Other.swift":
        "import SwiftUI\nstruct Banner: View { var body: some View { Text(t) } }\nstruct Wrap: View { var body: some View { Banner() } }",
      "App/More.swift": "import SwiftUI\nstruct Banner: View { var body: some View { Text(u) } }",
    };

    it("finds components by name or category, most used first, with their uses and parameters", async () => {
      const client = await connect(await tempDir(SHOP));
      expect((await call(client, "find_components", { query: "row" })).text).toBe(
        "1 component:\n- PriceRow (list, SwiftUI) App/Home.swift:5 · used 2× · price: String",
      );
      expect((await call(client, "find_components", { category: "card" })).text).toContain(
        "2 components:\n- Banner (card",
      );
      expect((await call(client, "find_components", { query: "home" })).text).toBe("No matching components.");
      expect((await call(client, "find_components", { query: "home", includeScreens: true })).text).toContain(
        "- Home (screen, SwiftUI)",
      );
    });

    it("gives a component's code, parameters and colours, with how to draw it", async () => {
      const { text, isError } = await call(await connect(await tempDir(SHOP)), "get_component", {
        name: "PriceRow",
      });
      expect(isError).toBe(false);
      expect(text).toContain("PriceRow · list · SwiftUI · App/Home.swift:5");
      expect(text).toContain("Parameters: price: String\nColours: brand\n");
      expect(text).toContain("```\nstruct PriceRow: View {");
      expect(text).toContain("Picture: none yet. Draw it as one HTML fragment");
      expect(text).toContain("CSS variables: --color-brand (#3366e6)");
    });

    it("asks for the file when two components share a name", async () => {
      const client = await connect(await tempDir(SHOP));
      expect(await call(client, "get_component", { name: "Banner" })).toEqual({
        isError: true,
        text: "2 components are named Banner: pass file (App/Other.swift, App/More.swift).",
      });
      expect(
        (await call(client, "get_component", { name: "Banner", file: "./App/More.swift" })).text,
      ).toContain("App/More.swift:2");
      expect((await call(client, "get_component", { name: "Nope" })).isError).toBe(true);
    });

    it("saves a picture and rebuilds the catalog with it, refusing one with a script", async () => {
      const root = await tempDir(SHOP);
      const client = await connect(root);
      const refused = await call(client, "save_preview", { name: "PriceRow", html: "<script>x</script>" });
      expect(refused).toEqual({
        isError: true,
        text: "Remove scripts and event handlers: previews are still pictures.",
      });
      const saved = await call(client, "save_preview", { name: "PriceRow", html: "<b>$4.99</b>" });
      expect(saved.text).toMatch(
        /^Saved designlane\/previews\/PriceRow-[0-9a-f]{8}\.html, and updated designlane\/catalog\.html\.$/,
      );
      const catalog = await readFile(path.join(root, "designlane", "catalog.html"), "utf8");
      expect(catalog).toContain('sandbox="" loading="lazy" srcdoc="');
      expect(catalog).toContain("&lt;b&gt;$4.99&lt;/b&gt;");
      expect((await call(client, "find_components", { query: "row" })).text).toContain("· has a picture");
      expect((await call(client, "get_component", { name: "PriceRow" })).text).toContain("Picture: saved.");
    });

    it("checks drift, in just the files named when given", async () => {
      const root = await tempDir({
        ...SHOP,
        "App/Promo.swift":
          "import SwiftUI\nstruct Promo: View { var body: some View { Text(t).foregroundStyle(Color(red: 0.2, green: 0.4, blue: 0.9)) } }",
      });
      const client = await connect(root);
      expect((await call(client, "check_drift")).text).toBe(
        "Colours written as values:\n- #3366e6 → use Theme.brand · App/Promo.swift:2",
      );
      expect((await call(client, "check_drift", { files: ["App/Home.swift"] })).text).toBe(
        "No drift in these files.",
      );
    });
  });

  it("hands over the design system as a DESIGN.md", async () => {
    const { text, isError } = await call(await connect(await tempDir(APP)), "get_design_system");
    expect(isError).toBe(false);
    expect(text).toContain('  brand: "#3366e6"');
    expect(text).toContain("- **brand** `#3366e6`: 1 use, from `App/Theme.swift` as `Theme.brand`.");
  });

  it("finds views by part of a name or by kind, with where each is", async () => {
    const client = await connect(await tempDir(APP));
    expect((await call(client, "find_views", { query: "row" })).text).toBe(
      "1 view:\n- PriceRow (component) App/Home.swift:5",
    );
    expect((await call(client, "find_views", { kind: "screen" })).text).toBe(
      "1 view:\n- Home (screen) App/Home.swift:2",
    );
    expect((await call(client, "find_views", { query: "nothing" })).text).toBe("No matching views.");
  });

  it("says a wrong path is wrong, and reads a relative path from the app's folder", async () => {
    const root = await tempDir(APP);
    const client = await connect(root);
    const file = await call(client, "get_design_system", { repo: "App/Home.swift" });
    expect(file).toEqual({
      isError: true,
      text: `Not a folder: ${path.join(root, "App", "Home.swift")}. Pass the app's folder as repo.`,
    });
    expect((await call(client, "find_views", { repo: ".", query: "row" })).text).toContain("PriceRow");
  });

  it.skipIf(process.platform === "win32")("says when only part of the app could be read", async () => {
    const root = await tempDir({ ...APP, "Locked/A.swift": "" });
    await chmod(path.join(root, "Locked"), 0o000);
    try {
      const { text } = await call(await connect(root), "find_views", { kind: "screen" });
      expect(text).toBe(
        "Only part of the app was read: 1 folder couldn't be opened (Locked; check their permissions).\n\n1 view:\n- Home (screen) App/Home.swift:2",
      );
    } finally {
      await chmod(path.join(root, "Locked"), 0o755);
    }
  });

  it("tells the agent to check a token name exists in the code before using it", async () => {
    const instructions = (await connect(await tempDir(APP))).getInstructions() ?? "";
    expect(instructions).toContain("before using a name in code, search the code for it");
    expect(instructions).toContain(
      "If it isn't there (like hex-33a854 or system-15-semibold), write the value itself",
    );
  });

  it("reads another app when a call names one, and says so when it has no SwiftUI code", async () => {
    const client = await connect(await tempDir({ "README.md": "hi" }));
    const empty = await call(client, "get_design_system");
    expect(empty.isError).toBe(true);
    expect(empty.text).toMatch(/^No SwiftUI, Jetpack Compose or React Native code found in /);
    const other = await call(client, "find_views", { repo: await tempDir(APP), kind: "screen" });
    expect(other.text).toContain("Home");
  });

  it("lists links between screens, filtered by name, and says when an app's links aren't read", async () => {
    const compose = await tempDir({
      "app/Views.kt":
        "import androidx.compose.runtime.Composable\n@Composable fun Inbox(onOpen: () -> Unit) { }\n@Composable fun Thread() { }",
      "app/Nav.kt":
        "import androidx.compose.runtime.Composable\n@Composable fun Nav() { NavHost(nav, InboxRoute) { composable<InboxRoute> { Inbox(onOpen = { nav.navigate(ThreadRoute) }) }; dialog<ThreadRoute> { Thread() } } }",
    });
    const client = await connect(compose);
    expect((await call(client, "get_screen_links")).text).toBe(
      "1 link:\n- Inbox → Thread (dialog) app/Nav.kt:2\n\nThe app starts on Inbox.",
    );
    expect((await call(client, "get_screen_links", { query: "settings" })).text).toBe(
      "No links between screens found. The app starts on Inbox.",
    );
    const swift = await tempDir({
      "App/Home.swift": [
        "import SwiftUI",
        "struct Home: View { var body: some View { NavigationStack { Text(t).sheet(isPresented: $s) { Settings() } } } }",
        "struct Settings: View { var body: some View { Text(t) } }",
      ].join("\n"),
    });
    expect((await call(await connect(swift), "get_screen_links")).text).toBe(
      "1 link:\n- Home → Settings (sheet) App/Home.swift:2",
    );
  });

  it("turns an unexpected failure into a message the agent can act on", async () => {
    vi.resetModules();
    vi.doMock("../../src/scan/index.js", () => ({
      scanRepo: async () => {
        throw new Error("disk read failed");
      },
    }));
    try {
      const { createServer: withFailingScan } = await import("../../src/mcp/server.js");
      const root = await tempDir(APP);
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await withFailingScan(root, "0").connect(serverSide);
      const client = new Client({ name: "test", version: "0" });
      await client.connect(clientSide);
      expect(await call(client, "find_views")).toEqual({
        isError: true,
        text: `Designlane couldn't read ${root}: disk read failed`,
      });
    } finally {
      vi.doUnmock("../../src/scan/index.js");
      vi.resetModules();
    }
  });
});
