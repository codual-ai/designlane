import { describe, expect, it } from "vitest";
import { LayoutIssuesSchema, readApp } from "../../src/read/index.js";
import { kotlin, RN_MANIFEST, swift, tsx } from "../helpers/catalog.js";
import { appIn } from "../helpers/read-apps.js";

/** The layout issues of the view `name` in an app of `files`, with each span as the text it covers. */
async function issuesOf(files: Record<string, string>, name: string) {
  const app = await readApp(await appIn(files));
  const screen = app.screens().find((s) => s.name === name);
  if (!screen) throw new Error(`no view ${name}`);
  const d = app.layoutIssues(screen.id);
  expect(LayoutIssuesSchema.safeParse(d).success).toBe(true);
  const text = (file: string, start: number, end: number) => files[file]?.slice(start, end);
  return {
    app,
    screen,
    d,
    unreadable: d.unreadable && {
      reason: d.unreadable.reason,
      view: d.unreadable.view.split("#")[1],
      line: d.unreadable.span.line,
    },
    issues: d.issues.map((x) => [x.kind, x.detail ?? text(x.span.file, x.span.start, x.span.end)]),
  };
}

describe("layoutIssues: why a layout can't be read", () => {
  it("names where a bracket is left open", async () => {
    const { unreadable, app, screen } = await issuesOf(
      {
        "App/S.swift": swift(
          "struct S: View {",
          "  var body: some View {",
          '    VStack { Text("a"',
          "  }",
          "}",
        ),
      },
      "S",
    );
    expect(unreadable).toEqual({ reason: "unbalanced", view: "S", line: 4 });
    expect(app.layoutOf(screen.id)).toBeUndefined();
  });

  it("names an extension left open, and a composable's unclosed bracket", async () => {
    const open = await issuesOf(
      {
        "App/S.swift": swift(
          'struct S: View { var body: some View { Text("a") } }',
          "extension S {",
          '  var more: some View { Text("b") }',
        ),
      },
      "S",
    );
    expect(open.unreadable).toEqual({ reason: "open-extension", view: "S", line: 3 });
    const compose = await issuesOf(
      { "app/src/main/java/a/S.kt": kotlin("@Composable fun S() {", '  Column { Text("a" }', "}") },
      "S",
    );
    expect(compose.unreadable).toEqual({ reason: "unbalanced", view: "S", line: 3 });
  });

  it("names a React Native component TypeScript can't parse", async () => {
    const { unreadable } = await issuesOf(
      {
        ...RN_MANIFEST,
        "src/S.tsx": tsx("export function S() {", "  return <View><Text>a</View>;", "}"),
      },
      "S",
    );
    expect(unreadable?.reason).toBe("parse-error");
    expect(unreadable?.line).toBe(3);
  });

  it("names the limits a reading stopped at", async () => {
    const deep = `${"VStack { ".repeat(120)}Text("a")${" }".repeat(120)}`;
    // Two stacks nested past the limit: the first one is named.
    const tooDeep = await issuesOf(
      {
        "App/S.swift": swift(
          "struct S: View {",
          "  var body: some View {",
          "    VStack {",
          `      ${deep}`,
          `      ${deep}`,
          "    }",
          "  }",
          "}",
        ),
      },
      "S",
    );
    expect(tooDeep.unreadable).toMatchObject({ reason: "too-deep", line: 5 });
    const props = Array.from(
      { length: 12 },
      (_, i) => `  var p${i}: some View { VStack { p${i + 1}; p${i + 1}; p${i + 1} } }`,
    );
    const inlined = await issuesOf(
      {
        "App/S.swift": swift(
          "struct S: View {",
          "  var body: some View { p0 }",
          ...props,
          '  var p12: some View { Text("a") }',
          "}",
        ),
      },
      "S",
    );
    expect(inlined.unreadable?.reason).toBe("too-much-inlined");
  });

  it("names the placed view whose layout stops a screen's parts being found", async () => {
    const { unreadable, d } = await issuesOf(
      {
        "App/S.swift": swift("struct S: View { var body: some View { NavigationStack { Feed() } } }"),
        "App/Feed.swift": swift('struct Feed: View { var body: some View { VStack { Text("a" } } }'),
      },
      "S",
    );
    expect(unreadable).toEqual({ reason: "unbalanced", view: "Feed", line: 2 });
    expect(d.unreadable?.span.file).toBe("App/Feed.swift");
  });

  it("finds nothing wrong with a screen read whole and named", async () => {
    const { d } = await issuesOf(
      {
        "App/S.swift": swift('struct S: View { var body: some View { VStack { Text("a"); Text("b") } } }'),
      },
      "S",
    );
    expect(d).toEqual({ screen: "swiftui:App/S.swift#S", issues: [] });
  });
});

