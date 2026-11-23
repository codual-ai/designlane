import { describe, expect, it } from "vitest";
import { inventory } from "../../src/catalog/components.js";
import { categoryFromMap, confirmComponents } from "../../src/catalog/map-components.js";
import { readSources } from "../../src/catalog/sources.js";
import { toCatalogHtml } from "../../src/output/catalog-html.js";
import { toDesignMd } from "../../src/output/design-md.js";
import { applyMap } from "../../src/scan/agent-map.js";
import { scanRepo } from "../../src/scan/index.js";
import { speedIt } from "../helpers/speed.js";
import { tempDir } from "../helpers/temp.js";

/** The map's components checked against an app of `files`. */
async function confirm(files: Record<string, string>, components: Record<string, object>) {
  const scan = await scanRepo(await tempDir(files));
  const tokens = await applyMap(scan, { version: 1, components });
  const reading = confirmComponents(tokens, await readSources(tokens.scan));
  const views = reading.scan.frameworks[0]?.screens ?? [];
  return { reading, views, left: reading.unconfirmed.map((u) => [u.reference, u.kind]) };
}

const SWIFT = {
  "App/PrimaryButton.swift": [
    "import SwiftUI",
    "struct PrimaryButton: View {",
    "  let title: String",
    "  var action: () -> Void = {}",
    "  var body: some View { Button(title, action: action) }",
    "}",
  ].join("\n"),
  "App/HomeScreen.swift": [
    "import SwiftUI",
    "struct HomeScreen: View {",
    '  var body: some View { NavigationStack { List { Text("a"); Text("b") }.navigationTitle("Home").toolbar { Button("x") {} } } }',
    "}",
  ].join("\n"),
  "App/App.swift":
    "import SwiftUI\n@main struct A: App { var body: some Scene { WindowGroup { HomeScreen() } } }",
  "App/Home.swift": [
    "import SwiftUI",
    'struct Home: View { var body: some View { VStack { PrimaryButton(title: "Go"); Badge(); Badge() } } }',
    'struct Badge: View { var body: some View { Text("1") } }',
  ].join("\n"),
};

