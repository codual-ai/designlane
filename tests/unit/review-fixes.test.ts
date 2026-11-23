import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ComponentInfo } from "../../src/catalog/components.js";
import { findDrift } from "../../src/drift/drift.js";
import { duplicates } from "../../src/drift/duplicates.js";
import { problemWith, savePreview } from "../../src/previews/previews.js";
import { catalogOf, kotlin, named, RN_MANIFEST, swift, tsx } from "../helpers/catalog.js";
import { speedIt } from "../helpers/speed.js";
import { tempDir } from "../helpers/temp.js";

describe("previews a browser could still run or fetch", () => {
  it.each([
    ["<svg/onload=alert(1)>", "scripts"],
    ['<img src=x"onerror=alert(1)>', "scripts"],
    ['<img src="&#104;ttps://example.com/a.png">', "references"],
    ['<a href="javascript&colon;x()">a</a>', "references"],
  ])("refuses %s", (html, reason) => {
    expect(problemWith(html)).toContain(reason);
  });

  it("saves each picture with a policy that runs and fetches nothing, so opening the file alone is safe", async () => {
    const { components } = await catalogOf({
      "App/Row.swift": swift("struct Row: View { var body: some View { Text(t) } }"),
    });
    const file = await savePreview(await tempDir(), named(components, "Row"), "<b>a</b>");
    const lines = (await readFile(file, "utf8")).split("\n");
    expect(lines[1]).toBe(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">`,
    );
  });
});

describe("drift reads whole values", () => {
  const home = (...lines: string[]) =>
    swift(
      "struct Home: View { var body: some View { NavigationStack { VStack {",
      ...lines,
      "}.navigationTitle(t) } } }",
    );

  it("keeps a colour's opacity and reads each channel's own `/ 255`", async () => {
    const { scan, sources, components } = await catalogOf({
      "App/Theme.swift": swift('enum Theme { static let brand = Color(hex: "#3366E6") }'),
      "App/Home.swift": home(
        "  Text(a).foregroundStyle(Color(red: 0.2, green: 0.4, blue: 0.9, opacity: 0.5))",
        "  Text(b).foregroundStyle(Color(red: 0.2, green: 102 / 255, blue: 0.9))",
        "  Text(c).foregroundStyle(Color(red: 0.2 * k, green: 0.4, blue: 0.9))",
      ),
    });
    const colors = findDrift(scan, sources, components).colors;
    expect(colors.map((c) => [c.value, c.token?.key])).toEqual([
      ["#3366e6", "brand"],
      ["#3366e680", undefined],
    ]);
  });

  it("doesn't read the start of an expression as a spacing value", async () => {
    const { scan, sources, components } = await catalogOf({
      "App/Home.swift": home("  Text(t).padding(12).padding(12).padding(12)", "  Text(t).padding(13 * 2)"),
    });
    expect(findDrift(scan, sources, components).scale).toEqual([]);
  });
});

describe("token uses through modifiers and JSX text", () => {
  it("finds a colour the code changes with a modifier", async () => {
    const { components } = await catalogOf({
      "App/Theme.swift": swift("enum Theme { static let brand = Color(red: 0.2, green: 0.4, blue: 0.9) }"),
      "App/Row.swift": swift(
        "struct Row: View { var body: some View { Text(t).foregroundStyle(Theme.brand.opacity(0.5)) } }",
      ),
    });
    expect(named(components, "Row").colors).toEqual(["brand"]);
  });

  it("reads past an apostrophe in JSX text", async () => {
    const { scan, sources, components } = await catalogOf({
      ...RN_MANIFEST,
      "src/theme.ts": 'export const colors = { primary: "#3366ff" };',
      "src/Note.tsx": tsx(
        'import { colors } from "./theme";',
        "export function Note() { return <View><Text>Don't worry</Text><View style={{ backgroundColor: colors.primary, borderColor: '#123456' }} /></View>; }",
      ),
    });
    expect(named(components, "Note").colors).toEqual(["primary", "hex-123456"]);
    expect(findDrift(scan, sources, components).colors.map((c) => c.value)).toEqual(["#123456"]);
  });
});

