import { describe, expect, it } from "vitest";
import { type LayoutNode, LayoutNodeSchema, readApp } from "../../src/read/index.js";
import { kotlin, RN_MANIFEST, swift, tsx } from "../helpers/catalog.js";
import { appIn } from "../helpers/read-apps.js";
import { speedIt } from "../helpers/speed.js";

/** The tree as lines of `id kind`, indented by depth, with a view-ref's view after an arrow. */
function outline(node: LayoutNode | undefined, depth = 0): string[] {
  if (!node) return [];
  const own = `${"  ".repeat(depth)}${node.id || "."} ${node.kind}${node.ref ? ` → ${node.ref.split("#")[1]}` : ""}`;
  return [own, ...node.children.flatMap((child) => outline(child, depth + 1))];
}

/** The layout of the view `name` in an app of `files`, checked against the schema. */
async function layout(files: Record<string, string>, name: string) {
  const app = await readApp(await appIn(files));
  const screen = app.screens().find((s) => s.name === name);
  if (!screen) throw new Error(`no view ${name}`);
  const tree = app.layoutOf(screen.id);
  if (tree) expect(LayoutNodeSchema.safeParse(tree).success).toBe(true);
  return { app, screen, tree, lines: outline(tree) };
}

describe("layoutOf: SwiftUI", () => {
  it("reads containers, elements, loops, branches, view properties and toolbars, placed views as refs", async () => {
    const { tree, lines, screen } = await layout(
      {
        "App/Plans.swift": swift(
          "struct PlansScreen: View {",
          "  @State private var on = false",
          "  var body: some View {",
          "    NavigationStack {",
          "      ScrollView {",
          "        VStack(spacing: 8) {",
          "          header",
          '          Image("hero").resizable()',
          "          ForEach(plans) { plan in PlanRow(plan: plan) }",
          '          if on { Text("On") } else if loading { ProgressView() } else { Text("Off"); Spacer() }',
          "          switch state {",
          '          case .empty: Text("None")',
          "          default: EmptyView()",
          "          }",
          '          Group { Toggle("Yearly", isOn: $on); TextField("Code", text: $code) }',
          '          Button("Buy") { Task { await buy() } }.padding()',
          "        }",
          "      }",
          '      .toolbar { ToolbarItem { Button("Close") {} } }',
          "      .searchable(text: $query)",
          "    }",
          "  }",
          '  private var header: some View { HStack { Text("Plans"); Spacer() } }',
          "}",
          "struct PlanRow: View { let plan: Plan; var body: some View { Text(plan.name) } }",
        ),
      },
      "PlansScreen",
    );
    expect(lines).toEqual([
      ". view-ref → PlansScreen",
      "  nav nav",
      "    nav/scroll scroll",
      "      nav/scroll/stack-v stack-v",
      "        nav/scroll/stack-v/stack-h stack-h",
      "          nav/scroll/stack-v/stack-h/text text",
      "          nav/scroll/stack-v/stack-h/spacer spacer",
      "        nav/scroll/stack-v/image image",
      "        nav/scroll/stack-v/repeat repeat",
      "          nav/scroll/stack-v/repeat/view-ref view-ref → PlanRow",
      "        nav/scroll/stack-v/conditional conditional",
      "          nav/scroll/stack-v/conditional/text text",
      "          nav/scroll/stack-v/conditional/other other",
      "          nav/scroll/stack-v/conditional/other.1 other",
      "            nav/scroll/stack-v/conditional/other.1/text text",
      "            nav/scroll/stack-v/conditional/other.1/spacer spacer",
      "        nav/scroll/stack-v/conditional.1 conditional",
      "          nav/scroll/stack-v/conditional.1/text text",
      "        nav/scroll/stack-v/input input",
      "        nav/scroll/stack-v/input.1 input",
      "        nav/scroll/stack-v/button button",
      "    nav/toolbar toolbar",
      "      nav/toolbar/button button",
      "    nav/input input",
    ]);
    expect(tree?.ref).toBe(screen.id);
  });

  it("gives each node the span of its code, and the screen its declaration's", async () => {
    const text = swift(
      "struct A: View {",
      '  var body: some View { VStack { Text("a").bold(); B() } }',
      "}",
      "struct B: View { var body: some View { Text(t) } }",
    );
    const { tree } = await layout({ "App/A.swift": text }, "A");
    const of = (node: LayoutNode | undefined) => node && text.slice(node.span.start, node.span.end);
    expect(of(tree)?.startsWith("struct A: View {")).toBe(true);
    expect(of(tree?.children[0])).toBe('VStack { Text("a").bold(); B() }');
    expect(of(tree?.children[0]?.children[0])).toBe('Text("a").bold()');
    expect(tree?.children[0]?.children[1]).toMatchObject({ kind: "view-ref", ref: "swiftui:App/A.swift#B" });
    expect(tree?.children[0]?.span.line).toBe(3);
  });

  it("reads view properties of the file's extensions, a list over data as a repeat, and labelled blocks", async () => {
    const { lines } = await layout(
      {
        "App/S.swift": swift(
          "struct S: View {",
          "  var body: some View { List(items) { item in Row(item: item) }; rows(for: items) }",
          "}",
          "extension S {",
          '  func rows(for items: [Item]) -> some View { Section { Text("a") } header: { Image("h") } }',
          "}",
          "struct Row: View { let item: Item; var body: some View { Text(item.name) } }",
        ),
      },
      "S",
    );
    expect(lines).toEqual([
      ". view-ref → S",
      "  list list",
      "    list/repeat repeat",
      "      list/repeat/view-ref view-ref → Row",
      "  section section",
      "    section/text text",
      "    section/image image",
    ]);
  });

  it("reads past declarations, attributes and code run, which show nothing", async () => {
    const { lines } = await layout(
      {
        "App/R.swift": swift(
          "struct R: View {",
          "  var body: some View {",
          "    let total = Price(amount: 3)",
          "    @Bindable var bound = model",
          "    VStack { Color.red; Rectangle().fill(Color.blue) }",
          "    PrimaryButton(title: t) { Task { await buy() }; Analytics.track(event) }",
          "  }",
          "}",
          "struct PrimaryButton: View { let title: String; let action: () -> Void; var body: some View { Text(title) } }",
        ),
      },
      "R",
    );
    expect(lines).toEqual([
      ". view-ref → R",
      "  stack-v stack-v",
      "    stack-v/other other",
      "    stack-v/other.1 other",
      "  view-ref view-ref → PrimaryButton",
    ]);
  });

  it("reads the struct's own body, not a nested view's, and places the first by id of views as near", async () => {
    const { lines } = await layout(
      {
        "App/S.swift": swift(
          "struct S: View {",
          "  struct Badge: View { var body: some View { Image(b) } }",
          "  var body: some View { HStack { Row() } }",
          "}",
        ),
        "App/B/Row.swift": swift("struct Row: View { var body: some View { Text(b) } }"),
        "App/A/Row.swift": swift("struct Row: View { var body: some View { Text(a) } }"),
      },
      "S",
    );
    expect(lines).toEqual([". view-ref → S", "  stack-h stack-h", "    stack-h/view-ref view-ref → Row"]);
    const { tree } = await layout(
      {
        "App/S.swift": swift("struct S: View { var body: some View { Row() } }"),
        "App/B/Row.swift": swift("struct Row: View { var body: some View { Text(b) } }"),
        "App/A/Row.swift": swift("struct Row: View { var body: some View { Text(a) } }"),
      },
      "S",
    );
    expect(tree?.children[0]?.ref).toBe("swiftui:App/A/Row.swift#Row");
  });

  it("keeps the elements a custom container holds in this file, and stops at a view placing itself", async () => {
    const { lines } = await layout(
      {
        "App/C.swift": swift(
          "struct Card<Content: View>: View { let content: Content; var body: some View { VStack { content } } }",
          'struct Home: View { var body: some View { Card { Text("In"); Image("i") }; more } ',
          "  var more: some View { HStack { more; Text(t) } } }",
        ),
      },
      "Home",
    );
    expect(lines).toEqual([
      ". view-ref → Home",
      "  view-ref view-ref → Card",
      "    view-ref/text text",
      "    view-ref/image image",
      "  stack-h stack-h",
      "    stack-h/text text",
    ]);
  });
});

