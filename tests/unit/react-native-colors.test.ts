import { describe, expect, it } from "vitest";
import { colorOf } from "../../src/frameworks/css-color.js";
import { toDesignTokens } from "../../src/output/tokens-json.js";
import { scanRepo } from "../../src/scan/index.js";
import { scanNotes } from "../../src/scan/notes.js";
import type { ColorToken } from "../../src/scan/types.js";
import { speedIt } from "../helpers/speed.js";
import { tempDir } from "../helpers/temp.js";

const RN = 'import { View, Text, StyleSheet } from "react-native";\n';

/** A React Native app's manifest, which tells its folder apart from the rest of a repo. */
const MANIFEST = { "package.json": '{ "dependencies": { "react-native": "0.76.0" } }' };

async function app(files: Record<string, string>) {
  const scan = await scanRepo(await tempDir({ ...MANIFEST, ...files }));
  const rn = scan.frameworks.find((f) => f.framework === "react-native");
  const color = (name: string): ColorToken | undefined => rn?.tokens.colors.find((c) => c.name === name);
  /** Each other theme as `name: colour light/dark reference uses`, a colour to a line. */
  const themes = () =>
    (rn?.tokens.themes ?? []).flatMap((theme) =>
      theme.colors.map((c) => `${theme.name}: ${c.name} ${c.light}/${c.dark} ${c.reference} ${c.uses}`),
    );
  return { scan, rn, color, themes };
}

