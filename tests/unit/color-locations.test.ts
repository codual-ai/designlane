import { describe, expect, it } from "vitest";
import type { ColorToken } from "../../src/scan/types.js";
import { kotlin, RN_MANIFEST, swift, tsx } from "../helpers/catalog.js";
import { scanned } from "../helpers/locations.js";

const byReference = (colors: ColorToken[], reference: string) => {
  const found = colors.find((c) => c.reference === reference);
  if (!found) throw new Error(`no ${reference}: ${colors.map((c) => c.reference).join(", ")}`);
  return found;
};

const colorset = (...entries: { components: Record<string, string>; dark?: boolean }[]) =>
  JSON.stringify(
    {
      colors: entries.map(({ components, dark }) => ({
        color: { "color-space": "srgb", components },
        idiom: "universal",
        ...(dark ? { appearances: [{ appearance: "luminosity", value: "dark" }] } : {}),
      })),
    },
    null,
    2,
  );

describe("where a SwiftUI app's colours are written", () => {
  it("records a colour declared in code as its whole call", async () => {
    const { tokens, written } = await scanned({
      "App/Theme.swift": swift(
        "enum Theme {",
        "  static let brand = Color(red: 0.2, green: 0.4,",
        "    blue: 0.9)",
        "  static let ink: Color = .init(hex: 0x112233)",
        "}",
      ),
    });
    const { colors } = tokens("swiftui");
    expect(written(byReference(colors, "Theme.brand").locations?.light)).toEqual([
      "Color(red: 0.2, green: 0.4,\n    blue: 0.9)",
    ]);
    expect(written(byReference(colors, "Theme.ink").locations?.light)).toEqual([".init(hex: 0x112233)"]);
  });

  it("records an asset's light and dark components, each where it's written", async () => {
    const red = { red: "1.000", green: "0.000", blue: "0.000", alpha: "1.000" };
    const blue = { red: "0x00", green: "0x00", blue: "0xFF", alpha: "1.000" };
    const rel = "App/Assets.xcassets/Brand.colorset/Contents.json";
    const { tokens, written } = await scanned({
      [rel]: colorset({ components: red }, { components: blue, dark: true }),
      "App/Home.swift": swift('let x = Color("Brand")'),
    });
    const { locations } = byReference(tokens("swiftui").colors, 'Color("Brand")');
    expect(written(locations?.light)?.map((text) => JSON.parse(text ?? ""))).toEqual([red]);
    expect(written(locations?.dark)?.map((text) => JSON.parse(text ?? ""))).toEqual([blue]);
  });

  it("records no dark place for an asset with one value for both", async () => {
    const rel = "App/Assets.xcassets/Brand.colorset/Contents.json";
    const { tokens } = await scanned({
      [rel]: colorset({ components: { red: "1.000", green: "0.000", blue: "0.000" } }),
      "App/Home.swift": swift('let x = Color("Brand")'),
    });
    const { locations } = byReference(tokens("swiftui").colors, 'Color("Brand")');
    expect(locations?.light?.line).toBe(6);
    expect(locations?.dark).toBeUndefined();
  });

  it("records no place when the colour set holds components it can't tell apart", async () => {
    const rel = "App/Assets.xcassets/Brand.colorset/Contents.json";
    const set = JSON.parse(colorset({ components: { red: "1.000", green: "0.000", blue: "0.000" } }));
    const { tokens } = await scanned({
      [rel]: JSON.stringify({ info: { components: {} }, ...set }),
      "App/Home.swift": swift('let x = Color("Brand")'),
    });
    expect(byReference(tokens("swiftui").colors, 'Color("Brand")').locations).toBeUndefined();
  });

  it("records a theme's light value in its light type and its dark one in its dark type", async () => {
    const { tokens, written } = await scanned({
      "App/Themes.swift": swift(
        "protocol ColorSet { var tint: Color { get } }",
        "struct DesertLight: ColorSet { var tint: Color = Color(hex: 0xAA3300) }",
        "struct DesertDark: ColorSet { var tint: Color = .white }",
      ),
    });
    const { locations } = byReference(tokens("swiftui").colors, "ColorSet.tint");
    expect(written(locations?.light)).toEqual(["Color(hex: 0xAA3300)"]);
    expect(written(locations?.dark)).toEqual([".white"]);
  });
});

