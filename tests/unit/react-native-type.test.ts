import { describe, expect, it } from "vitest";
import { familyAndWeight } from "../../src/frameworks/rn-fonts.js";
import { scanRepo } from "../../src/scan/index.js";
import type { TypeStyle } from "../../src/scan/types.js";
import { speedIt } from "../helpers/speed.js";
import { tempDir } from "../helpers/temp.js";

const RN = 'import { View, Text, StyleSheet } from "react-native";\n';
const MANIFEST = { "package.json": '{ "dependencies": { "react-native": "0.76.0" } }' };

async function app(files: Record<string, string>) {
  const scan = await scanRepo(await tempDir({ ...MANIFEST, ...files }));
  const tokens = scan.frameworks.find((f) => f.framework === "react-native")?.tokens;
  const style = (name: string): TypeStyle | undefined => tokens?.typeStyles.find((s) => s.name === name);
  return { tokens, style };
}

describe("React Native text styles", () => {
  it("reads each style written in place, in a style sheet or a style prop, with its family, size and weight", async () => {
    const { tokens, style } = await app({
      "src/A.tsx": [
        RN,
        'const styles = StyleSheet.create({ title: { fontSize: 22, fontWeight: "700", fontFamily: "Inter-SemiBold" }, body: { fontSize: 15 } });',
        'export const A = () => <View><Text style={styles.title} /><Text style={{ fontSize: 15, fontWeight: "normal" }} /><Text style={{ fontWeight: "bold" }} /></View>;',
      ].join("\n"),
    });
    expect(style("Inter 22 bold")).toMatchObject({ family: "Inter", size: 22, weight: "bold", uses: 1 });
    expect(style("System 15")).toMatchObject({ kind: "system", uses: 2 });
    expect(tokens?.typeStyles).toHaveLength(2);
    expect(tokens?.fonts).toEqual(["Inter"]);
  });

  it("names the styles a typography object holds, and counts the places reaching them", async () => {
    const { style } = await app({
      "src/theme/typography.ts":
        'export const typography = { title: { fontSize: 28, fontWeight: "600" }, caption: { fontSize: 12, fontFamily: "Lato" } };',
      "src/B.tsx": `${RN}export const B = ({ theme }) => <View><Text style={theme.typography.title} /><Text style={[typography.caption, { color: "red" }]} /><Text style={typography.caption} /><Text style={styles.title} /></View>;`,
    });
    expect(style("title")).toMatchObject({
      kind: "app",
      reference: "typography.title",
      size: 28,
      weight: "semibold",
      uses: 1,
    });
    expect(style("caption")).toMatchObject({ family: "Lato", uses: 2 });
  });

  it("reads sizes and families held by constants, default exports and scaling calls", async () => {
    const { style } = await app({
      "src/styles/variables.ts": "export default { fontSizeNormal: getValueUsingPixelRatio(15, 19) };",
      "src/styles/fonts/index.ts": 'export default { brand: "Brand Sans" };',
      "src/C.tsx": [
        RN,
        'import variables from "./styles/variables";',
        'import fonts from "./styles/fonts";',
        "const sizes = { title: scale(20) };",
        "export const C = () => <View><Text style={{ fontSize: variables.fontSizeNormal, fontFamily: fonts.brand }} /><Text style={{ fontSize: sizes.title }} /></View>;",
      ].join("\n"),
    });
    expect(style("Brand Sans 15")?.uses).toBe(1);
    expect(style("System 20")?.uses).toBe(1);
  });

  it("takes a named style's font into a style spreading it, with the style's own values replacing it", async () => {
    const { style } = await app({
      "src/fonts.ts":
        'export const fontFamily = { EXP_NEUE: { fontFamily: "Brand Neue", fontWeight: "400" } };',
      "src/D.tsx": `${RN}export const D = () => <Text style={{ ...fontFamily.EXP_NEUE, fontSize: 15, fontWeight: "700" }} />;`,
    });
    expect(style("Brand Neue 15 bold")?.uses).toBe(1);
  });

  it("calls a family the code works out unknown, and a size it works out computed", async () => {
    const { style } = await app({
      "src/E.tsx": `${RN}export const E = ({ f, s }) => <Text style={{ fontFamily: f.family, fontSize: s }} />;`,
    });
    expect(style("Unknown font, computed size")?.family).toBe("");
  });
});

