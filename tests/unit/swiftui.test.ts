import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseColorset } from "../../src/frameworks/xcode-colors.js";
import { scanRepo } from "../../src/scan/index.js";
import { speedIt } from "../helpers/speed.js";
import { tempDir } from "../helpers/temp.js";

const fixture = path.join(import.meta.dirname, "..", "fixtures", "swiftui-app");

describe("scanning a SwiftUI app", () => {
  it("finds the screen, its component and the app's design tokens", async () => {
    const scan = await scanRepo(fixture);
    expect(scan.frameworks.map((f) => f.framework)).toEqual(["swiftui"]);
    const fw = scan.frameworks[0]!;
    expect(fw.platforms).toEqual(["ios"]);
    expect(fw.screens.map((s) => [s.name, s.kind, s.file, s.line])).toEqual([
      ["PaywallView", "screen", "Shop/Views/PaywallView.swift", 3],
      ["PlanRow", "component", "Shop/Views/PlanRow.swift", 3],
    ]);
    const colors = Object.fromEntries(fw.tokens.colors.map((c) => [c.name, c]));
    expect(colors.AccentColor?.light).toBe("#334de6");
    expect(colors.Brand).toMatchObject({ light: "#ff1a2e", dark: "#ff5566" });
    expect(colors.ink?.light).toBe("#16161a");
    expect(colors.mist?.light).toBe("#f2f2f7");
    expect(colors.tintColor?.light).toBe("#bb3be2");
    expect(fw.tokens.fonts).toEqual(["Inter"]);
    expect(fw.tokens.spacing).toEqual([16, 12]);
    expect(fw.tokens.radii).toEqual([12]);
    expect(scan).toMatchObject({ truncated: false, unreadable: [] });
  });

  it("skips previews, tests and Swift files that don't use SwiftUI", async () => {
    const root = await tempDir({
      "App/HomeScreen.swift":
        'import SwiftUI\nstruct HomeScreen: View { var body: some View { Text("Hi") } }',
      "App/HomeScreen_Previews.swift":
        "import SwiftUI\nstruct HomeScreen_Previews: PreviewProvider { static var previews: some View { HomeScreen() } }",
      "AppTests/LoginViewTests.swift":
        "import SwiftUI\nstruct LoginScreen: View { var body: some View { EmptyView() } }",
      "App/Model.swift": "struct Habit: Codable { var name: String }",
    });
    const scan = await scanRepo(root);
    expect(scan.frameworks[0]?.screens.map((s) => s.name)).toEqual(["HomeScreen"]);
  });

  it("ranks a navigation screen in a Screens folder above a row component", async () => {
    const nav = 'NavigationStack { List { Text("a") }.navigationTitle("Habits") }';
    const root = await tempDir({
      "Screens/Habits.swift": `import SwiftUI\nstruct Habits: View { var body: some View { ${nav} } }`,
      "Components/HabitRow.swift":
        'import SwiftUI\nstruct HabitRow: View { var body: some View { Text("a") } }',
    });
    const screens = (await scanRepo(root)).frameworks[0]!.screens;
    expect(screens.map((s) => [s.name, s.kind])).toEqual([
      ["Habits", "screen"],
      ["HabitRow", "component"],
    ]);
  });

  it("ignores views in comments, strings and #Preview blocks", async () => {
    const root = await tempDir({
      "App/Home.swift": [
        "import SwiftUI",
        "// struct OldScreen: View {",
        "/* struct LegacyScreen: View {} */",
        'let note = "struct FakeScreen: View {"',
        "struct HomeScreen: View { var body: some View { Text(note) } }",
        "#Preview { struct PreviewHost: View { var body: some View { HomeScreen() } }; return PreviewHost() }",
      ].join("\n"),
    });
    expect((await scanRepo(root)).frameworks[0]?.screens.map((s) => s.name)).toEqual(["HomeScreen"]);
  });

  it("keeps real views whose names end in Preview", async () => {
    const root = await tempDir({
      "App/LinkPreview.swift":
        "import SwiftUI\nstruct LinkPreview: View { var body: some View { EmptyView() } }",
    });
    expect((await scanRepo(root)).frameworks[0]?.screens.map((s) => s.name)).toEqual(["LinkPreview"]);
  });

  it("scores a nested view on its own body, not its parent's", async () => {
    const root = await tempDir({
      "App/Outer.swift": [
        "import SwiftUI",
        "struct Outer: View {",
        '  struct Inner: View { var body: some View { NavigationStack { List {}.navigationTitle("x").toolbar {} } } }',
        "  var body: some View { Inner() }",
        "}",
      ].join("\n"),
    });
    const kinds = Object.fromEntries(
      (await scanRepo(root)).frameworks[0]!.screens.map((s) => [s.name, s.kind]),
    );
    // Inner has page-like code of its own, but the app only ever places it inside Outer.
    expect(kinds).toEqual({ Outer: "component", Inner: "component" });
  });

  it("scores a nested view on its own body when the parent doesn't place it", async () => {
    const root = await tempDir({
      "App/Outer.swift": [
        "import SwiftUI",
        "struct Outer: View {",
        '  struct Inner: View { var body: some View { NavigationStack { List {}.navigationTitle("x").toolbar {} } } }',
        '  var body: some View { Text("plain") }',
        "}",
      ].join("\n"),
    });
    const kinds = Object.fromEntries(
      (await scanRepo(root)).frameworks[0]!.screens.map((s) => [s.name, s.kind]),
    );
    expect(kinds).toEqual({ Outer: "component", Inner: "screen" });
  });

  it("treats files as SwiftUI when the module re-exports it", async () => {
    const root = await tempDir({
      "App/Exports.swift": "@_exported import SwiftUI",
      "App/Home.swift": "struct HomeScreen: View { var body: some View { EmptyView() } }",
    });
    expect((await scanRepo(root)).frameworks[0]?.screens.map((s) => s.name)).toEqual(["HomeScreen"]);
  });

  it.each([
    ["a Screen name", "HomeScreen", "App", "screen"],
    ["a Screens folder plus navigation", "Home", "Screens", "screen"],
    ["a component name, even with navigation", "HabitRow", "App", "component"],
    ["a plain view", "Home", "App", "component"],
  ])("ranks %s", async (_, name, folder, kind) => {
    const nav =
      folder === "Screens" || name === "HabitRow"
        ? "NavigationStack { List { } }.navigationTitle(t)"
        : "Text(t)";
    const root = await tempDir({
      [`${folder}/${name}.swift`]: `import SwiftUI\nstruct ${name}: View { var body: some View { ${nav} } }`,
    });
    expect((await scanRepo(root)).frameworks[0]?.screens[0]?.kind).toBe(kind);
  });

  it("counts a long body as a sign of a screen", async () => {
    const lines = Array.from({ length: 70 }, () => "    Text(t)").join("\n");
    const root = await tempDir({
      "App/Settings.swift": `import SwiftUI\nstruct Settings: View { var body: some View { ScrollView { List {\n${lines}\n} } } }`,
    });
    expect((await scanRepo(root)).frameworks[0]?.screens[0]).toMatchObject({ kind: "screen", score: 3 });
  });

  it("gives views with the same name in one file distinct ids", async () => {
    const root = await tempDir({
      "App/Row.swift": "import SwiftUI\n#if os(iOS)\nstruct Row: View {}\n#else\nstruct Row: View {}\n#endif",
    });
    const ids = (await scanRepo(root)).frameworks[0]!.screens.map((s) => s.id);
    expect(ids).toEqual(["swiftui:App/Row.swift#Row@3", "swiftui:App/Row.swift#Row@5"]);
  });

  it("groups font weights into families, most used first, and ignores commented-out fonts", async () => {
    const font = (name: string) => `.font(.custom("${name}", size: 12))`;
    const root = await tempDir({
      "App/Fonts.swift": [
        "import SwiftUI",
        `let a = Text(x)${font("Inter-Regular")}${font("Inter-Bold")}${font("Inter-SemiBold")}`,
        `let b = Text(x)${font("Playfair Display")}`,
        `// ${font("Comic Sans")}`,
        'let failure = Event.custom("PinCreateFailure")',
        'extension Font { static let heading: Font = .custom("Lora-Bold", size: 20) }',
        "let h = Text(x).font(.heading)",
        'let stacked = UIFont(name: "Lora-Regular_Medium", size: 14)',
        'let wrapped = Text(x).font(.custom("Merriweather",\n  size: 12))',
        'extension Font { static func serif(_ s: CGFloat) -> Font { .custom("Lora", fixedSize: s) } }',
        "let s = Text(x).font(.serif(14))",
        'let title = UILabel(); title.font = UIFont(name: "Lora-Italic", size: 20)',
      ].join("\n"),
    });
    expect((await scanRepo(root)).frameworks[0]?.tokens.fonts).toEqual([
      "Lora",
      "Inter",
      "Merriweather",
      "Playfair Display",
    ]);
  });

  speedIt("reads fonts quickly from a hostile file", async () => {
    const root = await tempDir({ "App/F.swift": `import SwiftUI\n${'.custom("x'.repeat(100_000)}` });
    const started = performance.now();
    await scanRepo(root);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("reads colour opacity and skips colours in comments", async () => {
    const root = await tempDir({
      "App/Colors.swift":
        'import SwiftUI\nlet glass = Color(red: 1, green: 1, blue: 1, opacity: 0.5)\n// let old = Color(hex: "#000000")',
    });
    const colors = (await scanRepo(root)).frameworks[0]?.tokens.colors;
    expect(colors).toEqual([
      {
        name: "glass",
        light: "#ffffff80",
        source: "App/Colors.swift",
        reference: "glass",
        line: 2,
        kind: "code",
        uses: 0,
        locations: { light: expect.objectContaining({ line: 2 }) },
      },
    ]);
  });

  it("finds generic views and views with several conformances", async () => {
    const root = await tempDir({
      "App/Views.swift":
        "import SwiftUI\nstruct Card<Content: View>: View { var body: some View { EmptyView() } }\nstruct Badge: View, Equatable { var body: some View { EmptyView() } }",
    });
    const names = (await scanRepo(root)).frameworks[0]!.screens.map((s) => s.name);
    expect(names.sort()).toEqual(["Badge", "Card"]);
  });

  it("reports no frameworks for a project without SwiftUI", async () => {
    const root = await tempDir({ "README.md": "# Not an app" });
    expect((await scanRepo(root)).frameworks).toEqual([]);
  });
});

describe("parseColorset", () => {
  const rel = "App/Assets.xcassets/Accent.colorset/Contents.json";
  const color = (components: Record<string, string>, appearances?: object[]) => ({
    color: { components },
    ...(appearances ? { appearances } : {}),
  });

  it("reads light and dark variants", () => {
    const json = JSON.stringify({
      colors: [
        color({ red: "1.000", green: "0.000", blue: "0.000", alpha: "1.000" }),
        color({ red: "0x00", green: "0x00", blue: "0xFF" }, [{ appearance: "luminosity", value: "dark" }]),
      ],
    });
    expect(parseColorset(rel, json)).toEqual({
      name: "Accent",
      light: "#ff0000",
      dark: "#0000ff",
      source: rel,
      reference: 'Color("Accent")',
      kind: "asset",
      locations: expect.any(Object),
    });
  });

  it("prefers an explicit light variant over the one for any appearance", () => {
    const luminosity = (value: string) => [{ appearance: "luminosity", value }];
    const json = JSON.stringify({
      colors: [
        color({ red: "1.000", green: "1.000", blue: "1.000" }),
        color({ red: "0xA6", green: "0xA6", blue: "0xA6" }, luminosity("light")),
        color({ red: "0x76", green: "0x76", blue: "0x76" }, luminosity("dark")),
      ],
    });
    expect(parseColorset(rel, json)).toMatchObject({ light: "#a6a6a6", dark: "#767676" });
  });

  it("falls back to the colour for any appearance when the light one can't be read, in either order", () => {
    const unreadable = color({ red: "", green: "", blue: "" }, [
      { appearance: "luminosity", value: "light" },
    ]);
    const anyAppearance = color({ red: "0x10", green: "0x00", blue: "0x00" });
    for (const colors of [
      [unreadable, anyAppearance],
      [anyAppearance, unreadable],
    ]) {
      expect(parseColorset(rel, JSON.stringify({ colors }))?.light).toBe("#100000");
    }
  });

  it("takes the first readable dark entry, skipping unreadable ones, not the last", () => {
    const dark = [{ appearance: "luminosity", value: "dark" }];
    const json = JSON.stringify({
      colors: [
        color({ red: "0x10", green: "0x00", blue: "0x00" }),
        color({ red: "", green: "", blue: "" }, dark),
        color({ red: "0x20", green: "0x00", blue: "0x00" }, dark),
        color({ red: "0x40", green: "0x00", blue: "0x00" }, dark),
      ],
    });
    expect(parseColorset(rel, json)).toMatchObject({ light: "#100000", dark: "#200000" });
  });

  it("falls back to the colour for any appearance when the only dark entry can't be read", () => {
    const json = JSON.stringify({
      colors: [
        color({ red: "0x10", green: "0x00", blue: "0x00" }),
        color({ red: "0x20", green: "0x00", blue: "0x00" }, [{ appearance: "luminosity", value: "light" }]),
        color({ red: "", green: "", blue: "" }, [{ appearance: "luminosity", value: "dark" }]),
      ],
    });
    expect(parseColorset(rel, json)).toMatchObject({ light: "#200000", dark: "#100000" });
  });

  it("shows the colour for any appearance in dark mode when only light is set explicitly", () => {
    const json = JSON.stringify({
      colors: [
        color({ red: "0x10", green: "0x00", blue: "0x00" }),
        color({ red: "0x20", green: "0x00", blue: "0x00" }, [{ appearance: "luminosity", value: "light" }]),
      ],
    });
    expect(parseColorset(rel, json)).toMatchObject({ light: "#200000", dark: "#100000" });
  });

  it("reads grayscale colours and drops a dark variant equal to light", () => {
    const json = JSON.stringify({
      colors: [
        color({ white: "0.5", alpha: "1.000" }),
        color({ white: "0.5", alpha: "1.000" }, [{ appearance: "luminosity", value: "dark" }]),
      ],
    });
    expect(parseColorset(rel, json)).toEqual({
      name: "Accent",
      light: "#808080",
      source: rel,
      reference: 'Color("Accent")',
      kind: "asset",
      locations: expect.any(Object),
    });
  });

  it("reads each of Xcode's channel formats: floating point, 8-bit and hexadecimal", () => {
    const json = (components: Record<string, string>) => JSON.stringify({ colors: [color(components)] });
    expect(parseColorset(rel, json({ red: "1.000", green: "0.500", blue: "0.000" }))?.light).toBe("#ff8000");
    expect(parseColorset(rel, json({ red: "255", green: "128", blue: "1" }))?.light).toBe("#ff8001");
    expect(parseColorset(rel, json({ red: "0xFF", green: "0x80", blue: "0x01" }))?.light).toBe("#ff8001");
    expect(parseColorset(rel, json({ red: "1.000", green: "1.000", blue: "1.000", alpha: "1" }))?.light).toBe(
      "#ffffff",
    );
    expect(
      parseColorset(rel, json({ red: "1.000", green: "1.000", blue: "1.000", alpha: "0.500" }))?.light,
    ).toBe("#ffffff80");
  });

  it.each(["oops", "", "0x"])("skips a colour whose channel can't be read (%j)", (bad) => {
    const json = JSON.stringify({ colors: [color({ red: bad, green: "1.000", blue: "1.000" })] });
    expect(parseColorset(rel, json)).toBeUndefined();
  });

  it("ignores high-contrast variants", () => {
    const json = JSON.stringify({
      colors: [
        color({ red: "1.000", green: "1.000", blue: "1.000" }),
        color({ red: "0.000", green: "0.000", blue: "0.000" }, [{ appearance: "contrast", value: "high" }]),
      ],
    });
    expect(parseColorset(rel, json)).toEqual({
      name: "Accent",
      light: "#ffffff",
      source: rel,
      reference: 'Color("Accent")',
      kind: "asset",
      locations: expect.any(Object),
    });
  });

  it.each(["not json", '{"colors": "wrong shape"}', '{"colors": []}'])("returns nothing for %j", (text) => {
    expect(parseColorset(rel, text)).toBeUndefined();
  });
});