describe("where a Compose app's colours are written", () => {
  it("records a constant's value, and a scheme's roles through the constants they name", async () => {
    const { tokens, written } = await scanned({
      "app/src/main/res/values/colors.xml": '<resources><color name="accent">#3366CC</color></resources>',
      "app/src/main/java/Color.kt": kotlin(
        "val Purple40 = Color(0xFF6650A4)",
        "val Purple80 = Color(0xFFD0BCFF)",
        "private val Light = lightColorScheme(primary = Purple40, secondary = Color.White, tertiary = colorResource(R.color.accent))",
        "private val Dark = darkColorScheme(primary = Purple80)",
        "@Composable fun T() { MaterialTheme.colorScheme.primary; Purple40 }",
      ),
    });
    const { colors } = tokens("compose");
    expect(written(byReference(colors, "Purple40").locations?.light)).toEqual(["Color(0xFF6650A4)"]);
    const primary = byReference(colors, "MaterialTheme.colorScheme.primary").locations;
    expect(written(primary?.light)).toEqual(["Purple40", "Color(0xFF6650A4)"]);
    expect(written(primary?.dark)).toEqual(["Purple80", "Color(0xFFD0BCFF)"]);
    const secondary = byReference(colors, "MaterialTheme.colorScheme.secondary").locations;
    expect(written(secondary?.light)).toEqual(["Color.White"]);
    const tertiary = byReference(colors, "MaterialTheme.colorScheme.tertiary").locations;
    expect(written(tertiary?.light)).toEqual(["colorResource(R.color.accent)", "#3366CC"]);
  });

  it("follows an app's colour class through an object's constant", async () => {
    const { tokens, written } = await scanned({
      "app/src/main/java/Theme.kt": kotlin(
        "object Palette { val Yellow500 = Color(0xFFFFCC33) }",
        "class AppColors(val highlight: Color, val text: Color, val back: Color)",
        "val LightColors = AppColors(highlight = Palette.Yellow500, text = Color(0xFF000000), back = Color(0xFFFFFFFF))",
        "val DarkColors = AppColors(highlight = Color(0xFF332200), text = Color(0xFFFFFFFF), back = Color(0xFF000000))",
        "@Composable fun S() { AppTheme.colors.highlight }",
      ),
    });
    const highlight = byReference(tokens("compose").colors, "AppTheme.colors.highlight").locations;
    expect(written(highlight?.light)).toEqual(["Palette.Yellow500", "Color(0xFFFFCC33)"]);
    expect(written(highlight?.dark)).toEqual(["Color(0xFF332200)"]);
  });

  it("records no place for a colour worked out from another", async () => {
    const { tokens } = await scanned({
      "app/src/main/java/Color.kt": kotlin(
        "val Brand = Color(0xFF6650A4)",
        "val Faded = Brand.copy(alpha = 0.5f)",
        "@Composable fun T() { Faded }",
      ),
    });
    expect(byReference(tokens("compose").colors, "Faded").locations).toBeUndefined();
  });

  it("records a resource's value in values and in values-night, through each link to it", async () => {
    const values = "app/src/main/res/values/colors.xml";
    const night = "app/src/main/res/values-night/colors.xml";
    const { tokens, written } = await scanned({
      [values]: [
        "<resources>",
        '  <color name="blue600">#3366CC</color>',
        '  <color name="accent">@color/blue600</color>',
        '  <color name="plain"> #FFFFFF </color>',
        "</resources>",
      ].join("\n"),
      [night]: '<resources>\n  <color name="accent">#99BBFF</color>\n</resources>',
      "app/src/main/java/A.kt": kotlin("@Composable fun A() { colorResource(R.color.accent) }"),
    });
    const { colors } = tokens("compose");
    const accent = byReference(colors, "R.color.accent").locations;
    expect(written(accent?.light)).toEqual(["@color/blue600", "#3366CC"]);
    expect(accent?.light?.via?.[0]?.file).toBe(values);
    expect(written(accent?.dark)).toEqual(["#99BBFF"]);
    expect(accent?.dark?.file).toBe(night);
    expect(written(byReference(colors, "R.color.plain").locations?.light)).toEqual(["#FFFFFF"]);
    expect(byReference(colors, "R.color.plain").locations?.dark).toBeUndefined();
  });
});