describe("font families as React Native writes them", () => {
  it("reads a font file's name, a web stack and the platform's own fonts", () => {
    expect(familyAndWeight("Inter-SemiBold")).toEqual({ family: "Inter", weight: "semibold" });
    expect(familyAndWeight("OpenSans_BoldItalic")).toEqual({ family: "OpenSans", weight: "bold" });
    expect(familyAndWeight("Unica77LL-Italic")).toEqual({ family: "Unica77LL" });
    expect(familyAndWeight('"Inter", system-ui, sans-serif')).toEqual({ family: "Inter" });
    expect(familyAndWeight("-apple-system, BlinkMacSystemFont")).toEqual({ family: "System" });
    expect(familyAndWeight("System")).toEqual({ family: "System" });
  });

  it("reads a font stack written as a template by the family it starts with", async () => {
    const { tokens } = await app({
      "src/F.tsx": `${RN}const FALLBACK = "sans-serif";\nexport const F = () => <Text style={{ fontFamily: \`Brand Mono, \${FALLBACK}\`, fontSize: 13 }} />;`,
    });
    expect(tokens?.fonts).toEqual(["Brand Mono"]);
  });
});

describe("React Native spacing and corner radii", () => {
  it("reads the padding, margins, gaps and radii styles set, most common first", async () => {
    const { tokens } = await app({
      "src/G.tsx": [
        RN,
        "const spacing = { md: 16 };",
        "const styles = StyleSheet.create({ card: { padding: spacing.md, marginTop: 8, gap: 8, borderRadius: 12, borderTopLeftRadius: 4, marginLeft: -4, paddingBottom: 0 } });",
        "export const G = () => <View style={[styles.card, { paddingHorizontal: 8 }]} />;",
      ].join("\n"),
    });
    expect(tokens?.spacing).toEqual([8, 16]);
    expect(tokens?.radii).toEqual([4, 12]);
  });
});

describe("Tailwind text styles, spacing and radii", () => {
  it("reads class names at Tailwind's sizes and a config's, with the config's families", async () => {
    const { tokens, style } = await app({
      "tailwind.config.js":
        'module.exports = { theme: { extend: { colors: { brand: "#ff6c00" }, fontSize: { "3xl": ["25px", { lineHeight: "30px" }] }, fontFamily: { inter: ["Inter", "sans-serif"] } } } };',
      "src/H.tsx": `${RN}export const H = () => <View className="p-4 gap-2 rounded-xl"><Text className="text-lg font-semibold font-inter" /><Text className="text-3xl" /><View className="m-[12px] rounded" /></View>;`,
    });
    expect(style("Inter 18 semibold")?.uses).toBe(1);
    expect(style("System 25")?.uses).toBe(1);
    expect(tokens?.spacing).toEqual([8, 12, 16]);
    expect(tokens?.radii).toEqual([4, 12]);
  });

  it("reads no class names in an app without Tailwind", async () => {
    const { tokens } = await app({
      "src/I.tsx": `${RN}export const I = () => <Text accessibilityLabel="text-lg p-4" />;`,
    });
    expect([tokens?.typeStyles, tokens?.spacing]).toEqual([[], []]);
  });

  speedIt(
    "reads thousands of style sheets quickly",
    async () => {
      const files: Record<string, string> = {};
      for (let f = 0; f < 2000; f++)
        files[`src/s${f}.tsx`] =
          `${RN}const styles = StyleSheet.create({ a: { fontSize: ${10 + (f % 20)}, padding: ${f % 12}, borderRadius: 4 } });\nexport const S${f} = () => <Text style={styles.a} />;`;
      const started = performance.now();
      const { tokens } = await app(files);
      expect(tokens?.typeStyles.length).toBe(20);
      expect(performance.now() - started).toBeLessThan(10_000);
      // Writing thousands of files is slow on Windows; the scan itself has the 10 seconds above.
    },
    30_000,
  );
});

