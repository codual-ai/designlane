import { describe, expect, it } from "vitest";
import { type LayoutNode, readApp, type ScreenPart, ScreenPartSchema } from "../../src/read/index.js";
import { kotlin, RN_MANIFEST, swift, tsx } from "../helpers/catalog.js";
import { appIn } from "../helpers/read-apps.js";

/** The parts of the view `name` in an app of `files`, checked against the schema and against their views' layouts. */
async function parts(files: Record<string, string>, name: string) {
  const app = await readApp(await appIn(files));
  const screen = app.screens().find((s) => s.name === name);
  if (!screen) throw new Error(`no view ${name}`);
  const found = app.screenParts(screen.id);
  for (const part of found ?? []) {
    expect(ScreenPartSchema.safeParse(part).success).toBe(true);
    const ids = (n: LayoutNode): string[] => [n.id, ...n.children.flatMap(ids)];
    const layout = app.layoutOf(part.view);
    expect(layout && ids(layout)).toContain(part.id);
  }
  return { app, screen, parts: found, labels: found?.map((p) => p.label) };
}

const SWIFT_PAYWALL = swift(
  "struct PaywallScreen: View {",
  "  var body: some View {",
  "    NavigationStack {",
  "      ScrollView {",
  "        VStack {",
  "          HeaderView()",
  '          Section("Plans") { PlanRow() }',
  "          benefitsSection",
  "          // Footer",
  '          HStack { Text("Terms"); Text("Privacy") }',
  "          Spacer()",
  '          Button("Continue") { buy() }',
  '          Image(systemName: "star")',
  "        }",
  "      }",
  "    }",
  "  }",
  '  private var benefitsSection: some View { VStack { Text("Unlimited") } }',
  "}",
  'struct HeaderView: View { var body: some View { Text("Pro") } }',
  'struct PlanRow: View { var body: some View { Text("Yearly") } }',
);