describe("where a React Native app's colours are written", () => {
  it("records a theme's light and dark values, following an alias to the palette", async () => {
    const { tokens, written } = await scanned({
      ...RN_MANIFEST,
      "src/colors.ts": [
        'export const colors = { blue0: "#BFE1FF", gray1: "#F3F3F8" };',
        'export const accent = "#FF0000" as const;',
        "export const themes = {",
        '  light: { link: colors.blue0, surface: "#FFFFFF" },',
        '  dark: { link: "#1083FE", surface: "#000000" },',
        "};",
      ].join("\n"),
      "src/Home.tsx": tsx("export const H = ({ theme }) => <Text style={{ color: theme.link }} />;"),
    });
    const { colors } = tokens("react-native");
    const link = byReference(colors, "themes.light.link").locations;
    expect(written(link?.light)).toEqual(["colors.blue0", "#BFE1FF"]);
    expect(written(link?.dark)).toEqual(["#1083FE"]);
    expect(written(byReference(colors, "colors.gray1").locations?.light)).toEqual(["#F3F3F8"]);
    expect(written(byReference(colors, "accent").locations?.light)).toEqual(["#FF0000"]);
  });

  it("records a Tailwind config's colour and a CSS theme's, light and dark", async () => {
    const { tokens, written } = await scanned({
      ...RN_MANIFEST,
      "tailwind.config.js":
        'module.exports = { theme: { extend: { colors: { brand: { 500: "#3366E6" } } } } };',
      "src/global.css": [
        "@theme {",
        "  --color-muted:   #777777 ;",
        "}",
        "@media (prefers-color-scheme: dark) {",
        "  :root { --color-muted: #999999; }",
        "}",
      ].join("\n"),
      "src/Home.tsx": tsx('export const H = () => <Text className="text-brand-500 bg-muted" />;'),
    });
    const { colors } = tokens("react-native");
    expect(written(byReference(colors, "brand-500").locations?.light)).toEqual(["#3366E6"]);
    const muted = byReference(colors, "muted").locations;
    expect(written(muted?.light)).toEqual(["#777777"]);
    expect(written(muted?.dark)).toEqual(["#999999"]);
  });
});

describe("the app's own copy of a colour", () => {
  it("keeps a SwiftUI colour declared in the app over a watch app's copy", async () => {
    const watch = swift("extension Color { static let brand = Color(red: 0, green: 0.6, blue: 0.78) }");
    const own = swift("extension Color { static let brand = Color(red: 0, green: 0.6, blue: 0.78) }");
    const { tokens } = await scanned({ "AWatchApp/Color.swift": watch, "Shared/Color.swift": own });
    const brand = byReference(tokens("swiftui").colors, "Color.brand");
    expect(brand.source).toBe("Shared/Color.swift");
    expect(brand.locations?.light?.file).toBe("Shared/Color.swift");
  });

  it("keeps an app's asset over a widget extension's of the same name", async () => {
    const components = { red: "1.000", green: "1.000", blue: "1.000" };
    const { tokens } = await scanned({
      "AWidgetsExtension/Assets.xcassets/Back.colorset/Contents.json": colorset({ components }),
      "Main/Assets.xcassets/Back.colorset/Contents.json": colorset({ components }),
      "Main/Home.swift": swift('let x = Color("Back")'),
    });
    const back = byReference(tokens("swiftui").colors, 'Color("Back")');
    expect(back.locations?.light?.file).toBe("Main/Assets.xcassets/Back.colorset/Contents.json");
  });

  it("keeps a React Native colour in the app over a widget's copy", async () => {
    const palette = 'export const colors = { brand: "#3366E6" };';
    const { tokens } = await scanned({
      ...RN_MANIFEST,
      "AWidget/colors.ts": palette,
      "src/colors.ts": palette,
      "src/Home.tsx": tsx("export const H = () => <Text style={{ color: colors.brand }} />;"),
    });
    expect(byReference(tokens("react-native").colors, "colors.brand").source).toBe("src/colors.ts");
  });

  it("keeps an app's CSS theme colour over a widget's", async () => {
    const css = (hex: string) => `@theme {\n  --color-brand: ${hex};\n}`;
    const { tokens } = await scanned({
      ...RN_MANIFEST,
      "AWidget/global.css": css("#111111"),
      "src/global.css": css("#222222"),
      "src/Home.tsx": tsx('export const H = () => <Text className="text-brand" />;'),
    });
    const brand = byReference(tokens("react-native").colors, "brand");
    expect(brand).toMatchObject({ light: "#222222", locations: { light: { file: "src/global.css" } } });
  });

  it("keeps an Android app's resource over a Wear module's", async () => {
    const resource = (hex: string) => `<resources><color name="brand">${hex}</color></resources>`;
    const { tokens } = await scanned({
      "automotive/src/main/res/values/colors.xml": resource("#111111"),
      "phone/src/main/res/values/colors.xml": resource("#222222"),
      "phone/src/main/java/A.kt": kotlin("@Composable fun A() { colorResource(R.color.brand) }"),
    });
    const brand = byReference(tokens("compose").colors, "R.color.brand");
    expect(brand).toMatchObject({ light: "#222222", source: "phone/src/main/res/values/colors.xml" });
  });
});