describe("React Native text styles, read carefully", () => {
  const view = `${RN}export const V = () => <View />;`;

  it("finds the named style a chain reaches by its whole path, and counts uses fast", async () => {
    const { style, tokens } = await app({
      "src/t.ts":
        "export const smallTypography = { title: { fontSize: 12 } };\nexport const largeTypography = { title: { fontSize: 32 } };\nexport const typography = { caption: { fontSize: 11 } };",
      "src/A.tsx": `${RN}export const A = () => <Text style={[largeTypography.title, typography.caption.fontSize, route.params.type.title]} />;`,
    });
    expect(style("caption")?.uses).toBe(1);
    expect(tokens?.typeStyles.filter((s) => s.name === "title").map((s) => `${s.size}:${s.uses}`)).toEqual([
      "32:1",
      "12:0",
    ]);
    expect(style("title")).toBeDefined();
  });

  it("gives a named style the font of one it spreads, and counts a spread under a style's own values once", async () => {
    const { style } = await app({
      "src/fonts.ts": 'export const fonts = { body: { fontFamily: "Inter-SemiBold", fontSize: 15 } };',
      "src/t.ts": "export const typography = { title: { ...fonts.body, fontSize: 24 } };",
      "src/B.tsx": `${RN}export const B = () => <View><Text style={{ ...fonts.body, fontSize: 18 }} /><Text style={{ ...fonts.body }} /></View>;`,
    });
    expect(style("title")).toMatchObject({ family: "Inter", size: 24, weight: "semibold" });
    expect(style("Inter 18 semibold")?.uses).toBe(1);
    expect(style("body")?.uses).toBe(2);
  });

  it("lets a value the code works out replace a spread's, and calls a weight it can't read computed", async () => {
    const { style } = await app({
      "src/fonts.ts":
        'export const fonts = { bold: { fontFamily: "Inter", fontSize: 16, fontWeight: "700" } };',
      "src/C.tsx": `${RN}export const C = ({ f, s, w }) => <Text style={{ ...fonts.bold, fontFamily: f, fontSize: s, fontWeight: w }} />;`,
    });
    expect(style("Unknown font, computed size computed weight")?.uses).toBe(1);
  });

  it("names a default export's styles, reads shorthand values, and keeps one of a platform's copies", async () => {
    const { tokens, style } = await app({
      "src/typography.ts":
        'const fontSize = 20;\nexport default { title: { fontSize, fontFamily: "Inter" } };',
      "src/single/fonts.ts":
        'export const fontFamily = { NEUE: { fontFamily: "Brand Neue" , fontSize: 15 } };',
      "src/multi/fonts.ts": 'export const fontFamily = { NEUE: { fontFamily: "BrandNeue", fontSize: 15 } };',
      "src/D.tsx": `${RN}import typography from "./typography";\nexport const D = () => <Text style={typography.title} />;`,
    });
    expect(style("title")).toMatchObject({
      family: "Inter",
      size: 20,
      uses: 1,
      reference: "typography.title",
    });
    expect(tokens?.typeStyles.filter((s) => s.name === "NEUE")).toHaveLength(1);
  });

  it("reads a value through the file it's imported from, never a bare name from another file, and not a local", async () => {
    const { style, tokens } = await app({
      "src/sizes.ts": "export default { body: 17 };",
      "src/icons.ts": "export const ICON = { size: 24 };\nexport const BASE = 18;",
      "src/F.tsx": `${RN}export const F = () => <Text style={{ fontSize: BASE }} />;`,
      "src/E.tsx": `${RN}import dimensions from "./sizes";\nconst size = 30;\nexport const E = () => <Text style={{ fontSize: dimensions.body }} />;\nfunction Label({ size }) { return <Text style={{ fontSize: size, padding: size }} />; }`,
    });
    expect(style("System 17")?.uses).toBe(1);
    expect(style("System, computed size")?.uses).toBe(2);
    expect(tokens?.spacing).toEqual([]);
  });

  it("reads only scaling helpers by their first number", async () => {
    const { tokens } = await app({
      "src/F.tsx": `${RN}export const F = () => <View style={{ marginTop: hp(30), padding: moderateScale(12), margin: Math.max(16, x) }} />;`,
    });
    expect(tokens?.spacing).toEqual([12]);
  });

  it("reads a style sheet's shared style spread elsewhere, and iOS's branch of Platform.select", async () => {
    const { style } = await app({
      "src/views/Styles.ts": `${RN}export default StyleSheet.create({ textRegular: { ...Platform.select({ ios: { fontFamily: "Inter" }, android: { fontFamily: "Inter-Regular" } }) } });`,
      "src/G.tsx": `${RN}import sharedStyles from "./views/Styles";\nexport const G = () => <Text style={{ ...sharedStyles.textRegular, fontSize: 16 }} />;`,
    });
    expect(style("Inter 16")?.uses).toBe(1);
  });

  it("leaves out tool configs and packages inside the app that aren't React Native", async () => {
    const { tokens } = await app({
      "app.config.ts": 'export default { plugins: [["expo-font", { fontFamily: "Inter", fontSize: 1 }]] };',
      "embed/package.json": '{ "dependencies": { "react": "19" } }',
      "embed/tailwind.config.js": "module.exports = { theme: {} };",
      "embed/src/E.tsx": 'export const E = () => <div className="text-lg p-4" />;',
      "src/V.tsx": view,
    });
    expect([tokens?.typeStyles, tokens?.spacing, tokens?.fonts]).toEqual([[], [], []]);
  });
});