describe("screenParts: which nodes are parts", () => {
  it("steps in through what holds the whole screen to the nodes of the first that holds two or more", async () => {
    const { parts: found, screen } = await parts({ "App/Paywall.swift": SWIFT_PAYWALL }, "PaywallScreen");
    expect(found?.map((p) => [p.id, p.label])).toEqual([
      ["nav/scroll/stack-v/view-ref", "Header"],
      ["nav/scroll/stack-v/section", "Plans"],
      ["nav/scroll/stack-v/stack-v", "Benefits section"],
      ["nav/scroll/stack-v/stack-h", "Footer"],
      ["nav/scroll/stack-v/button", "Continue"],
      ["nav/scroll/stack-v/image", "Image"],
    ]);
    expect(found?.every((p) => p.view === screen.id)).toBe(true);
    expect(found?.[0]?.ref).toBe("swiftui:App/Paywall.swift#HeaderView");
    expect(found?.[1]).not.toHaveProperty("ref");
  });

  it("gives each part its node's span", async () => {
    const {
      app,
      parts: found,
      screen,
    } = await parts({ "App/Paywall.swift": SWIFT_PAYWALL }, "PaywallScreen");
    const stack = app.layoutOf(screen.id)?.children[0]?.children[0]?.children[0];
    expect(found?.map((p) => p.span)).toEqual(
      stack?.children.filter((n) => n.kind !== "spacer").map((n) => n.span),
    );
    const of = (p: ScreenPart | undefined) => p && SWIFT_PAYWALL.slice(p.span.start, p.span.end);
    expect(of(found?.[1])).toBe('Section("Plans") { PlanRow() }');
  });

  it("is empty when nothing holds two or more parts, and undefined when the layout can't be read", async () => {
    const files = {
      "App/List.swift": swift(
        'struct ListScreen: View { var body: some View { List { ForEach(items) { Text($0.name); Image("a") } } } }',
      ),
      "App/One.swift": swift(
        'struct OneScreen: View { var body: some View { VStack { Text("a"); Spacer() } } }',
      ),
      "App/None.swift": swift("struct NoneScreen: View { var body: some View { EmptyView() } }"),
      "App/Broken.swift": swift('struct BrokenScreen: View { var body: some View { VStack { Text("a" } } }'),
    };
    const app = await readApp(await appIn(files));
    expect(app.screenParts("swiftui:App/List.swift#ListScreen")).toEqual([]);
    expect(app.screenParts("swiftui:App/One.swift#OneScreen")).toEqual([]);
    expect(app.screenParts("swiftui:App/None.swift#NoneScreen")).toEqual([]);
    expect(app.layoutOf("swiftui:App/Broken.swift#BrokenScreen")).toBeUndefined();
    expect(app.screenParts("swiftui:App/Broken.swift#BrokenScreen")).toBeUndefined();
    expect(() => app.screenParts("swiftui:App/Nope.swift#Nope")).toThrow(/No screen/);
  });

  it("follows the one view a screen places, giving the parts in that view's layout", async () => {
    const files = {
      "app/src/main/java/a/Plans.kt": kotlin(
        "@Composable fun PlansRoute(vm: Vm) {",
        "  LifecycleEventEffect(Lifecycle.Event.ON_STOP) { vm.stop() }",
        '  TrackScreenViewEvent(screenName = "Plans")',
        "  PlansScreen(vm.state)",
        "}",
        "@Composable fun TrackScreenViewEvent(screenName: String) { LaunchedEffect(Unit) { log(screenName) } }",
      ),
      "app/src/main/java/a/PlansScreen.kt": kotlin(
        "@Composable fun PlansScreen(state: State) {",
        '  Scaffold(topBar = { TopAppBar(title = { Text("Plans") }) }) { padding ->',
        '    Column { PlanList(state.plans); Button(onClick = {}) { Text("Buy") } }',
        "  }",
        "}",
        "@Composable fun PlanList(plans: List<Plan>) { LazyColumn { items(plans) { Text(it.name) } } }",
      ),
    };
    const { parts: found } = await parts(files, "PlansRoute");
    expect(found?.map((p) => [p.view.split("#")[1], p.id, p.label, p.span.file])).toEqual([
      ["PlansScreen", "nav/toolbar", "Plans", "app/src/main/java/a/PlansScreen.kt"],
      ["PlansScreen", "nav/stack-v", "Buy", "app/src/main/java/a/PlansScreen.kt"],
    ]);
  });

  it("reads what a screen writes inside a container of the app's, not the container's own parts", async () => {
    const { parts: found, screen } = await parts(
      {
        ...RN_MANIFEST,
        "src/Screen.tsx": tsx(
          "export function Screen({ children }) {",
          "  return <View><NavBar /><LoadingBanner />{children}</View>;",
          "}",
          "export const NavBar = () => <Text>Nav</Text>;",
          "export const LoadingBanner = () => <Text>Loading</Text>;",
        ),
        "src/Search.tsx": tsx(
          'import { Screen } from "./Screen";',
          "export function SearchScreen() {",
          "  return <Screen><TextInput /><Text>Results</Text></Screen>;",
          "}",
        ),
      },
      "SearchScreen",
    );
    expect(found?.map((p) => [p.id, p.label])).toEqual([
      ["view-ref/input", "Input"],
      ["view-ref/text", "Results"],
    ]);
    expect(found?.[0]?.view).toBe(screen.id);
  });

  it("steps into the biggest branch of an `if` over the whole screen", async () => {
    const { parts: found, screen } = await parts(
      {
        "App/Feed.swift": swift(
          "struct FeedScreen: View {",
          "  var body: some View {",
          '    if loading { ProgressView() } else { VStack { Text("Top"); FeedList() } }',
          "  }",
          "}",
          'struct FeedList: View { var body: some View { List { Text("a") } } }',
        ),
      },
      "FeedScreen",
    );
    expect(found?.map((p) => [p.id, p.label])).toEqual([
      ["conditional/stack-v/text", "Top"],
      ["conditional/stack-v/view-ref", "Feed list"],
    ]);
    expect(found?.[0]?.view).toBe(screen.id);
  });

  it("stops at views that place each other, and past the views it follows", async () => {
    const chain = Array.from(
      { length: 10 },
      (_, i) => `struct V${i}: View { var body: some View { V${i + 1}() } }`,
    );
    const files = {
      "App/Loop.swift": swift(
        "struct A: View { var body: some View { B() } }",
        "struct B: View { var body: some View { A() } }",
      ),
      "App/Chain.swift": swift(
        ...chain,
        'struct V10: View { var body: some View { VStack { Text("a"); Text("b") } } }',
      ),
    };
    const app = await readApp(await appIn(files));
    expect(app.screenParts("swiftui:App/Loop.swift#A")).toEqual([]);
    expect(app.screenParts("swiftui:App/Chain.swift#V2")?.map((p) => p.label)).toEqual(["a", "b"]);
    expect(app.screenParts("swiftui:App/Chain.swift#V0")).toEqual([]);
  });

  it("doesn't count a view that shows nothing, or spacers, as parts", async () => {
    const { labels } = await parts(
      {
        "App/S.swift": swift(
          "struct S: View {",
          '  var body: some View { VStack { Tracker(); Text("a"); Spacer(); Text("b") } }',
          "}",
          "struct Tracker: View { var body: some View { EmptyView() } }",
        ),
      },
      "S",
    );
    expect(labels).toEqual(["a", "b"]);
  });

  it("doesn't count what only runs code or opens dialogs, through the views it places, as parts", async () => {
    const { labels } = await parts(
      {
        "app/src/main/java/a/S.kt": kotlin(
          "@Composable fun SettingsScreen(vm: Vm) {",
          "  EventsEffect(vm) { event -> when (event) { Back -> onBack(); Open -> onOpen() } }",
          "  SettingsDialogs(vm.dialog)",
          "  Column {",
          '    Text("Account")',
          "    Tree(vm.root)",
          "    Loop()",
          "  }",
          "}",
          "@Composable fun EventsEffect(vm: Vm, handle: (Event) -> Unit) { LaunchedEffect(vm) { vm.events.collect(handle) } }",
          "@Composable fun SettingsDialogs(dialog: Dialog?) {",
          "  when (dialog) { is Error -> ErrorDialog(dialog.message); Loading -> Spinner(); null -> Unit }",
          "}",
          "@Composable fun ErrorDialog(message: String) { AlertDialog(onDismissRequest = {}, text = { Text(message) }) }",
          "@Composable fun Spinner() { Dialog(onDismissRequest = {}) { CircularProgressIndicator() } }",
          "@Composable fun Tree(node: Node) { Text(node.name); node.children.forEach { Tree(it) } }",
          "@Composable fun Loop() { Loop() }",
        ),
      },
      "SettingsScreen",
    );
    // A view whose code can't be read might show anything, so it stays a part.
    const unread = await parts(
      {
        "App/S.swift": swift('struct S: View { var body: some View { VStack { Text("a"); Broken() } } }'),
        "App/Broken.swift": swift('struct Broken: View { var body: some View { VStack { Text("b" } } }'),
      },
      "S",
    );
    expect(unread.labels).toEqual(["a", "Broken"]);
    // What runs code and opens dialogs is dropped, so the column holds the parts; a view placing itself still shows
    // what else it holds.
    expect(labels).toEqual(["Account", "Tree"]);
  });
});