describe("an agent map's components", () => {
  it("marks a view declared where the map says as the design system's, with its category, and checks each parameter", async () => {
    const { reading, views, left } = await confirm(SWIFT, {
      PrimaryButton: {
        category: "button",
        parameters: ["title", "action", "icon"],
        at: "App/PrimaryButton.swift:2",
      },
      "DesignSystem.Missing": { category: "card", parameters: [], at: "App/PrimaryButton.swift:2" },
      Home: { category: "row", parameters: [], at: "App/Home.swift:9" },
      HomeScreen: { category: "screen", parameters: [], at: "App/HomeScreen.swift:2" },
      // Declared at that line, but in another file.
      "Other.PrimaryButton": { category: "button", parameters: [], at: "App/Home.swift:2" },
    });
    expect(left).toEqual([
      ["PrimaryButton(icon)", "no-parameter"],
      ["DesignSystem.Missing", "no-component"],
      ["Home", "no-component"],
      ["Other.PrimaryButton", "no-component"],
    ]);
    expect(reading.confirmed).toBe(2);
    expect(views.find((v) => v.name === "PrimaryButton")).toMatchObject({
      kind: "component",
      category: "button",
      designSystem: true,
    });
    expect(views.find((v) => v.name === "Home")?.designSystem).toBeUndefined();
    // A screen the map lists stays a screen.
    expect(views.find((v) => v.name === "HomeScreen")).toMatchObject({ kind: "screen", designSystem: true });
  });

  it("finds a composable from its fun line however long its parameters, the overload the map's line is in", async () => {
    const { views, left } = await confirm(
      {
        "app/src/main/java/a/Button.kt": [
          "import androidx.compose.runtime.Composable",
          "@Composable",
          "fun AppButton(",
          "  onClick: () -> Unit,",
          "  modifier: Modifier = Modifier,",
          "  enabled: Boolean = true,",
          "  text: String,",
          ") { Text(text) }",
          "",
          "@Composable",
          "fun AppButton(",
          "  onClick: () -> Unit,",
          "  content: @Composable () -> Unit,",
          ") { content() }",
          '@Composable fun Home() { AppButton(onClick = {}, text = "a") }',
        ].join("\n"),
      },
      {
        AppButton: {
          category: "button",
          parameters: ["onClick", "content"],
          // The second's annotation, which the first's body is a line or two from too: the nearest is meant.
          at: "app/src/main/java/a/Button.kt:10",
        },
      },
    );
    expect(left).toEqual([]);
    const marked = views.filter((v) => v.designSystem);
    expect(marked.map((v) => [v.name, v.line >= 11])).toEqual([["AppButton", true]]);
  });

  it("takes a React Native component's props from its props type, destructuring or reads", async () => {
    const { left } = await confirm(
      {
        "package.json": '{ "dependencies": { "react-native": "0.76.0" } }',
        "src/Button.tsx": [
          'import { Pressable, Text } from "react-native";',
          "",
          "export default function Button(props) {",
          "  const { title } = props;",
          "  return <Pressable onPress={props.onPress}><Text>{title}</Text></Pressable>;",
          "}",
        ].join("\n"),
        "src/Home.tsx":
          'import Button from "./Button";\nexport function Home() { return <Button title="a" />; }',
      },
      { Button: { category: "button", parameters: ["title", "onPress", "icon"], at: "src/Button.tsx:3" } },
    );
    expect(left).toEqual([["Button(icon)", "no-parameter"]]);
  });

  it.each([
    ["row", "list"],
    ["avatar", "media"],
    ["chip", "label"],
    ["toolbar", "header"],
    ["Button", "button"],
    ["widget", "other"],
  ])("reads the map's category %s as %s", (word, category) => {
    expect(categoryFromMap(word)).toBe(category);
  });

  it("shows the design system's components first in the catalog, with their filter, and lists them in DESIGN.md", async () => {
    const { reading } = await confirm(SWIFT, {
      PrimaryButton: { category: "button", parameters: [], at: "App/PrimaryButton.swift:2" },
    });
    const components = inventory(reading.scan, await readSources(reading.scan));
    expect(components[0]).toMatchObject({ name: "PrimaryButton", designSystem: true, category: "button" });
    const html = toCatalogHtml(reading.scan, components);
    expect(html).toContain('data-category-filter="design-system"');
    expect(html).toContain("Design system · ");
    expect(html).toContain("category==='design-system'&&card.dataset.designSystem==='true'");
    const md = toDesignMd(reading.scan);
    expect(md).toContain("## Components\n\n- **PrimaryButton** (button): `App/PrimaryButton.swift:2`");
    expect(md).not.toContain("No agent's map names");
  });
});