describe("layoutOf: Compose", () => {
  it("reads slots, lazy lists' items, when and if branches, loops, and wrappers that only style", async () => {
    const { lines } = await layout(
      {
        "app/src/main/java/a/Plans.kt": kotlin(
          "@Composable fun PlansScreen(vm: Vm) {",
          "  val state by vm.state.collectAsState()",
          "  LaunchedEffect(Unit) { vm.load() }",
          '  Scaffold(topBar = { TopAppBar(title = { Text("Plans") }) }, floatingActionButton = { FloatingActionButton(onClick = {}) { Icon(Icons.Add, null) } }) { padding ->',
          "    LazyColumn(modifier = Modifier.padding(padding)) {",
          "      item { Header() }",
          "      stickyHeader { Text(t) }",
          "      items(state.plans) { plan -> PlanRow(plan) }",
          "    }",
          '    when (state) { is Loading -> CircularProgressIndicator(); else -> { Text("x"); Button(onClick = {}) { Text("Buy") } } }',
          '    if (state.error) Text("Error") else Box(Modifier.fillMaxSize()) { Icon(Icons.Default.Add, null) }',
          "    Box { Text(a); Text(b) }",
          "    Column(Modifier.verticalScroll(rememberScrollState())) { for (tag in tags) { Text(tag) } }",
          "    Surface { Row { tags.forEach { Spacer(Modifier.width(4.dp)) } } }",
          "  }",
          "}",
          "@Composable fun PlanRow(plan: Plan) { Text(plan.name) }",
          '@Composable fun Header() = Column { Text("Choose") }',
        ),
      },
      "PlansScreen",
    );
    expect(lines).toEqual([
      ". view-ref → PlansScreen",
      "  nav nav",
      "    nav/toolbar toolbar",
      "      nav/toolbar/text text",
      "    nav/button button",
      "    nav/lazy-list lazy-list",
      "      nav/lazy-list/view-ref view-ref → Header",
      "      nav/lazy-list/section section",
      "        nav/lazy-list/section/text text",
      "      nav/lazy-list/repeat repeat",
      "        nav/lazy-list/repeat/view-ref view-ref → PlanRow",
      "    nav/conditional conditional",
      "      nav/conditional/other other",
      "      nav/conditional/other.1 other",
      "        nav/conditional/other.1/text text",
      "        nav/conditional/other.1/button button",
      "    nav/conditional.1 conditional",
      "      nav/conditional.1/text text",
      "      nav/conditional.1/image image",
      "    nav/stack-z stack-z",
      "      nav/stack-z/text text",
      "      nav/stack-z/text.1 text",
      "    nav/scroll scroll",
      "      nav/scroll/repeat repeat",
      "        nav/scroll/repeat/text text",
      "    nav/stack-h stack-h",
      "      nav/stack-h/repeat repeat",
      "        nav/stack-h/repeat/spacer spacer",
    ]);
  });

  it("reads a lambda passed by any name but an action's, past annotations and typed lambda parameters", async () => {
    const { lines } = await layout(
      {
        "app/src/main/java/a/L.kt": kotlin(
          "@Composable fun Plans(plans: List<Plan>) {",
          "  @OptIn(ExperimentalFoundationApi::class) val pager = rememberPagerState()",
          "  LazyColumn { items(plans) { plan: Plan -> PlanCard(plan, onSelect = { Analytics.track(plan); ConfirmDialog() }, badge = { Badge() }) } }",
          "}",
          "@Composable fun PlanCard(plan: Plan, onSelect: () -> Unit, badge: @Composable () -> Unit) { Text(plan.name) }",
        ),
      },
      "Plans",
    );
    expect(lines).toEqual([
      ". view-ref → Plans",
      "  lazy-list lazy-list",
      "    lazy-list/repeat repeat",
      "      lazy-list/repeat/view-ref view-ref → PlanCard",
      "        lazy-list/repeat/view-ref/other other",
    ]);
  });

  it("reads a function written as an expression", async () => {
    const { lines } = await layout(
      { "app/src/main/java/a/H.kt": kotlin('@Composable fun Header() = Row { Text("a"); Image(p, null) }') },
      "Header",
    );
    expect(lines).toEqual([
      ". view-ref → Header",
      "  stack-h stack-h",
      "    stack-h/text text",
      "    stack-h/image image",
    ]);
  });
});