describe("screenParts: labels", () => {
  /** The labels of a SwiftUI screen whose stack holds `lines`. */
  const labelsOf = async (...lines: string[]) =>
    (
      await parts(
        {
          "App/S.swift": swift(
            "struct S: View {",
            "  var body: some View {",
            "    VStack {",
            ...lines,
            "    }",
            "  }",
            '  var promoCard: some View { HStack { Text("Promo") } }',
            '  var offerCard: some View {\n    return HStack { Text("Offer") }\n  }',
            "}",
            'struct BannerView: View { var body: some View { Text("b") } }',
            'struct PlanListScreen: View { var body: some View { Text("p") } }',
            'struct ShareURLField: View { var body: some View { Text("u") } }',
          ),
        },
        "S",
      )
    ).labels;

  it("takes the first of a title, the view's name, its property, a comment, its text, and its kind", async () => {
    expect(
      await labelsOf(
        "      // Ignored",
        '      Section("Plans") { Text("Row") }',
        "      // Not the name",
        "      BannerView()",
        "      // Not the name either",
        "      promoCard",
        "      // Footer",
        '      HStack { Text("Terms") }',
        '      HStack { Text("Help") }',
        '      HStack { Image("x") }',
      ),
    ).toEqual(["Plans", "Banner", "Promo card", "Footer", "Help", "Row"]);
  });

  it("names a view by its words without View or Screen, keeping acronyms", async () => {
    expect(
      await labelsOf(
        "      BannerView()",
        "      PlanListScreen()",
        "      ShareURLField()",
        "      offerCard",
      ),
    ).toEqual(["Banner", "Plan list", "Share URL field", "Offer card"]);
  });

  it("titles a section by its header, and reads comments of a few words, MARK ones too", async () => {
    expect(
      await labelsOf(
        '      Section { Text("Row") } header: { Text("Account") }',
        "      // MARK: - Legal",
        '      HStack { Text("a") }; HStack { Text("Second") }',
        "      // This explains what the code below is for",
        '      HStack { Text("Shown") }',
        "      // TODO fix",
        '      HStack { Text("Todo shown") }',
        "      /* Social */",
        '      HStack { Text("b") }',
      ),
    ).toEqual(["Account", "Legal", "Second", "Shown", "Todo shown", "Social"]);
  });

  it("leaves code and translation keys out of text, caps long labels, and numbers ones that repeat", async () => {
    expect(
      await labelsOf(
        '      Text("\\(count) items left")',
        '      Text("settings.title")',
        '      Text("\\(name)")',
        '      Text("42")',
        '      Text("Unlimited habits, streak protection and more")',
        "      BannerView()",
        "      BannerView()",
        "      BannerView()",
      ),
    ).toEqual([
      "items left",
      "Text",
      "Text 2",
      "Text 3",
      "Unlimited habits…",
      "Banner",
      "Banner 2",
      "Banner 3",
    ]);
  });

  it("names a decision by its biggest branch, and a loop by its item", async () => {
    expect(
      await labelsOf(
        "      if pro { EmptyView() } else { BannerView() }",
        '      if loading { Text("Loading") } else { BannerView() }',
        "      ForEach(plans) { _ in PlanListScreen() }",
      ),
    ).toEqual(["Banner", "Banner 2", "Plan list"]);
  });

  it("reads Compose's and React Native's comments and text", async () => {
    const compose = await parts(
      {
        "app/src/main/java/a/S.kt": kotlin(
          "@Composable fun SettingsScreen() {",
          "  Column {",
          "    // Profile",
          "    Row { Icon(Icons.Person, null) }",
          '    Text("Signed in as $user")',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: a Kotlin string template, not a JavaScript one.
          '    Text("${count} devices")',
          "  }",
          "}",
        ),
      },
      "SettingsScreen",
    );
    expect(compose.labels).toEqual(["Profile", "Signed in as", "devices"]);
    const rn = await parts(
      {
        ...RN_MANIFEST,
        "src/Settings.tsx": tsx(
          "export function SettingsScreen() {",
          "  return (",
          "    <View>",
          "      {/* Profile */}",
          "      <View><Image source={a} /><Image source={b} /></View>",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: a JavaScript template in the app\'s code, not this one.
          "      <Text>{`${n} devices`}</Text>",
          "      <Pressable><Text>Sign out</Text></Pressable>",
          "    </View>",
          "  );",
          "}",
        ),
      },
      "SettingsScreen",
    );
    // A template with code in it isn't text the file lists, so its part goes by its kind.
    expect(rn.labels).toEqual(["Profile", "Text", "Sign out"]);
  });
});