describe("an agent map's components: review", () => {
  it("takes no argument another view is passed, nor an object's key, nor a name the map writes differently", async () => {
    const { left } = await confirm(
      {
        "App/Badge.swift": [
          "import SwiftUI",
          "struct Badge: View {",
          "  init(tag: String, count: Int = 0) {}",
          '  var body: some View { Image(systemName: "star").font(.system(size: 12)).background(Theme(color: "red")) }',
          "}",
        ].join("\n"),
      },
      {
        Badge: {
          category: "constructor",
          parameters: ["systemName", "size", "color", "tag", "count", "ta-g"],
          at: "App/Badge.swift:2",
        },
      },
    );
    expect(left).toEqual([
      ["Badge(systemName)", "no-parameter"],
      ["Badge(size)", "no-parameter"],
      ["Badge(color)", "no-parameter"],
      ["Badge(ta-g)", "no-parameter"],
    ]);
  });

  it("takes the overload whose declaration holds the map's line, and a vararg parameter", async () => {
    const { views, left } = await confirm(
      {
        "app/src/main/java/a/Link.kt": [
          "import androidx.compose.runtime.Composable",
          "@Composable",
          "fun Link(",
          "  vararg args: String,",
          "  text: String,",
          "  onClick: () -> Unit,",
          "  modifier: Modifier = Modifier,",
          ") { Text(text) }",
          "@Composable",
          "fun Link(",
          "  onClick: () -> Unit,",
          ') { Text("a") }',
          '@Composable fun Home() { Link("a", text = "b", onClick = {}) }',
        ].join("\n"),
      },
      // Where the first's parameters end, nearer the second's start than the first's.
      { Link: { category: "label", parameters: ["args", "text"], at: "app/src/main/java/a/Link.kt:8" } },
    );
    expect(left).toEqual([]);
    expect(views.filter((v) => v.designSystem).map((v) => v.line <= 8)).toEqual([true]);
  });

  it("keeps a screen's map category, and gives an unknown word's none of an object's", async () => {
    const { views } = await confirm(SWIFT, {
      HomeScreen: { category: "screen", parameters: [], at: "App/HomeScreen.swift:2" },
      PrimaryButton: { category: "__proto__", parameters: [], at: "App/PrimaryButton.swift:2" },
    });
    expect(views.find((v) => v.name === "HomeScreen")?.category).toBe("screen");
    expect(views.find((v) => v.name === "PrimaryButton")?.category).toBe("other");
  });

  it("takes a Swift view's inputs only: init labels, attributed ones, and wrapped properties a caller sets", async () => {
    const { left } = await confirm(
      {
        "App/Row.swift": [
          "import SwiftUI",
          "struct Row: View {",
          "  @State public var viewModel: Model",
          "  @State private var count = 0",
          "  init(label text: String, _ value: Int, @ViewBuilder content: () -> some View, tag: String, pair: (first: Int, second: Int)) {",
          "    let local = 1",
          "  }",
          '  var body: some View { Text("a") }',
          "}",
        ].join("\n"),
      },
      {
        Row: {
          category: "row",
          parameters: [
            "viewModel",
            "label",
            "value",
            "content",
            "tag",
            "pair",
            "count",
            "body",
            "local",
            "text",
            "second",
          ],
          at: "App/Row.swift:2",
        },
      },
    );
    expect(left.map(([r]) => r)).toEqual([
      "Row(count)",
      "Row(body)",
      "Row(local)",
      "Row(text)",
      "Row(second)",
    ]);
  });

  it("takes a React Native component's props by their keys, its readonly ones by name, and no local", async () => {
    const { left } = await confirm(
      {
        "package.json": '{ "dependencies": { "react-native": "0.76.0" } }',
        "src/Card.tsx": [
          'import { View } from "react-native";',
          "export default function Card(props: { readonly title: string }) {",
          "  const { subtitle: label, onPress = noop, ...rest } = props;",
          "  return <View>{label}</View>;",
          "}",
        ].join("\n"),
        "src/Home.tsx": 'import Card from "./Card";\nexport function Home() { return <Card title="a" />; }',
      },
      {
        Card: {
          category: "card",
          parameters: ["title", "subtitle", "onPress", "rest", "label", "noop", "readonly"],
          at: "src/Card.tsx:2",
        },
      },
    );
    expect(left.map(([r]) => r)).toEqual(["Card(label)", "Card(noop)", "Card(readonly)"]);
  });

  speedIt(
    "checks a map naming thousands of views quickly",
    async () => {
      const files: Record<string, string> = {};
      const components: Record<string, object> = {};
      const lines = ["import SwiftUI"];
      for (let i = 0; i < 3000; i++) {
        lines.push(`struct V${i}: View { var body: some View { Text("a") } }`);
        components[`V${i}`] = { category: "other", parameters: [], at: `App/V.swift:${i + 2}` };
      }
      files["App/V.swift"] = lines.join("\n");
      const scan = await scanRepo(await tempDir(files));
      const tokens = await applyMap(scan, { version: 1, components });
      const sources = await readSources(tokens.scan);
      const started = performance.now();
      const reading = confirmComponents(tokens, sources);
      expect(performance.now() - started).toBeLessThan(2000);
      expect(reading.confirmed).toBe(3000);
    },
    60000,
  );
});

describe("designlane --from-agent with components", () => {
  it("counts the components it confirms with the tokens, and lists a parameter left out", async () => {
    const { run } = await import("../../src/cli/run.js");
    const root = await tempDir({
      ...SWIFT,
      "designlane/agent.json": JSON.stringify({
        version: 1,
        components: {
          PrimaryButton: {
            category: "button",
            parameters: ["title", "icon"],
            at: "App/PrimaryButton.swift:2",
          },
        },
      }),
    });
    const out: string[] = [];
    const error: string[] = [];
    const code = await run([root, "--from-agent", `${root}/designlane/agent.json`, "--no-write"], {
      out: (t) => out.push(t),
      error: (t) => error.push(t),
    });
    expect(code).toBe(0);
    expect(out[0]).toMatch(/^Confirmed 1 entry of /);
    expect(error.join("\n")).toContain("the component doesn't take that parameter, like PrimaryButton(icon)");
  });
});