describe("Compose previews", () => {
  it("doesn't take the composable after an expression-bodied preview for one", async () => {
    const { components } = await catalogOf({
      "app/src/main/java/a/Chip.kt": kotlin(
        "@Preview",
        "@Composable",
        "fun ChipPreview() = Chip(label = 1)",
        "@Composable",
        "fun Chip(label: Int) { Text(label) }",
      ),
      "app/src/main/java/a/Home.kt": kotlin("@Composable fun Home() { Scaffold { Chip(label = 1) } }"),
    });
    expect(named(components, "Chip").params).toEqual(["label: Int"]);
  });

  speedIt(
    "finds where each function's annotations start in one pass, however deep functions nest",
    async () => {
      const depth = 30_000;
      const nested = `${Array.from({ length: depth }, (_, i) => `fun F${i}() {`).join("\n")}\n${"}\n".repeat(depth)}`;
      const started = performance.now();
      await catalogOf({
        "app/src/main/java/a/Deep.kt": kotlin("@Composable fun Home() { Text(t) }", nested),
      });
      expect(performance.now() - started).toBeLessThan(1500);
    },
  );
});

describe("near-duplicate search on many components", () => {
  const unrelated = (i: number): ComponentInfo => ({
    id: `c${i}`,
    name: `View${i}`,
    framework: "swiftui",
    file: `App/V${i}.swift`,
    designSystem: false,
    line: 1,
    kind: "component",
    category: "other",
    uses: 1,
    usedIn: [],
    sharedUses: 0,
    params: [],
    colors: [],
    typeStyles: [],
    source: `${Array.from({ length: 40 }, (_, k) => `word${i}x${k}`).join(" ")} Text VStack padding body some View`,
  });

  speedIt("compares only components sharing a rare word", () => {
    const started = performance.now();
    expect(duplicates(Array.from({ length: 4000 }, (_, i) => unrelated(i)))).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it("pairs same-named copies as near-duplicates", () => {
    const copy = (i: number): ComponentInfo => ({
      ...unrelated(i),
      name: "PrimaryButton",
      source: unrelated(0).source,
    });
    expect(duplicates([copy(1), copy(2)]).map((p) => [p.first.file, p.second.file])).toEqual([
      ["App/V1.swift", "App/V2.swift"],
    ]);
  });
});

describe("drift outside the design system's own files and previews", () => {
  const card = (name: string) =>
    swift(`struct ${name}: View { var body: some View { Text(t).foregroundStyle(Color(hex: "#123456")) } }`);

  it("reads files whose names only start like a theme file's", async () => {
    const { scan, sources, components } = await catalogOf({
      "App/TypeBadge.swift": card("TypeBadge"),
      "App/ColorfulCard.swift": card("ColorfulCard"),
      "App/CardType.swift": card("CardType"),
      "App/AppColors.swift": card("AppColors"),
      "App/Color+Brand.swift": card("Brand"),
    });
    const files = findDrift(scan, sources, components).colors.flatMap((c) => c.uses.map((u) => u.file));
    expect(files.sort()).toEqual(["App/CardType.swift", "App/ColorfulCard.swift", "App/TypeBadge.swift"]);
  });

  it("leaves out Compose and SwiftUI previews", async () => {
    const compose = await catalogOf({
      "app/src/main/java/a/Home.kt": kotlin(
        "@Composable fun Home() { Scaffold { Text(t, color = Color(0x80112233)) } }",
        "@Preview @Composable fun HomePreview() { Text(t, color = Color(0xFF445566), modifier = Modifier.padding(13.dp)) }",
      ),
    });
    expect(findDrift(compose.scan, compose.sources, compose.components).colors.map((c) => c.value)).toEqual([
      "#11223380",
    ]);
    const swiftui = await catalogOf({
      "App/Home.swift": card("Home"),
      "App/HomePreviews.swift": swift(
        'struct Home_Previews: PreviewProvider { static var previews: some View { Home().background(Color(hex: "#abcdef")) } }',
      ),
    });
    expect(findDrift(swiftui.scan, swiftui.sources, swiftui.components).colors.map((c) => c.value)).toEqual([
      "#123456",
    ]);
    // A lowercase preview's annotation stays with it, not with the function after it.
    const lowercase = await catalogOf({
      "app/src/main/java/a/Home.kt": kotlin(
        "@Preview @Composable fun homePreview() = Home()",
        "@Composable fun Home() { Scaffold { Text(t, color = Color(0xFF112233)) } }",
      ),
    });
    expect(
      findDrift(lowercase.scan, lowercase.sources, lowercase.components).colors.map((c) => c.value),
    ).toEqual(["#112233"]);
  });
});

describe("blanking ranges", () => {
  it("blanks each character once, however the ranges nest", async () => {
    const { blankRanges } = await import("../../src/frameworks/source-text.js");
    expect(
      blankRanges("ab\ncdef", [
        [1, 6],
        [0, 2],
        [3, 5],
      ]),
    ).toBe("  \n   f");
    const nested = Array.from({ length: 20_000 }, (_, i): [number, number] => [i, 200_000 - i]);
    const started = performance.now();
    blankRanges("x".repeat(200_000), nested);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});

describe("components sharing a name", () => {
  const button = swift("struct PrimaryButton: View { var body: some View { Text(t) } }");
  const screen = (name: string) =>
    swift(
      `struct ${name}: View { var body: some View { NavigationStack { PrimaryButton().navigationTitle(t) } } }`,
    );

  it("credits each use to the one declared nearest, and shares a use as near both", async () => {
    const { components } = await catalogOf({
      "Features/Cart/PrimaryButton.swift": button,
      "Features/Cart/CartScreen.swift": screen("CartScreen"),
      "Features/Cart/Checkout/PayScreen.swift": screen("PayScreen"),
      "Features/Shop/PrimaryButton.swift": button,
      "App/RootScreen.swift": screen("RootScreen"),
    });
    const [cart, shop] = ["Cart", "Shop"].map((folder) => {
      const found = components.find((c) => c.file === `Features/${folder}/PrimaryButton.swift`);
      return found && { uses: found.uses, usedIn: found.usedIn, sharedUses: found.sharedUses };
    });
    expect(cart).toEqual({
      uses: 2,
      usedIn: ["Features/Cart/CartScreen.swift", "Features/Cart/Checkout/PayScreen.swift"],
      sharedUses: 1,
    });
    expect(shop).toEqual({ uses: 0, usedIn: [], sharedUses: 1 });
  });
});