describe("screenParts and views", () => {
  const files = {
    "App/A.swift": swift('struct A: View { var body: some View { VStack { Text("a"); Text("b") } } }'),
  };

  it("reads a screen as a view changes it, leaving the app as it was", async () => {
    const app = await readApp(await appIn(files));
    const view = await app.withChanges({
      "App/A.swift": swift(
        'struct A: View { var body: some View { VStack { Text("c"); Text("d"); Text("e") } } }',
      ),
    });
    expect(view.screenParts("swiftui:App/A.swift#A")?.map((p) => p.label)).toEqual(["c", "d", "e"]);
    expect(app.screenParts("swiftui:App/A.swift#A")?.map((p) => p.label)).toEqual(["a", "b"]);
  });

  it("follows, and gives the files of, a view declared only in a file the view adds", async () => {
    const app = await readApp(await appIn(files));
    const view = await app.withChanges({
      "App/A.swift": swift("struct A: View { var body: some View { Badge() } }"),
      "App/Badge.swift": swift(
        'struct Badge: View { var body: some View { HStack { Image("b"); Text("New") } } }',
      ),
    });
    const found = view.screenParts("swiftui:App/A.swift#A");
    expect(found?.map((p) => [p.view, p.label])).toEqual([
      ["swiftui:App/Badge.swift#Badge", "Image"],
      ["swiftui:App/Badge.swift#Badge", "New"],
    ]);
    expect(view.filesFor("swiftui:App/Badge.swift#Badge")[0]).toEqual({
      file: "App/Badge.swift",
      why: "declaration",
    });
    expect(() => app.filesFor("swiftui:App/Badge.swift#Badge")).toThrow(/No screen/);
  });
});