describe("what a colour's span holds", () => {
  it("reads a resource past one commented out before it", async () => {
    const { tokens, written } = await scanned({
      "app/src/main/res/values/colors.xml": [
        "<resources>",
        '  <!-- <color name="accent">#000000</color> -->',
        '  <color name="accent">#3366CC</color>',
        "</resources>",
      ].join("\n"),
      "app/src/main/java/A.kt": kotlin("@Composable fun A() { colorResource(R.color.accent) }"),
    });
    const accent = byReference(tokens("compose").colors, "R.color.accent");
    expect(accent.light).toBe("#3366cc");
    expect(written(accent.locations?.light)).toEqual(["#3366CC"]);
    expect(accent.locations?.light?.line).toBe(3);
  });

  it("marks each span as a literal's text, a whole expression, or an asset's components", async () => {
    const rel = "Shop/Assets.xcassets/Brand.colorset/Contents.json";
    const { tokens } = await scanned({
      [rel]: colorset({ components: { red: "1.000", green: "0.000", blue: "0.000" } }),
      "Shop/Theme.swift": swift(
        "enum Theme { static let ink = Color(red: 0.2, green: 0.4, blue: 0.9) }",
        'let x = Color("Brand")',
      ),
      "app/src/main/res/values/colors.xml": '<resources><color name="accent">#3366CC</color></resources>',
      "app/src/main/java/Color.kt": kotlin(
        "val Purple40 = Color(0xFF6650A4)",
        "@Composable fun T() { Purple40; colorResource(R.color.accent) }",
      ),
      ...RN_MANIFEST,
      "src/colors.ts": 'export const colors = { brand: "#3366E6" };',
      "src/Home.tsx": tsx("export const H = () => <Text style={{ color: colors.brand }} />;"),
    });
    const kind = (framework: "swiftui" | "compose" | "react-native", reference: string) =>
      byReference(tokens(framework).colors, reference).locations?.light?.kind;
    expect(kind("swiftui", "Theme.ink")).toBe("expression");
    expect(kind("swiftui", 'Color("Brand")')).toBe("components");
    expect(kind("compose", "Purple40")).toBe("expression");
    expect(kind("compose", "R.color.accent")).toBe("literal");
    expect(kind("react-native", "colors.brand")).toBe("literal");
  });

  it("counts offsets in UTF-16 code units of the file's text, a byte order mark included", async () => {
    const bom = "﻿";
    const { tokens, written } = await scanned({
      "Shop/Theme.swift": `${bom}import SwiftUI\n// Café 🎨\nenum Theme { static let ink = Color(hex: 0x112233) }`,
      "app/src/main/res/values/colors.xml": `${bom}<resources><!-- é 🎨 --><color name="accent">#3366CC</color></resources>`,
      "app/src/main/java/A.kt": kotlin("@Composable fun A() { colorResource(R.color.accent) }"),
      ...RN_MANIFEST,
      "src/colors.ts": `${bom}// Café 🎨\nexport const colors = { brand: "#3366E6" };`,
      "src/global.css": `${bom}/* é 🎨 */\n@theme { --color-muted: #777777; }`,
      "src/Home.tsx": tsx(
        'export const H = () => <Text className="bg-muted" style={{ color: colors.brand }} />;',
      ),
    });
    expect(written(byReference(tokens("swiftui").colors, "Theme.ink").locations?.light)).toEqual([
      "Color(hex: 0x112233)",
    ]);
    expect(written(byReference(tokens("compose").colors, "R.color.accent").locations?.light)).toEqual([
      "#3366CC",
    ]);
    const rn = tokens("react-native").colors;
    expect(written(byReference(rn, "colors.brand").locations?.light)).toEqual(["#3366E6"]);
    expect(written(byReference(rn, "muted").locations?.light)).toEqual(["#777777"]);
  });
});