describe("React Native colours from theme objects", () => {
  it("names a theme object's colours, counts their uses, and pairs light and dark into one colour", async () => {
    const { color } = await app({
      "src/theme/colors.ts": [
        "export const themes = {",
        '  light: { surface: "#FFFFFF", text: "#1F2329", brand: "#3366E6" },',
        '  dark: { surface: "#262931", text: "#F2F3F5", brand: "#3366E6" },',
        "};",
      ].join("\n"),
      "src/Home.tsx": `${RN}export const Home = ({ theme }) => <View style={{ backgroundColor: theme.surface }}><Text style={{ color: theme.text }} /><Text style={{ color: theme.text }} /></View>;`,
    });
    expect(color("surface")).toMatchObject({ light: "#ffffff", dark: "#262931", uses: 1, kind: "code" });
    expect(color("text")).toMatchObject({ light: "#1f2329", dark: "#f2f3f5", uses: 2 });
    expect(color("text")?.reference).toBe("themes.light.text");
    expect(color("brand")?.dark).toBeUndefined();
  });

  it("follows aliases to a palette, and names a default export by its file and a scale's shades by the scale", async () => {
    const { color } = await app({
      "src/colors.ts": 'export default { green400: "#03D47C", charcoal: { 500: "#7D7D7D" } };',
      "src/theme.ts":
        'import colors from "./colors";\nexport const lightTheme = { success: colors.green400 };',
      "src/A.tsx": `${RN}export const A = () => <View style={{ backgroundColor: lightTheme.success, borderColor: colors.charcoal[500] }} />;`,
    });
    expect(color("success")).toMatchObject({ light: "#03d47c", reference: "lightTheme.success", uses: 1 });
    expect(color("charcoal-500")).toMatchObject({
      light: "#7d7d7d",
      reference: "colors.charcoal[500]",
      uses: 1,
    });
    expect(color("green400")?.reference).toBe("colors.green400");
  });

  it("reads module-level colour constants and their uses by name, and CommonJS exports", async () => {
    const { color } = await app({
      "src/constants.js": 'const backdrop = "rgba(0, 0, 0, 0.5)";\nmodule.exports = { accent: "#ff6c00" };',
      "src/B.js": `${RN}import { backdrop } from "./constants";\nexport const B = () => <View style={{ backgroundColor: backdrop }} />;`,
    });
    expect(color("backdrop")).toMatchObject({ light: "#00000080", uses: 1 });
    expect(color("accent")).toMatchObject({ light: "#ff6c00", reference: "constants.accent" });
  });

  it("takes colours written in styles as uses, not names, and CSS names in styles as the platform's", async () => {
    const { rn, color } = await app({
      "src/C.tsx": [
        RN,
        'const styles = StyleSheet.create({ card: { backgroundColor: "#FAFAFA" } });',
        'const plain = { card: { borderColor: "#fafafa" } };',
        'export const C = () => <View style={styles.card}><Text style={{ color: "white" }} /><Icon color="#FF0000" /></View>;',
      ].join("\n"),
    });
    expect(color("backgroundColor")).toBeUndefined();
    expect(color("#fafafa")).toMatchObject({ kind: "inline", uses: 2 });
    expect(color("#ff0000")).toMatchObject({ kind: "inline", uses: 1 });
    expect(rn?.tokens.systemColors).toEqual([{ name: "white", uses: 1 }]);
  });

  it("credits a colour reached through a theme, not a same-named property of something else", async () => {
    const { color } = await app({
      "src/palette.ts": 'export const palette = { text: "#111111" };',
      "src/D.tsx": `${RN}export const D = ({ post, theme }) => <Text style={[styles.text, { color: palette.text }]}>{post.text}{theme.colors.text}</Text>;`,
    });
    expect(color("text")?.uses).toBe(2);
  });

  it("keeps one light and one dark theme of several, and reads each other one as a theme of its own", async () => {
    const { color, themes } = await app({
      "src/themes.ts": [
        "export const THEMES = {",
        '  denim: { buttonBg: "#1c58d9" },',
        '  onyx: { buttonBg: "#4a7aff" },',
        "};",
        'export const themes = { light: { bg: "#fff" }, dark: { bg: "#000" }, black: { bg: "#000" } };',
      ].join("\n"),
      "src/E.tsx": `${RN}export const E = ({ theme }) => <View style={{ backgroundColor: theme.bg }} />;`,
    });
    expect(color("buttonBg")?.light).toBe("#1c58d9");
    expect(color("bg")).toMatchObject({ light: "#ffffff", dark: "#000000", uses: 1 });
    // A theme's colour is used wherever the default theme's in its place is: the code reaches the chosen theme alike.
    expect(themes()).toEqual([
      "onyx: buttonBg #4a7aff/undefined THEMES.onyx.buttonBg 0",
      "black: bg #000000/undefined themes.black.bg 1",
    ]);
  });

  it("leaves sibling roles that aren't themes alone", async () => {
    const { rn } = await app({
      "src/theme.ts":
        'export const theme = { palette: { primary: { text: "#fff" }, secondary: { text: "#000" } } };',
      "src/F.tsx": `${RN}export const F = () => <View />;`,
    });
    expect(rn?.tokens.colors.filter((c) => c.name === "text")).toHaveLength(2);
    expect(rn?.tokens.themes).toBeUndefined();
  });
});

describe("React Native colours from Tailwind", () => {
  it("reads a config's colours, also from a module it requires, and the class names using them", async () => {
    const { color } = await app({
      "tailwind.config.js": [
        'const colors = require("./src/ui/colors");',
        "module.exports = { theme: { colors, extend: { colors: { inatGreen: '#74AC00' } } } };",
      ].join("\n"),
      "src/ui/colors.js": "module.exports = { primary: { DEFAULT: '#FF6C00', 300: '#FFA766' } };",
      "src/G.tsx": `${RN}export const G = () => <View className="flex-1 bg-primary dark:bg-primary-300/50"><Text className={\`text-inatGreen \${x}\`} /></View>;`,
    });
    expect(color("primary")).toMatchObject({ light: "#ff6c00", reference: "primary", uses: 1 });
    expect(color("primary-300")?.uses).toBe(1);
    expect(color("inatGreen")?.uses).toBe(1);
  });

  it("reads a CSS @theme's colours with the values a dark block gives them, wherever that block is", async () => {
    const { color } = await app({
      "src/global.css": [
        "@media (prefers-color-scheme: dark) { @theme { --color-card: #171717; } }",
        "@theme { --color-card: #ffffff; --color-ring: #FF6C00; }",
      ].join("\n"),
      "src/H.tsx": `${RN}export const H = () => <View className="bg-card ring-ring" />;`,
    });
    expect(color("card")).toMatchObject({ light: "#ffffff", dark: "#171717", uses: 1 });
    expect(color("ring")?.dark).toBeUndefined();
  });
});

