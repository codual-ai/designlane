import { describe, expect, it } from "vitest";
import { RelatedFileSchema, readApp } from "../../src/read/index.js";
import { kotlin, swift, tsx } from "../helpers/catalog.js";
import { appIn, COMPOSE_APP, RN_APP, SHOP, SWIFT_APP, THEMES } from "../helpers/read-apps.js";

const related = async (files: Record<string, string>, id: string) =>
  (await readApp(await appIn(files))).filesFor(id);

describe("filesFor", () => {
  it("lists a SwiftUI screen's file, the views it places, its model and its tokens' files", async () => {
    expect(await related(SWIFT_APP, "swiftui:App/CartScreen.swift#CartScreen")).toEqual([
      { file: "App/CartScreen.swift", why: "declaration" },
      { file: "App/CartRow.swift", why: "child-view" },
      { file: "App/CartModel.swift", why: "view-model" },
      { file: "App/Theme.swift", why: "tokens" },
    ]);
  });

  it("lists a Compose screen's file, the composables it calls, its view model and its tokens' files", async () => {
    expect(await related(COMPOSE_APP, "compose:app/src/main/java/a/cart/CartScreen.kt#CartScreen")).toEqual([
      { file: "app/src/main/java/a/cart/CartScreen.kt", why: "declaration" },
      { file: "app/src/main/java/a/cart/CartRow.kt", why: "child-view" },
      { file: "app/src/main/java/a/cart/CartViewModel.kt", why: "view-model" },
      { file: "app/src/main/java/a/ui/theme/Color.kt", why: "tokens" },
      { file: "app/src/main/java/a/ui/theme/Type.kt", why: "tokens" },
    ]);
  });

  it("lists a React Native screen's file, its components, its tokens' files and its own imports, not packages", async () => {
    expect(await related(RN_APP, "react-native:src/CartScreen.tsx#CartScreen")).toEqual([
      { file: "src/CartScreen.tsx", why: "declaration" },
      { file: "src/CartRow.tsx", why: "child-view" },
      { file: "src/theme.ts", why: "tokens" },
      { file: "src/useCart.ts", why: "import" },
    ]);
  });

  it("follows views placed in placed views, and leaves out previews", async () => {
    const app = await readApp(SHOP);
    expect(app.filesFor("swiftui:Shop/Views/PaywallView.swift#PaywallView")).toEqual([
      { file: "Shop/Views/PaywallView.swift", why: "declaration" },
      { file: "Shop/Views/PlanRow.swift", why: "child-view" },
      { file: "Shop/Assets.xcassets/AccentColor.colorset/Contents.json", why: "tokens" },
    ]);
    const deep = await related(
      {
        "App/Home.swift": swift("struct Home: View { var body: some View { Section() } }"),
        "App/Section.swift": swift("struct Section: View { var body: some View { Row() } }"),
        "App/Row.swift": swift("struct Row: View { var body: some View { Text(t) } }"),
      },
      "swiftui:App/Home.swift#Home",
    );
    expect(deep.map((f) => f.file)).toEqual(["App/Home.swift", "App/Section.swift", "App/Row.swift"]);
  });

  it("takes a placed name to the view declared nearest it", async () => {
    const files = await related(
      {
        "A/Home.swift": swift("struct Home: View { var body: some View { Row() } }"),
        "A/Row.swift": swift("struct Row: View { var body: some View { Text(t) } }"),
        "B/Row.swift": swift("struct Row: View { var body: some View { Text(t) } }"),
        "B/Other.swift": swift("struct Other: View { var body: some View { Row() } }"),
      },
      "swiftui:A/Home.swift#Home",
    );
    expect(files.map((f) => f.file)).toEqual(["A/Home.swift", "A/Row.swift"]);
  });

  it("counts a state holder only by its name's last word, and only when the code names it", async () => {
    const files = await related(
      {
        "app/src/main/java/a/Home.kt": kotlin(
          "@Composable fun Home(vm: HomeViewModel, models: Modeling) { Text(vm.title) } // CartViewModel",
        ),
        "app/src/main/java/a/HomeViewModel.kt": kotlin("class HomeViewModel : ViewModel()"),
        "app/src/main/java/a/CartViewModel.kt": kotlin("class CartViewModel : ViewModel()"),
        "app/src/main/java/a/Modeling.kt": kotlin("class Modeling"),
      },
      "compose:app/src/main/java/a/Home.kt#Home",
    );
    expect(files).toEqual([
      { file: "app/src/main/java/a/Home.kt", why: "declaration" },
      { file: "app/src/main/java/a/HomeViewModel.kt", why: "view-model" },
    ]);
  });

  it("follows a React Native path alias to the project's file", async () => {
    const files = await related(
      {
        ...RN_APP,
        "src/CartScreen.tsx": tsx(
          'import { useCart } from "@/useCart";',
          "export function CartScreen() { const cart = useCart(); return <View />; }",
        ),
      },
      "react-native:src/CartScreen.tsx#CartScreen",
    );
    expect(files.map((f) => f.file)).toEqual(["src/CartScreen.tsx", "src/useCart.ts"]);
  });

  it("refuses a screen the app doesn't have", async () => {
    const app = await readApp(SHOP);
    expect(() => app.filesFor("swiftui:Shop/Nope.swift#Nope")).toThrow(/No screen/);
  });

  it("answers for a view's changes, and leaves the app as it was", async () => {
    const app = await readApp(await appIn(SWIFT_APP));
    const id = "swiftui:App/CartScreen.swift#CartScreen";
    expect(app.filesFor(id).map((f) => f.file)).toContain("App/CartRow.swift");
    const view = await app.withChanges({
      "App/CartScreen.swift": SWIFT_APP["App/CartScreen.swift"].replace("CartRow(title: t)", "Text(t)"),
    });
    expect(view.filesFor(id).map((f) => f.file)).toEqual(["App/CartScreen.swift", "App/CartModel.swift"]);
    expect(app.filesFor(id).map((f) => f.file)).toContain("App/CartRow.swift");
    await app.update("App/CartModel.swift", null);
    expect(app.filesFor(id).map((f) => f.file)).not.toContain("App/CartModel.swift");
  });

  it("takes the screen itself as well as its id, and gives files the schema accepts", async () => {
    const app = await readApp(await appIn(COMPOSE_APP));
    const [screen] = app.screens().filter((s) => s.name === "CartScreen");
    const files = app.filesFor(screen ?? "");
    expect(files).toEqual(app.filesFor(screen?.id ?? ""));
    expect(files.every((f) => RelatedFileSchema.safeParse(f).success)).toBe(true);
  });

  it("counts only the tokens a screen's own code uses, not another view's in its file", async () => {
    const files = await related(
      {
        ...SWIFT_APP,
        "App/CartScreen.swift": swift(
          "struct CartScreen: View { var body: some View { Text(t) } }",
          "struct Other: View { var body: some View { Text(t).foregroundStyle(Color.brand) } }",
        ),
      },
      "swiftui:App/CartScreen.swift#CartScreen",
    );
    expect(files.map((f) => f.file)).toEqual(["App/CartScreen.swift"]);
  });

  it("follows only what the screen's own declaration places, and each view once, though two place each other", async () => {
    const files = await related(
      {
        "App/Home.swift": swift(
          "struct Home: View { var body: some View { Card() } }",
          "struct Other: View { var body: some View { Extra() } }",
        ),
        "App/Card.swift": swift("struct Card: View { var body: some View { Back() } }"),
        "App/Back.swift": swift("struct Back: View { var body: some View { Card() } }"),
        "App/Extra.swift": swift("struct Extra: View { var body: some View { Text(t) } }"),
      },
      "swiftui:App/Home.swift#Home",
    );
    expect(files.map((f) => f.file)).toEqual(["App/Home.swift", "App/Card.swift", "App/Back.swift"]);
  });

  it("takes neither a view, nor a type declared in tests, nor in React Native code, for what holds a screen's state", async () => {
    const swiftFiles = await related(
      {
        ...SWIFT_APP,
        "App/CartScreen.swift": swift(
          "struct CartScreen: View { let banner: BannerState? = nil; let model: CartModel; var body: some View { Text(t) } }",
        ),
        "App/BannerState.swift": swift("struct BannerState: View { var body: some View { Text(t) } }"),
        "App/CartModel.swift": swift("struct Other {}"),
        "AppTests/CartModelTests.swift": swift("final class CartModel {}"),
      },
      "swiftui:App/CartScreen.swift#CartScreen",
    );
    expect(swiftFiles.map((f) => f.file)).toEqual(["App/CartScreen.swift"]);
    const app = await readApp(await appIn({ ...SWIFT_APP, "App/CartModel.swift": swift("struct Other {}") }));
    const view = await app.withChanges({
      "AppTests/CartModelTests.swift": swift("final class CartModel {}"),
    });
    expect(view.filesFor("swiftui:App/CartScreen.swift#CartScreen").map((f) => f.why)).not.toContain(
      "view-model",
    );
    const rn = await related(
      {
        ...RN_APP,
        "src/state.ts": "interface CartState { items: string[] }",
        "src/CartScreen.tsx": tsx("export function CartScreen(props: CartState) { return <View />; }"),
      },
      "react-native:src/CartScreen.tsx#CartScreen",
    );
    expect(rn.map((f) => f.file)).toEqual(["src/CartScreen.tsx"]);
  });

  it("doesn't take a package's import for one of the project's files, though a file's name matches it", async () => {
    const files = await related(
      {
        ...RN_APP,
        "package.json": JSON.stringify({ dependencies: { "react-native": "0.76.0", lodash: "4.17.21" } }),
        "src/debounce.ts": "export default function debounce() {}",
        "src/CartScreen.tsx": tsx(
          'import debounce from "lodash/debounce";',
          "export function CartScreen() { return <View />; }",
        ),
      },
      "react-native:src/CartScreen.tsx#CartScreen",
    );
    expect(files.map((f) => f.file)).toEqual(["src/CartScreen.tsx"]);
  });

  it("lists each theme's file for a color read through the picked theme", async () => {
    const split = THEMES.indexOf("public struct DesertDark");
    const files = await related(
      {
        "App/ColorSet.swift": THEMES.slice(0, split),
        "App/Desert.swift": swift(THEMES.slice(split)),
        "App/Home.swift": swift(
          "struct Home: View {",
          "  @Environment(\\.theme) var theme",
          "  var body: some View { Text(t).foregroundStyle(theme.tintColor) }",
          "}",
        ),
      },
      "swiftui:App/Home.swift#Home",
    );
    expect(files).toEqual([
      { file: "App/Home.swift", why: "declaration" },
      { file: "App/ColorSet.swift", why: "tokens" },
      { file: "App/Desert.swift", why: "tokens" },
    ]);
  });

  it("leaves out a view whose file a view or update deletes, and refuses a screen whose own file it deletes", async () => {
    const app = await readApp(await appIn(SWIFT_APP));
    const id = "swiftui:App/CartScreen.swift#CartScreen";
    const view = await app.withChanges({ "App/CartRow.swift": null });
    expect(view.filesFor(id).map((f) => f.file)).not.toContain("App/CartRow.swift");
    await app.update("App/CartScreen.swift", null);
    expect(() => app.filesFor(id)).toThrow(/No screen/);
  });

  it("doesn't take a type named just State for what `@State` holds", async () => {
    const files = await related(
      {
        "App/Home.swift": swift(
          "struct Home: View { @State var on = false; var body: some View { Text(t) } }",
        ),
        "App/Feature.swift": swift("enum Feature { struct State {} }"),
      },
      "swiftui:App/Home.swift#Home",
    );
    expect(files.map((f) => f.file)).toEqual(["App/Home.swift"]);
  });

  it("follows a path alias with a name of its own to the project's file", async () => {
    const files = await related(
      {
        ...RN_APP,
        "src/hooks/useCart.ts": "export function useCart() { return { items: [] }; }",
        "src/CartScreen.tsx": tsx(
          'import { useCart } from "@hooks/useCart";',
          "export function CartScreen() { const cart = useCart(); return <View />; }",
        ),
      },
      "react-native:src/CartScreen.tsx#CartScreen",
    );
    expect(files.map((f) => f.file)).toEqual(["src/CartScreen.tsx", "src/hooks/useCart.ts"]);
  });

  it("lists the file naming a text style as well as the one writing its values", async () => {
    const files = await related(
      {
        "app/src/main/java/a/Home.kt": kotlin(
          "@Composable fun Home() { Text(t, style = MaterialTheme.typography.bodyLarge) }",
        ),
        "app/src/main/java/a/Base.kt": kotlin(
          "val Base = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.Bold)",
        ),
        "app/src/main/java/a/Type.kt": kotlin("val AppType = Typography(bodyLarge = Base.copy())"),
      },
      "compose:app/src/main/java/a/Home.kt#Home",
    );
    expect(files.map((f) => f.file)).toEqual([
      "app/src/main/java/a/Home.kt",
      "app/src/main/java/a/Base.kt",
      "app/src/main/java/a/Type.kt",
    ]);
  });

  describe("a file a view adds, which the screen places", () => {
    it("lists a SwiftUI view in it, and the tokens its code uses", async () => {
      const app = await readApp(await appIn(SWIFT_APP));
      const view = await app.withChanges({
        "App/CartScreen.swift": SWIFT_APP["App/CartScreen.swift"].replace(
          "CartRow(title: t)",
          "BenefitTile()",
        ),
        "App/BenefitTile.swift": swift(
          "struct BenefitTile: View { var body: some View { Text(t).foregroundStyle(Color.brand) } }",
        ),
      });
      expect(view.filesFor("swiftui:App/CartScreen.swift#CartScreen")).toEqual([
        { file: "App/CartScreen.swift", why: "declaration" },
        { file: "App/BenefitTile.swift", why: "child-view" },
        { file: "App/CartModel.swift", why: "view-model" },
        { file: "App/Theme.swift", why: "tokens" },
      ]);
    });

    it("lists a composable in it", async () => {
      const screen = "app/src/main/java/a/cart/CartScreen.kt";
      const app = await readApp(await appIn(COMPOSE_APP));
      const view = await app.withChanges({
        [screen]: COMPOSE_APP[screen].replace("CartRow(title = t)", "BenefitTile()"),
        "app/src/main/java/a/cart/BenefitTile.kt": kotlin(
          "@Composable fun BenefitTile() { Text(t, color = Brand) }",
        ),
      });
      expect(view.filesFor(`compose:${screen}#CartScreen`).map((f) => [f.file, f.why])).toEqual([
        [screen, "declaration"],
        ["app/src/main/java/a/cart/BenefitTile.kt", "child-view"],
        ["app/src/main/java/a/cart/CartViewModel.kt", "view-model"],
        ["app/src/main/java/a/ui/theme/Color.kt", "tokens"],
      ]);
    });

    it("lists a React Native component in it, imported under its own name or another", async () => {
      const app = await readApp(await appIn(RN_APP));
      const tile = tsx(
        'import { colors } from "./theme";',
        "export const BenefitTile = () => <Text style={{ color: colors.primary }}>{t}</Text>;",
      );
      const screen = (name: string, imported: string) =>
        tsx(
          `import { ${imported} } from "./BenefitTile";`,
          `export function CartScreen() { return <View><${name} /></View>; }`,
        );
      const own = await app.withChanges({
        "src/BenefitTile.tsx": tile,
        "src/CartScreen.tsx": screen("BenefitTile", "BenefitTile"),
      });
      expect(own.filesFor("react-native:src/CartScreen.tsx#CartScreen")).toEqual([
        { file: "src/CartScreen.tsx", why: "declaration" },
        { file: "src/BenefitTile.tsx", why: "child-view" },
        { file: "src/theme.ts", why: "tokens" },
      ]);
      const aliased = await app.withChanges({
        "src/BenefitTile.tsx": tile,
        "src/CartScreen.tsx": screen("Tile", "BenefitTile as Tile"),
      });
      expect(aliased.filesFor("react-native:src/CartScreen.tsx#CartScreen")).toEqual([
        { file: "src/CartScreen.tsx", why: "declaration" },
        { file: "src/BenefitTile.tsx", why: "import" },
      ]);
    });

    it("lists it after an update too, and stops once a view takes the placement out", async () => {
      const app = await readApp(await appIn(SWIFT_APP));
      const id = "swiftui:App/CartScreen.swift#CartScreen";
      await app.update(
        "App/BenefitTile.swift",
        swift("struct BenefitTile: View { var body: some View { Text(t) } }"),
      );
      await app.update(
        "App/CartScreen.swift",
        SWIFT_APP["App/CartScreen.swift"].replace("CartRow(title: t)", "BenefitTile()"),
      );
      expect(app.filesFor(id).map((f) => f.file)).toContain("App/BenefitTile.swift");
      const view = await app.withChanges({ "App/CartScreen.swift": SWIFT_APP["App/CartScreen.swift"] });
      expect(view.filesFor(id).map((f) => f.file)).not.toContain("App/BenefitTile.swift");
    });

    it("follows neither a type that isn't a view, nor a view a change renames, by the scan's name", async () => {
      const app = await readApp(await appIn(SWIFT_APP));
      const view = await app.withChanges({
        "App/CartScreen.swift": SWIFT_APP["App/CartScreen.swift"].replace(
          "CartRow(title: t)",
          "CartRow(title: Benefit().t)",
        ),
        "App/Benefit.swift": swift("struct Benefit { let t = 1 }"),
        "App/CartRow.swift": SWIFT_APP["App/CartRow.swift"].replace("struct CartRow", "struct CartLine"),
      });
      expect(view.filesFor("swiftui:App/CartScreen.swift#CartScreen").map((f) => f.file)).toEqual([
        "App/CartScreen.swift",
        "App/CartModel.swift",
      ]);
    });
  });
});