describe("layoutOf: React Native", () => {
  it("reads JSX, its conditionals and loops, a view's direction from its style, and the app's own components", async () => {
    const { lines } = await layout(
      {
        ...RN_MANIFEST,
        "src/Plans.tsx": tsx(
          'import { Button } from "./Button";',
          "export function PlansScreen({ plans, loading }) {",
          "  const renderRow = (plan) => { return <PlanRow plan={plan} />; };",
          "  if (loading) return <ActivityIndicator />;",
          "  return (",
          "    <SafeAreaView style={styles.root}>",
          "      <Stack.Screen options={{ title: 'Plans' }} />",
          "      <View style={[styles.root, styles.row]}><Text>Plans</Text><Image source={hero} /></View>",
          '      <View className="flex-row gap-2"><Text>a</Text><Text>b</Text></View>',
          "      <View style={{ padding: 8 }}><Text>Wrapped</Text></View>",
          "      <View style={styles.divider} />",
          "      <FlatList data={plans} numColumns={2} keyExtractor={(p) => p.id} renderItem={({ item }) => <PlanRow plan={item} />} />",
          "      <PlanGrid numColumns={3} />",
          "      {debug && renderDebug()}",
          "      <>{plans.map((p) => <PlanRow key={p.id} plan={p} />)}</>",
          "      {loading ? <Text>a</Text> : null}",
          "      {error && <Text>{error}</Text>}",
          "      <Pressable onPress={buy}><Text>Buy</Text></Pressable>",
          "      <TextInput value={code} />",
          '      <Button title="Restore" />',
          "      <Modal visible={open}><Text>Hidden</Text></Modal>",
          "    </SafeAreaView>",
          "  );",
          "}",
          "export const PlanRow = ({ plan }) => <Text>{plan.name}</Text>;",
          "export const PlanGrid = ({ numColumns }) => <View />;",
          "const styles = StyleSheet.create({ root: { flex: 1, flexDirection: 'column' }, row: { flexDirection: 'row' }, divider: { height: 1 } });",
        ),
        "src/Button.tsx": tsx(
          "export function Button({ title }) { return <Pressable><Text>{title}</Text></Pressable>; }",
        ),
      },
      "PlansScreen",
    );
    expect(lines).toEqual([
      ". view-ref → PlansScreen",
      "  conditional conditional",
      "    conditional/other other",
      "    conditional/stack-v stack-v",
      "      conditional/stack-v/stack-h stack-h",
      "        conditional/stack-v/stack-h/text text",
      "        conditional/stack-v/stack-h/image image",
      "      conditional/stack-v/stack-h.1 stack-h",
      "        conditional/stack-v/stack-h.1/text text",
      "        conditional/stack-v/stack-h.1/text.1 text",
      "      conditional/stack-v/text text",
      "      conditional/stack-v/other other",
      "      conditional/stack-v/lazy-grid lazy-grid",
      "        conditional/stack-v/lazy-grid/repeat repeat",
      "          conditional/stack-v/lazy-grid/repeat/view-ref view-ref → PlanRow",
      "      conditional/stack-v/view-ref view-ref → PlanGrid",
      "      conditional/stack-v/repeat repeat",
      "        conditional/stack-v/repeat/view-ref view-ref → PlanRow",
      "      conditional/stack-v/conditional conditional",
      "        conditional/stack-v/conditional/text text",
      "      conditional/stack-v/conditional.1 conditional",
      "        conditional/stack-v/conditional.1/text text",
      "      conditional/stack-v/button button",
      "      conditional/stack-v/input input",
      "      conditional/stack-v/view-ref.1 view-ref → Button",
    ]);
  });

  it("reads a navigator's tabs, a class's render, and a component written as an arrow", async () => {
    const { lines } = await layout(
      {
        ...RN_MANIFEST,
        "src/Tabs.tsx": tsx(
          "export class Home extends React.Component { render() { return <ScrollView><Text>Hi</Text></ScrollView>; } }",
          "export const Root = () => (<Tab.Navigator><Tab.Screen name='home' component={Home} /></Tab.Navigator>);",
        ),
      },
      "Root",
    );
    expect(lines).toEqual([". view-ref → Root", "  tabs tabs"]);
    const home = await layout(
      {
        ...RN_MANIFEST,
        "src/H.tsx": tsx(
          "export class Home extends React.Component { render() { return <ScrollView><Text>Hi</Text></ScrollView>; } }",
        ),
      },
      "Home",
    );
    expect(home.lines).toEqual([". view-ref → Home", "  scroll scroll", "    scroll/text text"]);
  });
});