describe("a React Native app", () => {
  it("is read only when its code imports React Native, and its tokens say how the code names each colour", async () => {
    const web = await app({ "src/a.ts": 'export const theme = { brand: "#3366e6" };' });
    expect(web.rn).toBeUndefined();
    const { scan } = await app({
      "src/a.ts": 'export const theme = { brand: "#3366e6" };',
      "src/App.tsx": `${RN}export const App = () => <View style={{ backgroundColor: theme.brand }} />;`,
    });
    const tokens = toDesignTokens(scan);
    expect(tokens.$extensions?.designlane.platform).toBe("react-native");
    const brand = tokens.color?.brand;
    expect(typeof brand === "object" && brand.$extensions.designlane.reference).toBe("theme.brand");
  });

  it("reads only the React Native app's own folder", async () => {
    const { scan } = await app({
      "package.json": "{}",
      "apps/mobile/package.json": MANIFEST["package.json"],
      "apps/mobile/App.tsx": `${RN}export const App = () => <View style={{ backgroundColor: theme.brand }} />;`,
      "apps/mobile/theme.ts": 'export const theme = { brand: "#3366e6" };',
      "tools/site/theme.ts": 'export const theme = { web: "#ff0000" };',
    });
    expect(scan.frameworks[0]?.tokens.colors.map((c) => c.name)).toEqual(["brand"]);
  });

  it("reads the app, not its native side, and says so", async () => {
    const { scan } = await app({
      "src/App.tsx": `${RN}export const App = () => <View />;`,
      "ios/Widget/Widget.swift": 'import SwiftUI\nstruct Widget: View { var body: some View { Text("x") } }',
    });
    expect(scan.frameworks.map((f) => f.framework)).toEqual(["react-native"]);
    expect(scanNotes(scan).join(" ")).toContain("also has SwiftUI code, its native side");
  });

  speedIt(
    "reads thousands of files using a theme of thousands of colours quickly",
    async () => {
      const theme = Array.from(
        { length: 3000 },
        (_, i) => `c${i}: "#${(i * 4099).toString(16).padStart(6, "0").slice(0, 6)}"`,
      );
      const files: Record<string, string> = {
        "src/theme.ts": `export const themes = { light: { ${theme.join(", ")} }, dark: { ${theme.join(", ")} } };`,
      };
      for (let f = 0; f < 2000; f++)
        files[`src/s${f}.tsx`] =
          `${RN}export const S${f} = ({ theme }) => <View style={{ backgroundColor: theme.c${f}, color: "#123456" }} />;`;
      const started = performance.now();
      const { color } = await app(files);
      expect(color("c1")?.uses).toBe(1);
      expect(performance.now() - started).toBeLessThan(10_000);
      // Writing thousands of files is slow on Windows; the scan itself has the 10 seconds above.
    },
    30_000,
  );

  it("leaves alone a native app beside some React Native code that isn't an app, or outside the app's own folders", async () => {
    const swift =
      'import SwiftUI\nstruct Home: View { var body: some View { NavigationStack { List { Text("x") }.navigationTitle("Home") } } }';
    const demo = await scanRepo(
      await tempDir({
        "apps/ios/Home.swift": swift,
        "tools/demo/App.tsx": `${RN}export const A = () => <View />;`,
      }),
    );
    expect(demo.frameworks.map((f) => f.framework)).toEqual(["swiftui"]);
    const beside = await scanRepo(
      await tempDir({
        "apps/ios/Home.swift": swift,
        "apps/mobile/package.json": MANIFEST["package.json"],
        "apps/mobile/App.tsx": `${RN}export const A = () => <View />;`,
        "apps/mobile/ios/Widget.swift": swift,
      }),
    );
    expect(beside.frameworks.map((f) => f.framework)).toEqual(["swiftui", "react-native"]);
    expect(beside.nativeAlongside).toEqual(["swiftui"]);
  });
});