describe("font file names", () => {
  it("reads the platform's own fonts with any weight, any case, and expo-google-fonts names", () => {
    expect(familyAndWeight("Roboto-Bold")).toEqual({ family: "System", weight: "bold" });
    expect(familyAndWeight("HelveticaNeue-Medium")).toEqual({ family: "System", weight: "medium" });
    expect(familyAndWeight("ProximaNova-Semibold")).toEqual({ family: "ProximaNova", weight: "semibold" });
    expect(familyAndWeight("Inter_700Bold")).toEqual({ family: "Inter", weight: "bold" });
  });
});

describe("Tailwind class names, read carefully", () => {
  const config = 'module.exports = { theme: { extend: { spacing: { 4: "20px", gutter: "24px" } } } };';

  it("reads every string a class helper is given as one list, and nothing outside class names", async () => {
    const { style, tokens } = await app({
      "tailwind.config.js": config,
      "src/A.tsx": `${RN}export const A = ({ on }) => <View><Text className={clsx("text-lg", on && "font-bold")} /><Text testID="text-xl" accessibilityLabel="Corners are rounded and m-2 looks nice" /></View>;`,
    });
    expect(style("System 18 bold")?.uses).toBe(1);
    expect(tokens?.typeStyles).toHaveLength(1);
    expect(tokens?.radii).toEqual([]);
  });

  it("reads a config's spacing, a variant as a style of its own, and Tailwind brought in by a stylesheet", async () => {
    const withConfig = await app({
      "tailwind.config.js": config,
      "src/B.tsx": `${RN}export const B = () => <View className="p-4 gap-gutter"><Text className="text-sm font-bold md:text-xl md:font-normal lg:p-6" /></View>;`,
    });
    expect(withConfig.tokens?.spacing).toEqual([24, 20]);
    expect(withConfig.style("System 14 bold")?.uses).toBe(1);
    expect(withConfig.style("System 20")?.uses).toBe(1);
    const css = await app({
      "src/global.css": '@import "tailwindcss";\n@theme { --font-inter: "Inter", sans-serif; }',
      "src/C.tsx": `${RN}export const C = () => <Text className="text-lg font-inter rounded-xl" />;`,
    });
    expect(css.style("Inter 18")?.uses).toBe(1);
    expect(css.tokens?.radii).toEqual([12]);
  });
});

