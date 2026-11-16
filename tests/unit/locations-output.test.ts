import { describe, expect, it } from "vitest";
import { keyedColors } from "../../src/output/token-names.js";
import { toDesignTokens } from "../../src/output/tokens-json.js";
import { appFirst, isOtherTarget } from "../../src/scan/targets.js";
import type { ColorToken, ScanResult, TypeStyle } from "../../src/scan/types.js";
import { readTokensFile } from "../../src/sync/tokens-file.js";
import { kotlin } from "../helpers/catalog.js";
import { scanned } from "../helpers/locations.js";

const span = (line: number, start: number, end: number) => ({ file: "Theme.swift", line, start, end });
const value = (line: number, start: number, end: number) => ({
  ...span(line, start, end),
  kind: "expression" as const,
});

function scanWith(colors: ColorToken[], typeStyles: TypeStyle[] = []): ScanResult {
  const tokens = { colors, systemColors: [], typeStyles, fonts: [], spacing: [], radii: [] };
  const framework = { framework: "swiftui" as const, platforms: ["ios" as const], screens: [], tokens };
  return { root: "/apps/Shop", frameworks: [framework], filesScanned: 1, truncated: false, unreadable: [] };
}

const brand: ColorToken = {
  name: "brand",
  light: "#3366e6",
  dark: "#99bbff",
  source: "Theme.swift",
  reference: "Theme.brand",
  kind: "code",
  uses: 1,
  locations: { light: { ...value(3, 40, 61), via: [span(2, 10, 20)] }, dark: value(4, 70, 91) },
};

describe("locations in tokens.json", () => {
  it("writes where each colour's light and dark values are written, and reads them back", () => {
    const file = JSON.parse(JSON.stringify(toDesignTokens(scanWith([brand]))));
    expect(file.color.brand.$extensions.designlane.locations).toEqual(brand.locations);
    expect(readTokensFile(file).colors[0]?.reference).toBe("Theme.brand");
  });

  it("writes a text style's places only for the values its group holds", () => {
    const style: TypeStyle = {
      name: "heading",
      kind: "app",
      family: "System",
      size: 22,
      weight: "computed",
      reference: "Font.heading",
      uses: 1,
      locations: { fontSize: value(5, 100, 102), fontWeight: value(5, 110, 120) },
    };
    const file = JSON.parse(JSON.stringify(toDesignTokens(scanWith([], [style]))));
    expect(file.typography.heading.$extensions.designlane.locations).toEqual({
      fontSize: value(5, 100, 102),
    });
  });

  it("refuses a location that ends before it starts, or says more than a place", () => {
    const withLight = (light: object) => {
      const file = JSON.parse(JSON.stringify(toDesignTokens(scanWith([brand]))));
      file.color.brand.$extensions.designlane.locations = { light };
      return file;
    };
    expect(() => readTokensFile(withLight(value(3, 61, 40)))).toThrow(/ends before it starts/);
    expect(() => readTokensFile(withLight({ ...value(3, 40, 61), column: 4 }))).toThrow();
    expect(() => readTokensFile(withLight(span(3, 40, 61)))).toThrow();
    expect(() => readTokensFile(withLight({ ...span(3, 40, 61), kind: "quoted" }))).toThrow();
    expect(() => readTokensFile(withLight(value(3, 40, 61)))).not.toThrow();
  });
});

describe("the app's own target", () => {
  it.each([
    ["Sources/WatchWidgets/Color+Hex.swift", true],
    ["ShopWidgetsExtension/Assets.xcassets/Back.colorset/Contents.json", true],
    ["Shop WatchKit Extension/Theme.swift", true],
    ["Shop Watch App/Theme.swift", true],
    ["ShopIntents/Theme.swift", true],
    ["ShopNotificationContent/Theme.swift", true],
    ["Shop.appex/Theme.swift", true],
    ["ShareExtension/Colors.swift", true],
    ["wear/src/main/res/values/colors.xml", true],
    ["app-tv/src/main/java/Theme.kt", true],
    ["App/Preview Content/Assets.xcassets/A.colorset/Contents.json", true],
    ["Features/TVShows/Theme.swift", false],
    ["Features/LinkPreview/Theme.swift", false],
    ["App/ColorExtension/Color+Brand.swift", false],
    ["App/AppIntents/Theme.swift", false],
    ["WatchParty/Theme.swift", false],
    ["src/widgets/theme.ts", false],
    ["app/src/main/java/com/shop/watch/Theme.kt", false],
    ["app/src/main/java/com/shop/intents/Theme.kt", false],
    ["App/Extensions/Color+Brand.swift", false],
    ["App/Extension/Color+Brand.swift", false],
    ["App/Watchlist/Colors.swift", false],
    ["App/Widgetry.swift", false],
    ["watch.swift", false],
  ])("tells %s apart: %s", (rel, other) => {
    expect(isOtherTarget(rel)).toBe(other);
  });

  it("puts the app's own files first, keeping the order of each", () => {
    const files = ["Watch/A.swift", "App/B.swift", "Widgets/C.swift", "App/D.swift"];
    expect(appFirst(files, (f) => f)).toEqual([
      "App/B.swift",
      "App/D.swift",
      "Watch/A.swift",
      "Widgets/C.swift",
    ]);
  });

  it("gives the app's own copy of a colour the plain key, however its files sort", () => {
    const copy = (source: string, light: string): ColorToken => ({ ...brand, source, light });
    const keyed = keyedColors([
      copy("AWatchApp/Theme.swift", "#111111"),
      copy("Shared/Theme.swift", "#222222"),
    ]);
    expect(keyed.find((k) => k.key === "Theme-brand")?.color.source).toBe("Shared/Theme.swift");
  });

  it("keeps the app's own Compose text style over a Wear module's of the same name", async () => {
    const style = (size: number) =>
      kotlin(`val Heading = TextStyle(fontSize = ${size}.sp)`, "@Composable fun S() { Heading }");
    const { tokens } = await scanned({
      "automotive/src/main/java/Type.kt": style(18),
      "phone/src/main/java/Type.kt": style(24),
    });
    const heading = tokens("compose").typeStyles.find((s) => s.reference === "Heading");
    expect(heading).toMatchObject({
      size: 24,
      locations: { fontSize: { file: "phone/src/main/java/Type.kt" } },
    });
  });
});