describe("React Native colours, read carefully", () => {
  const view = (body: string) => `${RN}export const V = ({ theme }) => ${body};`;

  it("follows an alias to the palette its own file imports, not a same-named one elsewhere", async () => {
    const { rn } = await app({
      "src/a/palette.ts": 'export const palette = { brand: "#ff0000" };',
      "src/b/palette.ts": 'export const palette = { brand: "#0000ff" };',
      "src/b/theme.ts":
        'import { palette } from "./palette";\nexport const lightTheme = { primary: palette.brand };',
      "src/c/theme.ts":
        'import appColors from "./colors";\nexport const lightTheme = { accent: appColors.brand };',
      "src/c/colors.ts": 'const colors = { brand: "#00ff00" };\nexport default colors;',
      "src/V.tsx": view("<View />"),
    });
    const light = (name: string) => rn?.tokens.colors.find((c) => c.name === name)?.light;
    expect([light("primary"), light("accent")]).toEqual(["#0000ff", "#00ff00"]);
    const own = await app({
      "src/a.ts": 'export const palette = { ink: "#ff0000" };',
      "src/b.ts":
        'export const palette = { ink: "#0000ff" };\nexport const lightTheme = { text: palette.ink };',
      "src/V.tsx": view("<View />"),
    });
    expect(own.color("text")?.light).toBe("#0000ff");
  });

  it("counts colours in a style beside other values, and in an object whose aliases aren't colours", async () => {
    const { color } = await app({
      "src/theme.ts": 'export const theme = { light: { surface: "#eeeeee" } };',
      "src/S.tsx": [
        RN,
        "const radius = 8;",
        'export const styles = { card: { borderRadius: radius, backgroundColor: "#ff0000" } };',
        'export const navOptions = { title: "Home", headerStyle: { backgroundColor: theme.light.surface }, headerTintColor: "#123456" };',
      ].join("\n"),
    });
    expect(color("#ff0000")?.uses).toBe(1);
    expect(color("surface")?.uses).toBe(1);
    expect(color("headerTintColor")).toBeUndefined();
  });

  it("names a theme's colours under style-like keys, and a colour given by its CSS name", async () => {
    const { color } = await app({
      "src/theme.ts": [
        "export const themeData = {",
        '  light: { color: "hsl(0, 0%, 20%)", backgroundColor: "white" },',
        '  dark: { color: "hsl(0 0% 80%)", backgroundColor: "rgb(20 30 40)" },',
        "};",
      ].join("\n"),
      "src/V.tsx": view("<View />"),
    });
    expect(color("color")).toMatchObject({ light: "#333333", dark: "#cccccc" });
    expect(color("backgroundColor")).toMatchObject({ light: "#ffffff", dark: "#141e28" });
  });

  it("reads a spread theme with its own colours replacing the base's", async () => {
    const { color } = await app({
      "src/base.ts": 'export const base = { background: "#ffffff", text: "#111111" };',
      "src/theme.ts":
        'import { base } from "./base";\nexport const lightTheme = { ...base };\nexport const darkTheme = { ...base, background: "#000000" };',
      "src/V.tsx": view("<View />"),
    });
    expect(color("background")).toMatchObject({ light: "#ffffff", dark: "#000000" });
    expect(color("text")?.dark).toBeUndefined();
  });

  it("reads iOS's theme where the code chooses one by platform, as the design shows it", async () => {
    const chosen = async (choice: string, extra = "") => {
      const { rn } = await app({
        "src/colors.ts": [
          'import { Platform } from "react-native";',
          'const light = { surfaceLight: "#ffffff" };',
          'const dark = { surfaceLight: "#262931" };',
          'const blackAndroid = { ...dark, surfaceLight: "#0d0d0d" };',
          'const blackIOS = { ...dark, surfaceLight: "#161717" };',
          extra,
          `const black = ${choice};`,
          "export const colors = {",
          "  light: { ...light, backdropOpacity: 0.3 },",
          "  dark: { ...dark, backdropOpacity: 0.9 },",
          "  black: { ...black, backdropOpacity: 0.9 },",
          "};",
        ].join("\n"),
        "src/V.tsx": view("<View />"),
      });
      return rn?.tokens.colors.find((c) => c.reference === "colors.black.surfaceLight")?.light;
    };
    expect(await chosen('Platform.OS === "ios" ? blackIOS : blackAndroid')).toBe("#161717");
    expect(await chosen('Platform.OS !== "android" ? blackIOS : blackAndroid')).toBe("#161717");
    expect(await chosen('"android" === Platform.OS ? blackAndroid : blackIOS')).toBe("#161717");
    expect(await chosen("Platform.select({ android: blackAndroid, ios: blackIOS })")).toBe("#161717");
    expect(await chosen("Platform.select({ default: blackAndroid, native: blackIOS })")).toBe("#161717");
    expect(await chosen("Platform.select({ android: blackAndroid, default: blackIOS })")).toBe("#161717");
    expect(
      await chosen(
        "Platform.select({ android: blackAndroid, ios })",
        'const ios = { ...dark, surfaceLight: "#161717" };',
      ),
    ).toBe("#161717");
    expect(await chosen("Platform.select({ android: blackAndroid })")).toBeUndefined();
    expect(
      await chosen('Platform.OS === "ios" ? { surfaceLight: "#161717" } : { surfaceLight: "#0d0d0d" }'),
    ).toBe("#161717");
    // A choice made in another file, imported.
    const { rn } = await app({
      // Read after the theme's file, so the theme's own path is the one a colour reached two ways keeps.
      "src/z-black.ts": [
        'import { Platform } from "react-native";',
        'const blackAndroid = { surfaceLight: "#0d0d0d" };',
        'const blackIOS = { surfaceLight: "#161717" };',
        'export const black = Platform.OS === "ios" ? blackIOS : blackAndroid;',
      ].join("\n"),
      "src/colors.ts": [
        'import { black } from "./z-black";',
        'const light = { surfaceLight: "#ffffff" };',
        'const dark = { surfaceLight: "#262931" };',
        "export const colors = {",
        "  light: { ...light, backdropOpacity: 0.3 },",
        "  dark: { ...dark, backdropOpacity: 0.9 },",
        "  black: { ...black, backdropOpacity: 0.9 },",
        "};",
      ].join("\n"),
      "src/V.tsx": view("<View />"),
    });
    expect(rn?.tokens.colors.find((c) => c.reference === "colors.black.surfaceLight")?.light).toBe("#161717");
    // Chosen by anything else, which theme it is can't be told.
    expect(await chosen("isTablet ? blackIOS : blackAndroid", "const isTablet = false;")).toBeUndefined();
    expect(await chosen('size === "ios" ? blackIOS : blackAndroid', 'const size = "large";')).toBeUndefined();
  });

  it("writes references the code can use, and counts uses through `[…]`", async () => {
    const { color } = await app({
      "src/colors.ts":
        'export const colors = { "brand-blue": "#0055ff", gray: { 100: "#f5f5f5" } };\nexport const gray = { 200: "#eeeeee" };',
      "src/V.tsx": view('<View style={{ color: colors["brand-blue"], borderColor: colors.gray[100] }} />'),
    });
    expect(color("brand-blue")).toMatchObject({ reference: 'colors["brand-blue"]', uses: 1 });
    expect(color("gray-100")).toMatchObject({ reference: "colors.gray[100]", uses: 1 });
    expect(color("gray-200")?.reference).toBe("gray[200]");
  });

  it("doesn't take a look-alike name, a bound name or a constant's own wrapped value for a use", async () => {
    const { color } = await app({
      "src/palette.ts":
        'export const palette = { text: "#111111" };\nexport const brand = "#3366e6" as const;',
      "src/V.tsx": `${RN}export const V = ({ themePark, colorfulArticle }) => <Text>{themePark.text}{colorfulArticle.text}</Text>;\nfunction Button({ brand }) { return brand ? 1 : 2; }`,
    });
    expect([color("text")?.uses, color("brand")?.uses]).toEqual([0, 0]);
  });

  it("keeps theme siblings that aren't themes, pairs each light and dark pair apart, and reads nested presets as themes", async () => {
    const { rn, themes } = await app({
      "src/a.ts": [
        'export const theme = { light: { surface: "#ffffff" }, dark: { surface: "#000000" }, common: { accent: "#ff0000" } };',
        'export const lightColors = { text: "#111111" };',
        'export const darkColors = { text: "#eeeeee" };',
      ].join("\n"),
      "src/b.ts":
        'export const LightTheme = { text: "#222222" };\nexport const DarkTheme = { text: "#dddddd" };',
      "src/c.ts": [
        "export const INVITE_THEMES = {",
        '  dawn: { light: { qr: "#006aff" }, dark: { qr: "#0f73ff" } },',
        '  day: { light: { qr: "#111111" }, dark: { qr: "#222222" } },',
        "};",
        'export const themes = { light: { colors: { tint: "#123456" } }, dark: { colors: { tint: "#654321" } }, black: { colors: { tint: "#000001" } } };',
      ].join("\n"),
      "src/V.tsx": view("<View />"),
    });
    const all = (name: string) =>
      rn?.tokens.colors.filter((c) => c.name === name).map((c) => `${c.light}/${c.dark}`);
    expect(all("accent")).toEqual(["#ff0000/undefined"]);
    expect(all("text")?.sort()).toEqual(["#111111/#eeeeee", "#222222/#dddddd"]);
    expect(all("qr")).toEqual(["#006aff/#0f73ff"]);
    expect(all("tint")).toEqual(["#123456/#654321"]);
    expect(themes()).toEqual([
      "day: qr #111111/#222222 INVITE_THEMES.day.light.qr 0",
      "black: tint #000001/undefined themes.black.colors.tint 0",
    ]);
  });
});