describe("layoutIssues: what may be wrong in a layout read whole", () => {
  it("issues an element no table names, and a part named by its kind alone", async () => {
    const { issues } = await issuesOf(
      {
        "App/S.swift": swift(
          'struct S: View { var body: some View { VStack { Text("a"); Meter(value: 1); HStack { Image("x") } } } }',
        ),
      },
      "S",
    );
    expect(issues).toEqual([
      ["unknown-element", "Meter"],
      ["unnamed-part", "Element"],
      ["unnamed-part", "Row"],
    ]);
  });

  it("issues a view placed by a name several views have, and a view placing itself", async () => {
    const { issues } = await issuesOf(
      {
        "app/src/main/java/a/A.kt": kotlin('@Composable fun Row2(x: Int) { Text("a") }'),
        "app/src/main/java/a/B.kt": kotlin('@Composable fun Row2(x: Int) { Text("b") }'),
        "app/src/main/java/a/S.kt": kotlin(
          "@Composable fun S(depth: Int) {",
          '  Column { Text("a"); Row2(1); if (depth > 0) S(depth - 1) }',
          "}",
        ),
      },
      "S",
    );
    expect(issues.map(([kind]) => kind)).toEqual(expect.arrayContaining(["ambiguous-view", "self-placed"]));
    expect(issues.find(([kind]) => kind === "ambiguous-view")).toEqual(["ambiguous-view", "Row2"]);
  });

  it("issues an `#if` read as written, and a screen with no parts", async () => {
    const { issues } = await issuesOf(
      {
        "App/S.swift": swift(
          "struct S: View {",
          "  var body: some View {",
          "    switch tab {",
          '    case .a: Text("a")',
          "    #if DEBUG",
          '    case .b: Text("b")',
          "    #endif",
          "    }",
          "  }",
          "}",
        ),
      },
      "S",
    );
    expect(issues.map(([kind]) => kind)).toEqual(["if-as-written"]);
    const empty = await issuesOf(
      {
        "App/Home.swift": swift(
          "@main struct HomeApp: App { var body: some Scene { WindowGroup { HomeScreen() } } }",
          "struct HomeScreen: View { var body: some View { List { ForEach(items) { Text($0.name) } } } }",
        ),
      },
      "HomeScreen",
    );
    expect(empty.screen.kind).toBe("screen");
    expect(empty.issues).toEqual([["no-parts", expect.stringContaining("struct HomeScreen")]]);
  });
});