describe("layoutOf: ids", () => {
  const screen = (...lines: string[]) => ({
    "App/S.swift": swift(
      "struct S: View {",
      "  var body: some View {",
      "    VStack {",
      ...lines,
      "    }",
      "  }",
      "}",
    ),
  });

  it("keeps a node's id when nodes of other kinds are added before it, and numbers those of its kind", async () => {
    const ids = async (files: Record<string, string>) => {
      const { tree } = await layout(files, "S");
      return tree?.children[0]?.children.map((n) => n.id);
    };
    expect(await ids(screen("List { Text(a) }", "Text(b)"))).toEqual(["stack-v/list", "stack-v/text"]);
    expect(await ids(screen('Image("hero")', 'Button("x") {}', "List { Text(a) }", "Text(b)"))).toEqual([
      "stack-v/image",
      "stack-v/button",
      "stack-v/list",
      "stack-v/text",
    ]);
    expect(await ids(screen("List { Text(a) }", "List { Text(c) }", "Text(b)"))).toEqual([
      "stack-v/list",
      "stack-v/list.1",
      "stack-v/text",
    ]);
  });

  it("gives every node of a tree its own id", async () => {
    const { tree } = await layout(
      screen("HStack { Text(a); Text(b) }", "HStack { Text(a); Text(b) }", "ForEach(x) { y in Text(y) }"),
      "S",
    );
    const all = (n: LayoutNode): string[] => [n.id, ...n.children.flatMap(all)];
    const ids = tree ? all(tree) : [];
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("layoutOf and views", () => {
  const files = {
    "App/A.swift": swift('struct A: View { var body: some View { VStack { Text("a") } } }'),
  };

  it("reads a screen as a view changes it, leaving the app as it was", async () => {
    const app = await readApp(await appIn(files));
    const view = await app.withChanges({
      "App/A.swift": swift('struct A: View { var body: some View { VStack { Image("a"); Text("a") } } }'),
    });
    const kinds = (tree: LayoutNode | undefined) => tree?.children[0]?.children.map((n) => n.kind);
    expect(kinds(view.layoutOf("swiftui:App/A.swift#A"))).toEqual(["image", "text"]);
    expect(kinds(app.layoutOf("swiftui:App/A.swift#A"))).toEqual(["text"]);
  });

  it("follows a ref to a view declared in a file the view adds", async () => {
    const app = await readApp(await appIn(files));
    const view = await app.withChanges({
      "App/A.swift": swift("struct A: View { var body: some View { VStack { Badge() } } }"),
      "App/Badge.swift": swift('struct Badge: View { var body: some View { HStack { Image("b") } } }'),
    });
    const ref = view.layoutOf("swiftui:App/A.swift#A")?.children[0]?.children[0];
    expect(ref).toMatchObject({ kind: "view-ref", ref: "swiftui:App/Badge.swift#Badge" });
    expect(view.layoutOf(ref?.ref ?? "")?.children.map((n) => n.kind)).toEqual(["stack-h"]);
    expect(() => app.layoutOf(ref?.ref ?? "")).toThrow(/No screen/);
  });

  it("throws for a screen the view doesn't have or whose file it deletes, and is undefined for code with no layout", async () => {
    const app = await readApp(
      await appIn({ ...files, "App/M.swift": swift("struct M: View {", "  let title: String", "}") }),
    );
    expect(() => app.layoutOf("swiftui:App/Nope.swift#Nope")).toThrow(/No screen/);
    const gone = await app.withChanges({ "App/A.swift": null });
    expect(() => gone.layoutOf("swiftui:App/A.swift#A")).toThrow(/No screen/);
    expect(app.layoutOf("swiftui:App/M.swift#M")).toBeUndefined();
  });
});

describe("layoutOf on code it can't read whole", () => {
  it("reads a hundred levels of nesting, and is undefined past them, rather than part of the screen", async () => {
    const depthOf = (tree: LayoutNode | undefined) => {
      let depth = 0;
      for (let n = tree; n?.children.at(-1); n = n.children.at(-1)) depth++;
      return depth;
    };
    const stacks = (n: number) => ({
      "App/D.swift": swift(
        `struct D: View { var body: some View { ${"VStack { ".repeat(n)}Text(a)${" }".repeat(n)} } }`,
      ),
    });
    expect(depthOf((await layout(stacks(90), "D")).tree)).toBe(91);
    expect((await layout(stacks(5000), "D")).tree).toBeUndefined();
    // As deep as TypeScript's parser reads.
    const views = (n: number) => ({
      ...RN_MANIFEST,
      "src/D.tsx": tsx(`export const D = () => (${"<View><Text>a</Text>".repeat(n)}${"</View>".repeat(n)});`),
    });
    expect(depthOf((await layout(views(90), "D")).tree)).toBe(90);
    expect((await layout(views(500), "D")).tree).toBeUndefined();
    const shown = `${"<View><Text>a</Text>{on && ".repeat(400)}<Text>b</Text>${"}</View>".repeat(400)}`;
    expect(
      (await layout({ ...RN_MANIFEST, "src/C.tsx": tsx(`export const C = () => (${shown});`) }, "C")).tree,
    ).toBeUndefined();
  });

  it("reads a Flow file, whose types TypeScript can't parse, and helpers placing helpers many times", async () => {
    const flow = await layout(
      {
        ...RN_MANIFEST,
        "src/FlowScreen.js": [
          "/* @flow strict-local */",
          "import React from 'react';",
          "import { View, Text } from 'react-native';",
          "type Props = {| +title: string |};",
          "export default function FlowScreen(props: Props): Node {",
          "  const title = (props.title: string);",
          "  return <View><Text>{title}</Text><Text>b</Text></View>;",
          "}",
        ].join("\n"),
        // A Flow type TypeScript can't read past, in the parameters: the body is lost, so the layout is undefined.
        "src/LostScreen.js": [
          "/* @flow */",
          "import { View, Text } from 'react-native';",
          "export default function LostScreen(props: {| +title: string |}): Node {",
          "  return <View><Text>{props.title}</Text></View>;",
          "}",
        ].join("\n"),
        "src/Root.tsx": tsx(
          'import FlowScreen from "./FlowScreen";',
          'import LostScreen from "./LostScreen";',
          "export const Root = () => <View><FlowScreen /><LostScreen /></View>;",
        ),
      },
      "FlowScreen",
    );
    const lost = flow.app.screens().find((v) => v.name === "LostScreen");
    expect(lost).toBeDefined();
    expect(flow.app.layoutOf(lost?.id ?? "")).toBeUndefined();
    expect(flow.lines).toEqual([
      ". view-ref → FlowScreen",
      "  stack-v stack-v",
      "    stack-v/text text",
      "    stack-v/text.1 text",
    ]);
    const label =
      "  func label(_ t: String) -> some View { HStack { Image(i); Text(t); Spacer(); Text(t); Image(j) } }";
    const button = `  func button(_ a: Int) -> some View { VStack { ${Array.from({ length: 8 }, () => "label(x)").join("; ")} } }`;
    const { tree } = await layout(
      swiftBody(Array.from({ length: 6 }, () => "button(1)").join("; "), button, label),
      "S",
    );
    expect(tree?.children).toHaveLength(6);
  });

  it("is undefined for a screen whose code is left unfinished, not for one beside it", async () => {
    const swiftApp = await readApp(
      await appIn({
        "App/U.swift": swift(
          "struct U: View { var body: some View { VStack { Text(a); HStack( } } }",
          "struct Fine: View { var body: some View { Text(b) } }",
          "struct Extra: View { var body: some View { VStack { Text(a)) } } }",
        ),
      }),
    );
    expect(swiftApp.layoutOf("swiftui:App/U.swift#U")).toBeUndefined();
    expect(swiftApp.layoutOf("swiftui:App/U.swift#Extra")).toBeUndefined();
    expect(swiftApp.layoutOf("swiftui:App/U.swift#Fine")?.children.map((n) => n.kind)).toEqual(["text"]);
    const compose = await readApp(
      await appIn({
        "app/src/main/java/a/U.kt": kotlin(
          "@Composable fun Fine() { Text(b) }",
          "@Composable fun U() { Column { Text(a); Row( } }",
        ),
      }),
    );
    expect(compose.layoutOf("compose:app/src/main/java/a/U.kt#U")).toBeUndefined();
    expect(compose.layoutOf("compose:app/src/main/java/a/U.kt#Fine")?.children.map((n) => n.kind)).toEqual([
      "text",
    ]);
    const rn = await readApp(
      await appIn({
        ...RN_MANIFEST,
        "src/U.tsx": tsx(
          "export const Fine = () => <Text>b</Text>;",
          "export const U = () => <View><Text>a</Text><Image></View>;",
        ),
      }),
    );
    const id = (name: string) => rn.screens().find((s) => s.name === name)?.id ?? "";
    expect(rn.layoutOf(id("U"))).toBeUndefined();
    expect(rn.layoutOf(id("Fine"))?.children.map((n) => n.kind)).toEqual(["text"]);
  });
});

/** The tree under the screen, as `layout`'s lines without the screen's own. */
async function under(files: Record<string, string>, name: string) {
  return (await layout(files, name)).lines.slice(1).map((l) => l.slice(2));
}

const swiftBody = (body: string, ...more: string[]) => ({
  "App/S.swift": swift(`struct S: View { var body: some View { ${body} }`, ...more, "}"),
});
const composeBody = (body: string, ...more: string[]) => ({
  "app/src/main/java/a/S.kt": kotlin(`@Composable fun S() { ${body} }`, ...more),
});

describe("layoutOf: SwiftUI as it's written", () => {
  it("reads a property with modifiers, a view given to AnyView, a block on the next line, and a type named through another", async () => {
    expect(
      await under(
        swiftBody(
          "header.padding().background(.red); AnyView(Text(t)); VStack\n{ Image(i) }; Theme.Card { Spacer() }; row(1).searchable(text: $q)",
          "  var header: some View { Text(h) }",
          "  func row(_ n: Int) -> some View { Text(r) }",
          "  struct Card: View { var body: some View { Text(c) } }",
        ),
        "S",
      ),
    ).toEqual([
      "text text",
      "text.1 text",
      "stack-v stack-v",
      "  stack-v/image image",
      "view-ref view-ref → Card",
      "  view-ref/spacer spacer",
      "text.2 text",
      "input input",
    ]);
  });

  it("reads a list given no data once, and a switch's case holding an `if case`", async () => {
    expect(await under(swiftBody("List(selection: $picked) { Text(a) }"), "S")).toEqual([
      "list list",
      "  list/text text",
    ]);
    expect(
      await under(
        swiftBody("switch state {\ncase .a:\n  if case .x = foo { Text(a) }\ndefault: Text(b)\n}"),
        "S",
      ),
    ).toEqual([
      "conditional conditional",
      "  conditional/conditional conditional",
      "    conditional/conditional/text text",
      "  conditional/text text",
    ]);
  });
});

describe("layoutOf: Compose as it's written", () => {
  it("reads blocks shown with a value, `key` and `with`, and a block on the next line", async () => {
    expect(
      await under(
        composeBody(
          "Column { user?.let { Text(it.name) }; with(user) { Icon(x, null) }; list.forEach { key(it.id) { Spacer() } }; remember(ctx) { Intent(ctx, A::class.java) } }; Row\n{ Text(b) }",
        ),
        "S",
      ),
    ).toEqual([
      "stack-v stack-v",
      "  stack-v/conditional conditional",
      "    stack-v/conditional/text text",
      "  stack-v/image image",
      "  stack-v/repeat repeat",
      "    stack-v/repeat/spacer spacer",
      "stack-h stack-h",
      "  stack-h/text text",
    ]);
  });

  it("covers a function written as an expression whole with the screen's span", async () => {
    const text = kotlin("@Composable fun S() = Column { Text(a) }");
    const { tree } = await layout({ "app/src/main/java/a/S.kt": text }, "S");
    expect(tree?.span.end).toBeGreaterThanOrEqual(tree?.children[0]?.span.end ?? Number.POSITIVE_INFINITY);
  });
});

describe("layoutOf: React Native as it's written", () => {
  it("reads both sides of a fallback, and an item's several returns as a conditional", async () => {
    expect(
      await under(
        {
          ...RN_MANIFEST,
          "src/S.tsx": tsx(
            "export const S = () => (<View><Image />{(on && <Text>On</Text>) || <Image />}",
            "{items.map((i) => { if (i.ok) return <Text>a</Text>; return <Image />; })}</View>);",
          ),
        },
        "S",
      ),
    ).toEqual([
      "stack-v stack-v",
      "  stack-v/image image",
      "  stack-v/conditional conditional",
      "    stack-v/conditional/conditional conditional",
      "      stack-v/conditional/conditional/text text",
      "    stack-v/conditional/image image",
      "  stack-v/repeat repeat",
      "    stack-v/repeat/conditional conditional",
      "      stack-v/repeat/conditional/text text",
      "      stack-v/repeat/conditional/image image",
    ]);
  });

  it("places the view an import names, by any alias, and none of a package's", async () => {
    const { tree } = await layout(
      {
        ...RN_MANIFEST,
        "src/S.tsx": tsx(
          'import { Row as Item } from "./other/Row";',
          'import Thing from "./Card";',
          'import { Row } from "./other/Row";',
          'import { Badge } from "some-ui-kit";',
          "export const S = () => <View><Item /><Row /><Thing /><Badge /></View>;",
        ),
        "src/Row.tsx": tsx("export const Row = () => <Text>near</Text>;"),
        "src/other/Row.tsx": tsx("export const Row = () => <Text>imported</Text>;"),
        "src/Card.tsx": tsx("export default function Card() { return <View />; }"),
        "src/Badge.tsx": tsx("export const Badge = () => <Text>own</Text>;"),
        "package.json": '{ "dependencies": { "react-native": "0.76.0", "some-ui-kit": "1.0.0" } }',
      },
      "S",
    );
    expect(tree?.children[0]?.children.map((n) => n.ref ?? n.kind)).toEqual([
      "react-native:src/other/Row.tsx#Row",
      "react-native:src/other/Row.tsx#Row",
      "react-native:src/Card.tsx#Card",
      "other",
    ]);
  });

  it("follows an import through files that re-export the view", async () => {
    const { tree } = await layout(
      {
        ...RN_MANIFEST,
        "src/S.tsx": tsx(
          'import { Card, Badge } from "./components";',
          "export const S = () => <View><Card /><Badge /></View>;",
        ),
        "src/components/Card.tsx": tsx("export function Card() { return <View />; }"),
        "src/components/Badge.tsx": tsx("export function Badge() { return <View />; }"),
        "src/components/index.ts": 'export { Card } from "./Card";\nexport * from "./Badge";',
        // As near by path, and first by id, but not what the import names.
        "src/Card.tsx": tsx("export function Card() { return <Text>a</Text>; }"),
        "src/Badge.tsx": tsx("export function Badge() { return <Text>a</Text>; }"),
      },
      "S",
    );
    expect(tree?.children[0]?.children.map((n) => n.ref)).toEqual([
      "react-native:src/components/Card.tsx#Card",
      "react-native:src/components/Badge.tsx#Badge",
    ]);
  });

  it("finds a class, an arrow taking props and an unnamed default export in a file a view changes", async () => {
    const files = {
      ...RN_MANIFEST,
      "src/Home.tsx": tsx(
        "export class Home extends React.Component { render() { return <Text>a</Text>; } }",
      ),
      "src/Plain.tsx": tsx("export const Plain = props => <Text>{props.t}</Text>;"),
      "src/profile.tsx": tsx("export default () => <Text>p</Text>;"),
    };
    const app = await readApp(await appIn(files));
    const view = await app.withChanges(files);
    for (const id of ["react-native:src/Home.tsx#Home", "react-native:src/Plain.tsx#Plain"])
      expect(view.layoutOf(id)?.children.map((n) => n.kind)).toEqual(["text"]);
    const profile = app.screens().find((s) => s.file === "src/profile.tsx");
    expect(profile && view.layoutOf(profile.id)?.children.map((n) => n.kind)).toEqual(["text"]);
    // A class that isn't a component, and a function that returns no JSX, aren't views.
    const other = await app.withChanges({
      "src/Home.tsx": tsx("export class Store extends Emitter {}", "export const Double = x => x * 2;"),
    });
    for (const id of ["react-native:src/Home.tsx#Store", "react-native:src/Home.tsx#Double"])
      expect(() => other.layoutOf(id)).toThrow(/No screen/);
  });
});

describe("layoutOf on hostile code", () => {
  it("stays bounded on unbraced branches and loops nested deep, and is undefined for them", async () => {
    for (const body of [
      `${"if (a) ".repeat(20000)}Text(x)`,
      `${"when { a -> ".repeat(5000)}Text(x)${" }".repeat(5000)}`,
      `${"for (x in y) ".repeat(20000)}Text(x)`,
    ])
      expect((await layout(composeBody(body), "S")).tree).toBeUndefined();
  });

  speedIt(
    "reads view properties placing each other twice in linear time, undefined past its budget",
    async () => {
      const levels = 24;
      const props = Array.from(
        { length: levels },
        (_, i) => `  var p${i}: some View { VStack { p${i + 1}; p${i + 1} } }`,
      );
      const started = performance.now();
      const { tree } = await layout(
        swiftBody("p0", ...props, `  var p${levels}: some View { Text(x) }`),
        "S",
      );
      expect(performance.now() - started).toBeLessThan(2000);
      // Read whole, it would hold some thirty million nodes: past the budget, it's undefined.
      expect(tree).toBeUndefined();
    },
  );

  speedIt("reads long names, generics and cases in linear time", async () => {
    /** How long reading the layout of `S` takes, once the app is read. */
    const time = async (files: Record<string, string>) => {
      const app = await readApp(await appIn(files));
      const id = app.screens().find((v) => v.name === "S")?.id ?? "";
      const started = performance.now();
      app.layoutOf(id);
      return performance.now() - started;
    };
    // Four times the input takes about four times as long, not sixteen.
    const grows = async (input: (n: number) => Record<string, string>) => {
      const n = 40000;
      const small = await time(input(n));
      const large = await time(input(n * 4));
      expect(large).toBeLessThan(small * 10 + 20);
    };
    await grows((n) => composeBody(`Column(${"a".repeat(n)}) { Text(x) }`));
    await grows((n) => swiftBody(`VStack { ${"A<".repeat(n)} }`));
    await grows((n) => swiftBody(`switch a { ${"c".repeat(n)}: Text(x) }`));
  });
});

describe("layoutOf: names as the code gives them", () => {
  it("reads a package's view by the name it's imported as, an image holding content, and the app's own FlatList", async () => {
    expect(
      await under(
        {
          ...RN_MANIFEST,
          "src/S.tsx": [
            'import { Text as Label, ImageBackground, View } from "react-native";',
            'import { FlatList } from "./FlatList";',
            "export const S = () => <View><Label>Hi</Label><ImageBackground source={bg}><Label>On</Label></ImageBackground><ImageBackground source={bg} /><FlatList numColumns={2} /></View>;",
          ].join("\n"),
          "src/FlatList.tsx": tsx("export const FlatList = () => <View />;"),
        },
        "S",
      ),
    ).toEqual([
      "stack-v stack-v",
      "  stack-v/text text",
      "  stack-v/stack-z stack-z",
      "    stack-v/stack-z/image image",
      "    stack-v/stack-z/text text",
      "  stack-v/image image",
      "  stack-v/view-ref view-ref → FlatList",
    ]);
  });

  it("places a file's default export, not another view declared beside it, and follows an export renamed", async () => {
    const { tree } = await layout(
      {
        ...RN_MANIFEST,
        "src/S.tsx": tsx(
          'import Thing from "./Card";',
          'import { Card } from "./C";',
          "export const S = () => <View><Thing /><Card /></View>;",
        ),
        "src/Card.tsx": tsx(
          "export const Card = () => <Text>a</Text>;",
          "export default function Main() { return <Image />; }",
        ),
        "src/C.tsx": tsx("const Inner = () => <Text>i</Text>;", "export { Inner as Card };"),
      },
      "S",
    );
    expect(tree?.children[0]?.children.map((n) => n.ref)).toEqual([
      "react-native:src/Card.tsx#Main",
      "react-native:src/C.tsx#Inner",
    ]);
  });

  it("finds a component wrapped in a call, and an unnamed arrow exported, in a file a view changes", async () => {
    const files = {
      ...RN_MANIFEST,
      "src/S.tsx": tsx("export const S = observer(() => <Text>s</Text>);"),
      "src/title.tsx": tsx("export default props => <Text>{props.title}</Text>;"),
    };
    const app = await readApp(await appIn(files));
    const view = await app.withChanges(files);
    for (const screen of app.screens())
      expect(view.layoutOf(screen.id)?.children.map((n) => n.kind)).toEqual(["text"]);
    expect(app.screens().length).toBeGreaterThanOrEqual(2);
  });

  it("covers a branch's elements with its span when a view property it places is declared before it", async () => {
    const { tree } = await layout(
      swiftBody(
        "if on { bottom; top }",
        "  var top: some View { Text(t) }",
        "  var bottom: some View { Image(b) }",
      ),
      "S",
    );
    const branch = tree?.children[0]?.children[0];
    expect(branch?.kind).toBe("other");
    for (const child of branch?.children ?? []) {
      expect(branch?.span.start).toBeLessThanOrEqual(child.span.start);
      expect(branch?.span.end).toBeGreaterThanOrEqual(child.span.end);
    }
  });

  it("reads a modifier's block on the next line, Kotlin type arguments, and a list given literal data", async () => {
    expect(
      await under(
        swiftBody(
          'Text(x).toolbar\n{ ToolbarItem { Button("Done") {} } }; List([1, 2], id: \\.self) { item in Text(i) }',
        ),
        "S",
      ),
    ).toEqual([
      "text text",
      "toolbar toolbar",
      "  toolbar/button button",
      "list list",
      "  list/repeat repeat",
      "    list/repeat/text text",
    ]);
    expect(
      await under(composeBody("AnimatedContent<State>(targetState = state) { Text(it.title) }"), "S"),
    ).toEqual(["text text"]);
  });
});

describe("layoutOf: elements real apps write", () => {
  it("reads SwiftUI's labelled rows and tabs, and Compose's list items, pagers and dialogs", async () => {
    expect(
      await under(
        swiftBody(
          'Form { LabeledContent("Sign out") { Button("Out") {} } }; TabView { Tab("Home") { Text(h) } }',
        ),
        "S",
      ),
    ).toEqual([
      "form form",
      "  form/stack-h stack-h",
      "    form/stack-h/button button",
      "tabs tabs",
      "  tabs/text text",
    ]);
    expect(
      await under(
        composeBody(
          [
            "if (bad) throw IllegalStateException(m)",
            "  ListItem(headlineContent = { Text(t) }, trailingContent = { Switch(on, null) })",
            "  HorizontalPager(state) { page -> Text(p) }",
            "  ProvideTextStyle(style) { Text(a) }",
            "  if (open) AlertDialog(onDismissRequest = {}, title = { Text(t) })",
            "  DropdownMenu(expanded) { DropdownMenuItem(text = { Text(x) }, onClick = {}) }",
          ].join("\n"),
        ),
        "S",
      ),
    ).toEqual([
      "conditional conditional",
      "stack-h stack-h",
      "  stack-h/text text",
      "  stack-h/input input",
      "lazy-list lazy-list",
      "  lazy-list/text text",
      "text text",
      "conditional.1 conditional",
    ]);
  });

  it("reads a web build's elements, gradients, and a component of a module imported whole", async () => {
    expect(
      await under(
        {
          ...RN_MANIFEST,
          "src/S.tsx": tsx(
            'import * as List from "./List";',
            "export const S = () => (<div><span>a</span><img src={x} /><LinearGradient colors={c}><Text>g</Text></LinearGradient><List.Item /></div>);",
          ),
          "src/List.tsx": tsx("export const Item = () => <Text>i</Text>;"),
        },
        "S",
      ),
    ).toEqual([
      "stack-v stack-v",
      "  stack-v/text text",
      "  stack-v/image image",
      "  stack-v/text.1 text",
      "  stack-v/view-ref view-ref → Item",
    ]);
  });
});

describe("layoutOf on code left unfinished, as it's written", () => {
  const screenOf = async (files: Record<string, string>, name: string) => {
    const app = await readApp(await appIn(files));
    const screen = app.screens().find((s) => s.name === name);
    expect(screen).toBeDefined();
    return app.layoutOf(screen?.id ?? "");
  };

  it("is undefined for a component missing its last brace, and for unfinished JSX in a file mentioning Flow", async () => {
    expect(
      await screenOf(
        { ...RN_MANIFEST, "src/S.tsx": tsx("export function S() { return <Text>Hi</Text>;") },
        "S",
      ),
    ).toBeUndefined();
    // A Flow type TypeScript reads past, in a file that only mentions Flow in a string: no Flow file, so undefined.
    const note = tsx(
      'const note = "@flow";',
      "export function S(props) { const t = (props.a: string); return <View><Text>{t}</Text></View>; }",
    );
    const placed = { "src/R.tsx": tsx('import { S } from "./S";', "export const R = () => <S />;") };
    expect(await screenOf({ ...RN_MANIFEST, "src/S.tsx": note, ...placed }, "S")).toBeUndefined();
    // A Flow file's error in its JSX is JSX left unfinished, not a Flow type.
    const flowJsx = [
      "/* @flow */",
      "import { View, Text, Image } from 'react-native';",
      "type Props = {| +a: string |};",
      "export function S(props: Props) { return <View><Text>Hi</Text><Image></View>; }",
    ].join("\n");
    expect(await screenOf({ ...RN_MANIFEST, "src/S.js": flowJsx, ...placed }, "S")).toBeUndefined();
  });

  it("is undefined for an unclosed square bracket, and for an extension of the view left open", async () => {
    expect(await screenOf(swiftBody("VStack { Text(values[0) }"), "S")).toBeUndefined();
    expect(await screenOf(swiftBody("VStack { Text(values]0[) }"), "S")).toBeUndefined();
    expect(await screenOf(composeBody("Column { Text(values[0) }"), "S")).toBeUndefined();
    const open = {
      "App/S.swift": swift(
        "struct S: View { var body: some View { Text(a); footer } }",
        "extension S { var footer: some View { Text(b)",
      ),
    };
    expect(await screenOf(open, "S")).toBeUndefined();
  });

  it("reads what follows a `throw` on its line", async () => {
    expect(await under(composeBody("if (bad) throw errors.missing(m) else Text(ok)"), "S")).toEqual([
      "conditional conditional",
      "  conditional/text text",
    ]);
  });
});

describe("layoutOf: decisions made when the app is built", () => {
  it("reads a SwiftUI `#if` as a decision, a branch per clause, and one that only adds modifiers as none", async () => {
    const { lines } = await layout(
      {
        "App/S.swift": swift(
          "struct S: View {",
          "  var body: some View {",
          "    VStack {",
          "      #if os(iOS)",
          '      Text("Phone")',
          "      #if DEBUG",
          '      Text("Debug")',
          "      #endif",
          "      #elseif os(macOS)",
          '      Image("mac")',
          "      #else",
          "      EmptyView()",
          "      #endif",
          '      Text("Both")',
          "        #if os(iOS)",
          "        .padding()",
          "        #endif",
          "      #if DEBUG",
          "      #endif",
          "    }",
          "  }",
          "}",
        ),
      },
      "S",
    );
    expect(lines).toEqual([
      ". view-ref → S",
      "  stack-v stack-v",
      "    stack-v/conditional conditional",
      "      stack-v/conditional/other other",
      "        stack-v/conditional/other/text text",
      "        stack-v/conditional/other/conditional conditional",
      "          stack-v/conditional/other/conditional/text text",
      "      stack-v/conditional/image image",
      "    stack-v/text text",
    ]);
  });

  it("matches a file's `#if`s once, however many are left open", async () => {
    const open = Array.from({ length: 4000 }, () => "      #if DEBUG").join("\n");
    const { tree } = await layout(
      {
        "App/S.swift": swift(
          "struct S: View {",
          "  var body: some View {",
          "    VStack {",
          open,
          '      Text("a")',
          "    }",
          "  }",
          "}",
        ),
      },
      "S",
    );
    expect(tree?.children[0]?.children.map((n) => n.kind)).toEqual(["text"]);
  });

  it("reads an `#if` around some of a switch's cases as written", async () => {
    const { lines } = await layout(
      {
        "App/S.swift": swift(
          "struct S: View {",
          "  var body: some View {",
          "    switch tab {",
          '    case .a: Text("a")',
          "    #if DEBUG",
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
    expect(lines).toEqual([
      ". view-ref → S",
      "  conditional conditional",
      "    conditional/text text",
      "    conditional/text.1 text",
      "    conditional/text.2 text",
    ]);
  });
});

describe("layoutOf: Compose overloads", () => {
  const dialogs = kotlin(
    "@Composable fun AppDialog(title: String, message: String, onDismiss: () -> Unit) {",
    "  AppDialog(title = title, message = AnnotatedString(message), onDismiss = onDismiss)",
    "}",
    "@Composable fun AppDialog(title: String, message: AnnotatedString, onDismiss: () -> Unit) {",
    "  Column { Text(title); Text(message) }",
    "}",
    "@Composable fun Badge(count: Int) { Text(count.toString()) }",
    "@Composable fun Badge(label: String, icon: Icon? = null) { Row { Text(label) } }",
    "@Composable fun Card(content: @Composable () -> Unit) { Column { content() } }",
    "@Composable fun Card(title: String, modifier: Modifier = Modifier) { Text(title) }",
  );
  const files = {
    "app/src/main/java/a/Dialogs.kt": dialogs,
    "app/src/main/java/a/S.kt": kotlin(
      "@Composable fun S() {",
      '  Column { Badge(label = "New"); Badge(3); Card { Text("x") }; Card("Title") }',
      "}",
    ),
  };

  it("places the overload whose parameters take the call's arguments", async () => {
    const { tree } = await layout(files, "S");
    const refs = tree?.children[0]?.children.map((n) => n.ref?.split("#")[1]);
    const ids = (await readApp(await appIn(files))).screens().filter((s) => s.name !== "S");
    const at = (name: string, line: number) =>
      ids.find((s) => s.name === name && s.line === line)?.id.split("#")[1];
    // The helper's import is line 1, so the overloads are on lines 8 to 11.
    expect(refs).toEqual([at("Badge", 9), at("Badge", 8), at("Card", 10), at("Card", 11)]);
  });

  it("tells overloads apart by each rule of what a call takes", async () => {
    // Each pair's wrong overload is written first, so it's the one placed when no rule tells them apart.
    const overloads = kotlin(
      ...Array.from({ length: 9 }, () => "// keeps every line below two digits"),
      '@Composable fun Named(other: String = "") { Text(other) }',
      "@Composable fun Named(title: String) { Text(title) }",
      '@Composable fun Chip(label: String = "", modifier: Modifier = Modifier) { Text(label) }',
      "@Composable fun Chip(content: @Composable () -> Unit) { Row { content() } }",
      "@Composable fun Count(count: Int, label: String) { Text(label) }",
      "@Composable fun Count(count: Int) { Text(count.toString()) }",
      "@Composable fun Pair(a: Int) { Text(a.toString()) }",
      "@Composable fun Pair(a: Int, b: Int) { Text(b.toString()) }",
      "@Composable fun Tags(tag: String) { Text(tag) }",
      "@Composable fun Tags(vararg tags: String) { Row { Text(tags[0]) } }",
      "@Composable fun Flag(flag: Boolean) { Text(flag.toString()) }",
      "@Composable fun Flag(flag: Boolean, label: String) { Text(label) }",
      "@Composable fun Many(vararg labels: String, required: Int) { Text(labels[0]) }",
      "@Composable fun Many(label: String) { Text(label) }",
      "@Composable fun Noted(count: Int) { Text(count.toString()) }",
      "@Composable fun Noted(label: String) { Text(label) }",
      "@Composable fun Arrow(content: () -> Unit) { Row { content() } }",
      "@Composable fun Arrow(count: Int = when (mode) { 1 -> 2; else -> 3 }) { Text(count.toString()) }",
      "@Composable fun Twice(a: Int, b: Boolean = false) { Text(a.toString()) }",
      "@Composable fun Twice(x: Int, a: String) { Text(a) }",
      "@Composable fun Spread(label: String) { Text(label) }",
      "@Composable fun Spread(vararg labels: String, required: Int) { Text(labels[0]) }",
      "@Composable fun Gen(a: Any, b: Any) { Text(a.toString()) }",
      "@Composable fun Gen(a: Any) { Row { Text(a.toString()) } }",
      "@Composable fun Cmp(flag: Boolean = 1 < 2, required: Int) { Text(flag.toString()) }",
      "@Composable fun Cmp(flag: Boolean) { Row { Text(flag.toString()) } }",
      "@Composable fun Bare(a: Int) { Text(a.toString()) }",
      '@Composable fun Bare() { Text("none") }',
      "@Composable fun Mixed(x: String, a: Int) { Text(x) }",
      "@Composable fun Mixed(a: Int, b: String) { Text(b) }",
    );
    const files = {
      "app/src/main/java/a/Overloads.kt": overloads,
      "app/src/main/java/a/S.kt": kotlin(
        "@Composable fun S() {",
        '  Column { Named(title = "a"); Chip { Text("x") }; Chip({ Text("y") }); Count(count = 2); Pair(1, 2); Tags("a", "b", "c")',
        '    Flag(count<limit, "ok"); Many("ok"); Noted(/* label */ label = "ok"); Arrow(3); Twice(1, a = "ok")',
        '    Tags(); Spread("a", "b", required = 1)',
        '    Gen(emptyMap<String, Int>()); Cmp(true); Bare(/* none */); Mixed(a = 1, "x") }',
        "}",
      ),
    };
    const { tree, app } = await layout(files, "S");
    const lineOf = (ref: string | undefined) => app.screens().find((s) => s.id === ref)?.line;
    expect(tree?.children[0]?.children.map((n) => lineOf(n.ref))).toEqual([
      12, 14, 14, 16, 18, 20, 22, 24, 26, 28, 30, 20, 32, 34, 36, 38, 40,
    ]);
  });

  it("places another overload, not itself, when an overload calls one that fits as well", async () => {
    const { tree, screen, app } = await layout(files, "AppDialog");
    const placed = tree?.children[0];
    expect(placed?.kind).toBe("view-ref");
    expect(placed?.ref).not.toBe(screen.id);
    expect(app.layoutOf(placed?.ref ?? "")?.children[0]?.kind).toBe("stack-v");
  });
});

describe("layoutOf: framework elements and code that isn't one", () => {
  it("reads SwiftUI's shapes, progress and image loaders, and a type's members that are values as no elements", async () => {
    const { lines, app, screen } = await layout(
      {
        "App/S.swift": swift(
          "struct S: View {",
          "  var body: some View {",
          "    VStack {",
          "      ProgressView()",
          "      RoundedRectangle(cornerRadius: 8)",
          "      KFImage(url)",
          "      Color.black.opacity(0.3)",
          "      Image.logo",
          "      DispatchQueue.main.asyncAfter(deadline: .now() + 1) { show = true }",
          "      let _ = Date.now",
          '      GroupBox { Text("a") }',
          "    }",
          "  }",
          "}",
        ),
      },
      "S",
    );
    expect(lines).toEqual([
      ". view-ref → S",
      "  stack-v stack-v",
      "    stack-v/other other",
      "    stack-v/other.1 other",
      "    stack-v/image image",
      "    stack-v/other.2 other",
      "    stack-v/image.1 image",
      "    stack-v/section section",
      "      stack-v/section/text text",
    ]);
    expect(app.layoutIssues(screen.id).issues.filter((i) => i.kind === "unknown-element")).toEqual([]);
  });

  it("reads Compose's dividers, menu items and segmented rows, and drops snackbars and assignments", async () => {
    const { lines } = await layout(
      {
        "app/src/main/java/a/S.kt": kotlin(
          "@Composable fun S(items: List<Item>) {",
          "  Column {",
          "    HorizontalDivider()",
          '    DropdownMenuItem(text = { Text("a") }, onClick = {})',
          '    SingleChoiceSegmentedButtonRow { SegmentedButton(selected = true, onClick = {}) { Text("b") } }',
          "    SnackbarHost(state)",
          '    rows += Row { Text("c") }',
          '    if (ready) count = 1 else Text("Waiting")',
          '    if (ready) count = if (other) 1 else 2 else Text("Later")',
          "    state =",
          "      UiState.Loading()",
          "  }",
          "}",
        ),
      },
      "S",
    );
    expect(lines).toEqual([
      ". view-ref → S",
      "  stack-v stack-v",
      "    stack-v/other other",
      "    stack-v/button button",
      "    stack-v/stack-h stack-h",
      "      stack-v/stack-h/button button",
      "    stack-v/conditional conditional",
      "      stack-v/conditional/text text",
      "    stack-v/conditional.1 conditional",
      "      stack-v/conditional.1/text text",
    ]);
  });

  it("reads React Native's spinner, SVG shapes and icons, and passes through a context's provider", async () => {
    const { lines } = await layout(
      {
        ...RN_MANIFEST,
        "src/S.tsx": tsx(
          'import { Path } from "react-native-svg";',
          "export function S() {",
          "  return (",
          "    <ThemeContext.Provider value={theme}>",
          '      <View><ActivityIndicator /><Path d={d} /><Icon name="x" /></View>',
          "    </ThemeContext.Provider>",
          "  );",
          "}",
        ),
      },
      "S",
    );
    expect(lines).toEqual([
      ". view-ref → S",
      "  stack-v stack-v",
      "    stack-v/other other",
      "    stack-v/image image",
      "    stack-v/image.1 image",
    ]);
  });
});

describe("layoutOf: names a framework and an app share", () => {
  it("reads an app's view of a name a framework type has, a LegendList of several columns as a grid, and a provider of what isn't read", async () => {
    const swiftApp = await layout(
      {
        "App/S.swift": swift(
          "struct Calendar: View {",
          "  static var preview: Calendar { Calendar() }",
          '  var body: some View { Text("Calendar") }',
          "}",
          'struct S: View { var body: some View { VStack { Calendar.preview; Text("Footer") } } }',
        ),
      },
      "S",
    );
    expect(swiftApp.tree?.children[0]?.children.map((n) => n.kind)).toEqual(["view-ref", "text"]);
    const rn = await layout(
      {
        ...RN_MANIFEST,
        "src/S.tsx": tsx(
          "export function S() {",
          "  return <LegendList data={items} numColumns={2} renderItem={({ item }) => <Text>{item.title}</Text>} />;",
          "}",
        ),
      },
      "S",
    );
    expect(rn.tree?.children.map((n) => n.kind)).toEqual(["lazy-grid"]);
    const provider = await layout(
      {
        ...RN_MANIFEST,
        "src/S.tsx": tsx(
          "export function S({ children }) {",
          "  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;",
          "}",
        ),
      },
      "S",
    );
    expect(provider.tree?.children.map((n) => n.kind)).toEqual(["other"]);
  });
});

describe("layoutOf: Compose functions annotated as previews", () => {
  it("reads the layout of a function the scan lists though it's annotated @Preview", async () => {
    const { tree } = await layout(
      {
        "app/src/main/java/a/Crash.kt": kotlin(
          "@Composable",
          "@Preview",
          'fun CrashReportPage(message: String = "x") {',
          '  Column { Text(message); Button(onClick = {}) { Text("Copy") } }',
          "}",
        ),
      },
      "CrashReportPage",
    );
    expect(tree?.children[0]?.children.map((n) => n.kind)).toEqual(["text", "button"]);
  });

  it("reads a composable, not a preview of the same name, in a view that adds the preview", async () => {
    const rel = "app/src/main/java/a/Card.kt";
    const { app, screen } = await layout(
      { [rel]: kotlin("@Composable", "fun Card(label: String) { Row { Text(label) } }") },
      "Card",
    );
    const view = await app.withChanges({
      [rel]: kotlin(
        "@Composable @Preview",
        'fun Card() { Column { Text("preview") } }',
        "@Composable",
        "fun Card(label: String) { Row { Text(label) } }",
      ),
    });
    expect(view.layoutOf(screen.id)?.children[0]?.kind).toBe("stack-h");
  });
});