describe("screenParts on code as it's written", () => {
  it("names a part by its view property only when it's what the property writes first", async () => {
    const { labels } = await parts(
      {
        "App/S.swift": swift(
          "struct S: View {",
          "  var body: some View { content }",
          "  private var content: some View {",
          "    VStack {",
          "      // Plans",
          '      HStack { Text("Yearly") }',
          '      Text("Welcome")',
          '      Button("Buy") {}',
          "    }",
          "  }",
          "}",
        ),
      },
      "S",
    );
    expect(labels).toEqual(["Plans", "Welcome", "Buy"]);
  });

  it("steps into an `if` inside the biggest branch, and picks the biggest branch of those that show something", async () => {
    const files = {
      "App/S.swift": swift(
        "struct S: View {",
        '  var body: some View { if a { Text("x") } else { if b { VStack { Text("a"); Text("b") } } else { Text("y") } } }',
        "}",
        "struct T: View {",
        '  var body: some View { if a { VStack { Text("a"); Text("b") } } else { VStack { Tracker(); Tracker(); Tracker() } } }',
        "}",
        "struct Tracker: View { var body: some View { EmptyView() } }",
      ),
    };
    const app = await readApp(await appIn(files));
    expect(app.screenParts("swiftui:App/S.swift#S")?.map((p) => p.label)).toEqual(["a", "b"]);
    expect(app.screenParts("swiftui:App/S.swift#T")?.map((p) => p.label)).toEqual(["a", "b"]);
    // A placed view outweighs a spinner, so a loading screen's parts are its content's.
    const loading = await appIn({
      "App/L.swift": swift(
        "struct L: View { var body: some View { if loading { ProgressView() } else { Feed() } } }",
        'struct Feed: View { var body: some View { VStack { Text("a"); Text("b") } } }',
      ),
    });
    const parts = (await readApp(loading)).screenParts("swiftui:App/L.swift#L");
    expect(parts?.map((p) => [p.view, p.label])).toEqual([
      ["swiftui:App/L.swift#Feed", "a"],
      ["swiftui:App/L.swift#Feed", "b"],
    ]);
  });

  it("doesn't count a branch of several things that show nothing as a part", async () => {
    const { labels } = await parts(
      {
        "app/src/main/java/a/S.kt": kotlin(
          "@Composable fun S(vm: Vm) {",
          '  Column { Text("Top"); if (vm.on) { Track(); Track() }; Text("Bottom") }',
          "}",
          "@Composable fun Track() { LaunchedEffect(Unit) { log() } }",
        ),
      },
      "S",
    );
    expect(labels).toEqual(["Top", "Bottom"]);
  });

  it("knows views placing each other show what either shows, in any order", async () => {
    const views = (order: string) =>
      swift(
        `struct S: View { var body: some View { VStack { ${order}; Text("y") } } }`,
        'struct A: View { var body: some View { VStack { B(); Text("x") } } }',
        "struct B: View { var body: some View { A() } }",
      );
    for (const order of ["A(); B()", "B(); A()"]) {
      const { labels } = await parts({ "App/S.swift": views(order) }, "S");
      expect(labels?.sort()).toEqual(["A", "B", "y"]);
    }
  });

  it("looks a bounded way into views placing views, taking one past that to show something", async () => {
    const chain = Array.from(
      { length: 2500 },
      (_, i) => `struct C${i}: View { var body: some View { C${i + 1}() } }`,
    );
    const { labels } = await parts(
      {
        "App/S.swift": swift(
          'struct S: View { var body: some View { VStack { C0(); Text("y") } } }',
          ...chain,
          "struct C2500: View { var body: some View { EmptyView() } }",
        ),
      },
      "S",
    );
    expect(labels).toEqual(["C 0", "y"]);
  });

  it("doesn't keep what the limit took as a view's own answer, in any order", async () => {
    const chain = Array.from(
      { length: 33 },
      (_, i) => `struct C${i}: View { var body: some View { C${i + 1}() } }`,
    );
    for (const order of ["C0(); C31()", "C31(); C0()"]) {
      const { labels } = await parts(
        {
          "App/S.swift": swift(
            `struct S: View { var body: some View { VStack { ${order}; Text("y") } } }`,
            ...chain,
            "struct C33: View { var body: some View { EmptyView() } }",
          ),
        },
        "S",
      );
      // C31 is near enough to know it shows nothing, whatever was looked into first; C0 is past the limit unless
      // what's known by then says it shows nothing.
      expect(labels ?? []).not.toContain("C 31");
      if (order.startsWith("C0")) expect(labels).toEqual(["C 0", "y"]);
    }
  });

  it("leaves out commented-out code and tools' directives, and keeps text ending in punctuation", async () => {
    const { labels } = await parts(
      {
        "App/S.swift": swift(
          "struct S: View {",
          "  var body: some View {",
          "    VStack {",
          '      // Text("Old")',
          '      HStack { Text("Loading...") }',
          "      // swiftlint:disable:next all",
          '      HStack { Text("Done.") }',
          "      // @ts-ignore",
          '      HStack { Text("Ready") }',
          "    }",
          "  }",
          "}",
        ),
      },
      "S",
    );
    expect(labels).toEqual(["Loading...", "Done.", "Ready"]);
  });

  it("finds a section's header past its content, not in its strings", async () => {
    const { labels } = await parts(
      {
        "App/S.swift": swift(
          "struct S: View {",
          "  var body: some View {",
          "    Form {",
          '      Section { Text("header: details"); Text("Row") } header: { Text("Account") }',
          '      Section { Text("Close }"); Text("Row") } header: { Text("Profile") }',
          '      Section { /* } */ Image("}"); Text("Row") } header: { Text("Billing") }',
          '      Section { Section { Text("a") } header: { Text("Inner") } } footer: { Text("f") }',
          "    }",
          "  }",
          "}",
        ),
      },
      "S",
    );
    expect(labels).toEqual(["Account", "Profile", "Billing", "a"]);
  });

  it("keeps numbered labels within the cap", async () => {
    const { labels } = await parts(
      {
        "App/S.swift": swift(
          'struct S: View { var body: some View { VStack { Text("abcdefghijklmnopqrstuvwx"); Text("abcdefghijklmnopqrstuvwx") } } }',
        ),
      },
      "S",
    );
    expect(labels).toEqual(["abcdefghijklmnopqrstuvwx", "abcdefghijklmnopqrstu… 2"]);
    expect(labels?.every((l) => l.length <= 24)).toBe(true);
  });

  it("gives the files of a screen whose file a view changes, though its rules for changed files don't find it", async () => {
    const text = (t: string) =>
      swift(`struct P: SwiftUI.View { var body: some View { VStack { Text("${t}"); Text("b") } } }`);
    const app = await readApp(await appIn({ "App/P.swift": text("a") }));
    const view = await app.withChanges({ "App/P.swift": text("c") });
    expect(view.filesFor("swiftui:App/P.swift#P")[0]).toEqual({ file: "App/P.swift", why: "declaration" });
    expect(view.screenParts("swiftui:App/P.swift#P")?.map((p) => p.label)).toEqual(["c", "b"]);
  });
});