describe("React Native themes beside each other", () => {
  it("takes other objects beside a light and a dark theme for themes, and keeps one colour reached two ways", async () => {
    const { rn, themes } = await app({
      "src/colors.ts": [
        'export const light = { fontDefault: "#2f343d" };',
        'export const dark = { fontDefault: "#c1c7d0" };',
        'export const brandIOS = { fontDefault: "#e4e4e4" };',
        'export const brand = { accent: "#ff0000" };',
        "export const colors = { light: { ...light }, dark: { ...dark } };",
      ].join("\n"),
      "src/V.tsx": `${RN}export const V = () => <View />;`,
    });
    const font = rn?.tokens.colors.filter((c) => c.name === "fontDefault");
    expect(font?.map((c) => `${c.light}/${c.dark}`)).toEqual(["#2f343d/#c1c7d0"]);
    expect(rn?.tokens.colors.find((c) => c.name === "accent")).toBeDefined();
    expect(themes()).toEqual(["brandIOS: fontDefault #e4e4e4/undefined brandIOS.fontDefault 0"]);
  });

  it("follows an alias into a file imported by a path alias, by the path only one colour has", async () => {
    const { color } = await app({
      "src/styles/colors.ts": 'const colors = { green400: "#03d47c" };\nexport default colors;',
      "src/styles/themes/light.ts":
        'import colors from "@styles/colors";\nexport const lightTheme = { success: colors.green400 };',
      "src/V.tsx": `${RN}export const V = () => <View />;`,
    });
    expect(color("success")?.light).toBe("#03d47c");
  });
});