describe("React Native text styles, second look", () => {
  it("counts a style once, not again for its Platform.select branches or a platform copy of a named style", async () => {
    const { tokens } = await app({
      "src/A.tsx": `${RN}const styles = StyleSheet.create({ label: { fontSize: 13, ...Platform.select({ ios: { fontFamily: "Lato-Regular" }, android: { fontFamily: "Lato" } }) } });\nexport const A = () => <Text style={styles.label} />;`,
      "src/single/fonts.ts": 'export const fontFamily = { NEUE: { fontFamily: "Brand Neue" } };',
      "src/multi/fonts.ts": 'export const fontFamily = { NEUE: { fontFamily: "BrandNeue" } };',
    });
    expect(tokens?.typeStyles.map((s) => `${s.name}:${s.uses}`)).toEqual(["Lato 13:1", "NEUE:0"]);
  });

  it("takes a spread's style by its path before another style of the same name", async () => {
    const { style } = await app({
      "src/theme.ts": 'export const typography = { label: { fontFamily: "Inter-Bold", fontSize: 16 } };',
      "src/A.tsx": `${RN}const common = StyleSheet.create({ label: { fontFamily: "Lato-Regular", fontSize: 12 } });\nexport const s = StyleSheet.create({ big: { ...common.label, fontSize: 18 } });`,
    });
    expect(style("Lato 18")?.uses).toBe(1);
  });

  it("reads a named style's own value once, as the style using it, with the named style's family", async () => {
    const { style } = await app({
      "src/theme.ts":
        'export const typography = { title: { fontFamily: "Inter", fontSize: 28, fontWeight: "700" } };',
      "src/A.tsx": `${RN}export const A = () => <Text style={{ fontFamily: typography.title.fontFamily, fontSize: typography.title.fontSize }} />;`,
    });
    expect(style("Inter 28")?.uses).toBe(1);
    expect(style("title")?.uses).toBe(0);
  });

  it("follows a value through paths holding others, and leaves a font spread it can't read unknown", async () => {
    const { style } = await app({
      "src/variables.ts": "export default { fontSizeXLarge: 22 };",
      "src/scale.ts":
        'import variables from "./variables";\nexport const fontScale = { h1: variables.fontSizeXLarge };',
      "src/A.tsx": `${RN}import { fontScale } from "./scale";\nconst local = { title: fontScale.h1 };\nexport const A = () => <Text style={{ ...fontFamilyScale.strong, fontSize: local.title }} />;\nexport const B = () => <Text style={{ fontWeight: "semibold", fontSize: 15 }} />;`,
    });
    expect(style("Unknown font 22 computed weight")?.uses).toBe(1);
    expect(style("System 15 semibold")?.uses).toBe(1);
  });

  it("keeps a local native module inside the app, which React Native comes to from the app", async () => {
    const { tokens } = await app({
      "modules/picker/package.json": '{ "name": "picker" }',
      "modules/picker/src/Picker.tsx": `${RN}export const P = () => <Text style={{ fontSize: 19 }} />;`,
    });
    expect(tokens?.typeStyles.map((s) => s.name)).toEqual(["System 19"]);
  });
});

describe("Tailwind class names, second look", () => {
  it("reads class names held in variables and ternaries, sizes with a line height or of their own, and CSS fonts", async () => {
    const { tokens, style } = await app({
      "src/global.css": '@import "tailwindcss";\n@theme { --font-display: "Satoshi"; }',
      "src/A.tsx": [
        RN,
        'const heading = "mt-[20px] text-base/5 font-display";',
        'export const A = ({ light }) => <View><Text className={heading} /><Text className={light ? "text-[17px]" : "text-sm"} /><View className="-m-2" /></View>;',
      ].join("\n"),
    });
    expect(style("Satoshi 16")?.uses).toBe(1);
    expect(style("System 17")?.uses).toBe(1);
    expect(tokens?.spacing).toEqual([20]);
  });
});