describe("layoutIssues: notes as the code is written", () => {
  it("issues nothing a leaf holds, and a doubt read twice once", async () => {
    const { issues } = await issuesOf(
      {
        "App/S.swift": swift(
          "struct S: View {",
          '  var body: some View { VStack { Button(action: {}) { Meter(value: 2) }; row; row; Text("a") } }',
          "  var row: some View { Meter(value: 1) }",
          "}",
        ),
      },
      "S",
    );
    expect(issues.filter(([kind]) => kind === "unknown-element")).toEqual([["unknown-element", "Meter"]]);
  });

  it("issues an `#if` around a switch's first cases", async () => {
    const { issues } = await issuesOf(
      {
        "App/S.swift": swift(
          "struct S: View {",
          "  var body: some View {",
          "    switch tab {",
          "    #if DEBUG",
          '    case .a: Text("a")',
          "    #else",
          '    case .b: Text("b")',
          "    #endif",
          '    default: Text("c")',
          "    }",
          "  }",
          "}",
        ),
      },
      "S",
    );
    expect(issues.map(([kind]) => kind)).toEqual(["if-as-written"]);
  });

  it("issues what's in the views a screen's parts are found in", async () => {
    const { issues } = await issuesOf(
      {
        "App/S.swift": swift("struct S: View { var body: some View { NavigationStack { Feed() } } }"),
        "App/Feed.swift": swift(
          'struct Feed: View { var body: some View { VStack { Text("a"); Meter(value: 1) } } }',
        ),
      },
      "S",
    );
    expect(issues).toEqual([
      ["unknown-element", "Meter"],
      ["unnamed-part", "Element"],
    ]);
  });

  it("names the open bracket after a declaration the reader can't find", async () => {
    const compose = await issuesOf(
      {
        "app/src/main/java/a/S.kt": kotlin("@Composable fun S() {", '  Text("a")', "}"),
      },
      "S",
    );
    const broken = await compose.app.withChanges({
      "app/src/main/java/a/S.kt": kotlin("@Composable fun S() {", '  Text("a")'),
    });
    const d = broken.layoutIssues(compose.screen.id);
    expect(d.unreadable).toMatchObject({ reason: "unbalanced", span: { line: 2 } });
  });

  it("issues an import that names several views, and not a framework element renamed", async () => {
    const { issues } = await issuesOf(
      {
        ...RN_MANIFEST,
        "src/Child.ios.tsx": tsx("export function Child() { return <Text>ios</Text>; }"),
        "src/Child.android.tsx": tsx("export function Child() { return <Text>android</Text>; }"),
        "src/S.tsx": tsx(
          'import { Child } from "./Child";',
          'import { Text as Label } from "react-native";',
          "export function S() { return <View><Child /><Label>a</Label><Meter /></View>; }",
        ),
      },
      "S",
    );
    expect(issues.filter(([kind]) => kind !== "unnamed-part")).toEqual([
      ["ambiguous-view", "Child"],
      ["unknown-element", "Meter"],
    ]);
  });

  it("issues no parts only for a screen, not a component", async () => {
    const { d, screen } = await issuesOf(
      { "App/Row.swift": swift('struct Row: View { var body: some View { Text("a") } }') },
      "Row",
    );
    expect(screen.kind).toBe("component");
    expect(d.issues).toEqual([]);
  });
});

describe("layoutIssues and views", () => {
  const files = {
    "App/S.swift": swift('struct S: View { var body: some View { VStack { Text("a"); Meter(value: 1) } } }'),
  };

  it("gives the same issues each time, and each view's own", async () => {
    const app = await readApp(await appIn(files));
    const id = "swiftui:App/S.swift#S";
    expect(app.layoutIssues(id)).toEqual(app.layoutIssues(id));
    const view = await app.withChanges({
      "App/S.swift": swift('struct S: View { var body: some View { VStack { Text("a" } } }'),
    });
    expect(view.layoutIssues(id).unreadable?.reason).toBe("unbalanced");
    expect(app.layoutIssues(id).unreadable).toBeUndefined();
    await app.update(
      "App/S.swift",
      swift('struct S: View { var body: some View { VStack { Text("a"); Text("b") } } }'),
    );
    expect(app.layoutIssues(id)).toEqual({ screen: id, issues: [] });
  });

  it("gives screenParts a new empty answer each time", async () => {
    const app = await readApp(
      await appIn({ "App/A.swift": swift('struct A: View { var body: some View { Text("a") } }') }),
    );
    const first = app.screenParts("swiftui:App/A.swift#A");
    first?.push({ id: "x", view: "x", label: "x", span: { file: "x", line: 1, start: 0, end: 0 } });
    expect(app.screenParts("swiftui:App/A.swift#A")).toEqual([]);
  });
});