describe("React Native colours, second look", () => {
  const view = `${RN}export const V = () => <View />;`;

  it("lets whichever comes later win, a spread or the object's own colour", async () => {
    const { rn } = await app({
      "src/t.ts": [
        'const base = { primary: "#111111" };',
        'const over = { primary: "#222222" };',
        'export const lightTheme = { primary: "#999999", ...base };',
        "export const darkTheme = { ...base, ...over };",
      ].join("\n"),
      "src/V.tsx": view,
    });
    expect(rn?.tokens.colors.filter((c) => c.name === "primary").map((c) => `${c.light}/${c.dark}`)).toEqual([
      "#111111/#222222",
    ]);
  });

  it("names a colour with its own light and dark values by its object", async () => {
    const { color } = await app({
      "src/Section.tsx": `${RN}const SECONDARY_LABEL = { light: "rgba(60,60,67,0.6)", dark: "rgba(235,235,245,0.6)" };\nexport const S = () => <Text style={{ color: SECONDARY_LABEL.light }} />;`,
    });
    expect(color("SECONDARY_LABEL")).toMatchObject({ light: "#3c3c4399", dark: "#ebebf599" });
    expect(color("light")).toBeUndefined();
  });

  it("pairs a colour with its own light and dark in another theme, and variants beside the default theme in its file", async () => {
    const { themes } = await app({
      "src/themes.ts": [
        'export const themes = { light: { bg: "#ffffff" }, dark: { bg: "#000000" }, sepia: { bg: { light: "#f4ecd8", dark: "#3b2f1e" } } };',
      ].join("\n"),
      "src/colors.ts": [
        'export const lightTheme = { border: "#e6e1da" };',
        'export const darkTheme = { border: "#1a3d32" };',
        'export const lightContrastTheme = { border: "#000000" };',
        'export const darkContrastTheme = { border: "#ffffff" };',
      ].join("\n"),
      "src/V.tsx": view,
    });
    expect(themes()).toEqual([
      "ContrastTheme: border #000000/#ffffff lightContrastTheme.border 0",
      "sepia: bg #f4ecd8/#3b2f1e themes.sepia.bg 0",
    ]);
  });

  it("reads a light or dark theme's variants in files of their own as one theme, its light and dark paired", async () => {
    const { rn, themes } = await app({
      "src/light.ts": 'export const lightTheme = { border: "#e6e1da" };',
      "src/dark.ts": 'export const darkTheme = { border: "#1a3d32" };',
      "src/dark-contrast.ts": 'export const darkContrastTheme = { border: "#ffffff", icon: "#401102" };',
      "src/light-contrast.ts": 'export const lightContrastTheme = { border: "#000000", icon: "#fefefe" };',
      "src/V.tsx": view,
    });
    expect(rn?.tokens.colors.map((c) => `${c.name} ${c.light}/${c.dark}`)).toEqual([
      "border #e6e1da/#1a3d32",
    ]);
    expect(themes()).toEqual([
      "ContrastTheme: border #000000/#ffffff lightContrastTheme.border 0",
      "ContrastTheme: icon #fefefe/#401102 lightContrastTheme.icon 0",
    ]);
  });

  it("keeps a theme whose other values can't be read, and leaves out options with plain values", async () => {
    const { color } = await app({
      "src/t.ts": [
        'export const colors = { primary: "#000000", bg: "#ffffff", fg: library.ink, pad: Platform.select({ ios: 1 }) };',
        'export const options = { title: "Home", headerTintColor: "#123456" };',
      ].join("\n"),
      "src/V.tsx": view,
    });
    expect(color("primary")?.kind).toBe("code");
    expect(color("headerTintColor")).toBeUndefined();
  });

  it("credits a constant only where it's that constant: its file or one importing it, and not a loop or catch name", async () => {
    const { color } = await app({
      "src/a.ts": 'export const brand = "#3366e6";\nexport const A = () => use(brand);',
      "src/b.ts": "const brand = getBrand();\nexport const B = () => use(brand);",
      "src/c.ts":
        'import { brand } from "./a";\nfor (const brand of list) use(brand);\ntry {} catch (brand) { use(brand); }\nuse(brand);',
      "src/V.tsx": view,
    });
    expect(color("brand")?.uses).toBe(2);
  });

  it("reads a native app in ios/ beside a manifest that names React Native but no app", async () => {
    const scan = await scanRepo(
      await tempDir({
        ...MANIFEST,
        "ios/App/Home.swift":
          'import SwiftUI\nstruct Home: View { var body: some View { NavigationStack { List { Text("x") }.navigationTitle("Home") } } }',
      }),
    );
    expect(scan.frameworks.map((f) => f.framework)).toEqual(["swiftui"]);
    expect(scan.nativeAlongside).toBeUndefined();
  });
});

describe("Tailwind colours, read carefully", () => {
  it("follows nested modules, survives configs requiring each other, and skips comments", async () => {
    const { color } = await app({
      "tailwind.config.js":
        'const base = require("./base");\nmodule.exports = { theme: { colors: { brand: require("./brand") } } };',
      "base.js": 'module.exports = require("./tailwind.config");',
      "brand.js": 'module.exports = { 500: "#123456" };',
      "src/global.css":
        "/* @theme { --color-ink: #ff0000; } */\n@theme { --color-ink: #0000ff; --color-tone: oklch(0.628 0.258 29.23); }",
      "src/V.tsx": `${RN}export const V = () => <View className="bg-brand-500 text-ink" />;`,
    });
    expect(color("brand-500")).toMatchObject({ light: "#123456", uses: 1 });
    expect(color("ink")).toMatchObject({ light: "#0000ff", line: 2 });
    const loop = await app({
      "tailwind.config.js": 'module.exports = require("./base");',
      "base.js": 'module.exports = require("./tailwind.config");',
      "src/V.tsx": `${RN}export const V = () => <View />;`,
    });
    expect(loop.rn).toBeDefined();
    expect(color("tone")?.light).toBe("#ff0000");
  });

  it("merges a JavaScript copy of a CSS theme's colours into the CSS one", async () => {
    const { rn } = await app({
      "src/global.css": "@theme { --color-charcoal-100: #e5e5e5; }",
      "src/colors.js": 'module.exports = { charcoal: { 100: "#E5E5E5" } };',
      "src/V.tsx": `${RN}export const V = () => <View className="bg-charcoal-100" style={{ color: colors.charcoal[100] }} />;`,
    });
    expect(rn?.tokens.colors.filter((c) => c.light === "#e5e5e5")).toMatchObject([
      { name: "charcoal-100", uses: 2 },
    ]);
  });
});

describe("colour values", () => {
  it("reads hex, rgb, hsl and oklch, comma- or space-separated, and refuses the rest quickly", () => {
    expect(colorOf("hsl(-120, 100%, 50%)")).toBe("#0000ff");
    expect(colorOf("rgba(0, 0, 0, 50%)")).toBe("#00000080");
    expect(colorOf("rgb(255 0 0 / 0.5)")).toBe("#ff000080");
    expect(colorOf("white")).toBeUndefined();
    expect(colorOf("white", true)).toBe("#ffffff");
    const started = performance.now();
    expect(colorOf(`rgb(1${" ".repeat(4000)}2${" ".repeat(4000)}3${" ".repeat(4000)}x`)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("reads a file with a very long expression without running out of stack", async () => {
    const long = `export const s = ${Array.from({ length: 5000 }, () => '"a"').join(" + ")};`;
    const { rn } = await app({ "src/long.ts": long, "src/V.tsx": `${RN}export const V = () => <View />;` });
    expect(rn).toBeDefined();
  });
});