describe("layoutIssues: second review", () => {
  it("reads a React Native file with a great many parse errors without throwing", async () => {
    const app = await readApp(
      await appIn({
        ...RN_MANIFEST,
        "src/S.tsx": tsx("export function S() {", "=;\n".repeat(140_000), "  return <View />;", "}"),
      }),
    );
    const screen = app.screens().find((s) => s.name === "S");
    if (screen) {
      expect(() => app.layoutOf(screen.id)).not.toThrow();
      expect(app.layoutIssues(screen.id).unreadable?.reason).toBe("parse-error");
    }
  });

  it("keeps an ambiguous view's doubt its kind, and one view exported two ways unambiguous", async () => {
    const { issues } = await issuesOf(
      {
        ...RN_MANIFEST,
        "src/FlatList.ios.tsx": tsx("export function FlatList() { return <Text>ios</Text>; }"),
        "src/FlatList.android.tsx": tsx("export function FlatList() { return <Text>android</Text>; }"),
        "src/Card.tsx": tsx(
          "export function Card() { return <Text>card</Text>; }",
          "export { Card as Other };",
        ),
        "src/A.ts": 'export { Card as Item } from "./Card";',
        "src/B.ts": 'export { Other as Item } from "./Card";',
        "src/index.ts": 'export * from "./A";\nexport * from "./B";',
        "src/S.tsx": tsx(
          'import { FlatList } from "./FlatList";',
          'import { Item } from "./index";',
          "export function S() { return <View><FlatList numColumns={2} /><Item /></View>; }",
        ),
      },
      "S",
    );
    expect(issues.filter(([kind]) => kind === "ambiguous-view")).toEqual([["ambiguous-view", "FlatList"]]);
  });

  it("keeps issues in views followed before one that can't be read, and their self-placement", async () => {
    const stopped = await issuesOf(
      {
        "App/S.swift": swift("struct S: View { var body: some View { Feed() } }"),
        "App/Feed.swift": swift(
          "struct Feed: View {",
          "  var body: some View {",
          "    switch tab {",
          "    #if DEBUG",
          "    case .a: Broken()",
          "    #else",
          "    case .b: Broken()",
          "    #endif",
          "    }",
          "  }",
          "}",
        ),
        "App/Broken.swift": swift('struct Broken: View { var body: some View { VStack { Text("a" } } }'),
      },
      "S",
    );
    expect(stopped.unreadable).toMatchObject({ reason: "unbalanced", view: "Broken" });
    expect(stopped.issues.map(([kind]) => kind)).toEqual(["if-as-written"]);
    const recursive = await issuesOf(
      {
        "App/S.swift": swift("struct S: View { var body: some View { Feed() } }"),
        "App/Feed.swift": swift('struct Feed: View { var body: some View { VStack { Text("a"); Feed() } } }'),
      },
      "S",
    );
    expect(recursive.issues.map(([kind]) => kind)).toContain("self-placed");
  });

  it("issues no `#if` inside what a leaf holds", async () => {
    const { issues } = await issuesOf(
      {
        "App/S.swift": swift(
          "struct S: View {",
          "  var body: some View {",
          "    VStack {",
          '      Text("a")',
          "      Button(action: {}) {",
          "        switch x {",
          "        #if DEBUG",
          '        case .a: Text("a")',
          "        #else",
          '        case .b: Text("b")',
          "        #endif",
          "        }",
          "      }",
          "    }",
          "  }",
          "}",
        ),
      },
      "S",
    );
    expect(issues.map(([kind]) => kind)).not.toContain("if-as-written");
  });
});

describe("layoutIssues: third review", () => {
  it("keeps an issue of a view property placed outside a leaf as well as inside one", async () => {
    const { issues } = await issuesOf(
      {
        "App/S.swift": swift(
          "struct S: View {",
          "  var body: some View { VStack { Button(action: {}) { row }; row } }",
          '  var row: some View { Meter(value: 0.5) { Text("Meter") } }',
          "}",
        ),
      },
      "S",
    );
    expect(issues.filter(([kind]) => kind === "unknown-element")).toEqual([["unknown-element", "Meter"]]);
  });

  it("gives a view placing itself its issues once", async () => {
    const { d } = await issuesOf(
      {
        "App/S.swift": swift(
          "struct S: View {",
          "  let depth: Int",
          '  var body: some View { if depth > 0 { S(depth: depth - 1) } else { Meter(value: 0.5) { Text("Meter") } } }',
          "}",
        ),
      },
      "S",
    );
    const keys = d.issues.map((i) => `${i.kind} ${i.span.start} ${i.span.end}`);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
