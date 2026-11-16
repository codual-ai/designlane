import { describe, expect, it } from "vitest";
import { toDesignTokens } from "../../src/output/tokens-json.js";
import { scanRepo } from "../../src/scan/index.js";
import { speedIt } from "../helpers/speed.js";
import { tempDir } from "../helpers/temp.js";

const RN = 'import { View, Text } from "react-native";\n';
const MANIFEST = { "package.json": '{ "dependencies": { "react-native": "0.76.0" } }' };

async function app(files: Record<string, string>) {
  const scan = await scanRepo(await tempDir({ ...MANIFEST, ...files }));
  const tokens = scan.frameworks.find((f) => f.framework === "react-native")?.tokens;
  const sizes = Object.fromEntries(
    (tokens?.typeStyles ?? []).filter((s) => s.family === "").map((s) => [s.reference, s.size]),
  );
  return { scan, tokens, sizes };
}

describe("font sizes a React Native app names", () => {
  it("reads sizes named for what they are, in a default export, an object or a constant", async () => {
    const { sizes } = await app({
      "src/styles/variables.ts": [
        "function getValueUsingPixelRatio(a: number, b: number) { return a; }",
        "export default {",
        "  fontSizeNormal: getValueUsingPixelRatio(15, 21),",
        "  nativeTabIconEmojiStatusFontSize: 8,",
        "  nativeTabIconEmojiStatusFontSizeLandscape: 7,",
        "  iconSize: 20,",
        "} as const;",
      ].join("\n"),
      "src/theme.ts":
        "export const theme = { fontSizes: { small: 12, large: 18 } };\nexport const FONT_SIZE_TITLE = 22;",
      "src/A.tsx": `${RN}export const A = () => <View><Text /></View>;`,
    });
    expect(sizes).toEqual({
      "variables.fontSizeNormal": 15,
      "variables.nativeTabIconEmojiStatusFontSize": 8,
      "variables.nativeTabIconEmojiStatusFontSizeLandscape": 7,
      "theme.fontSizes.small": 12,
      "theme.fontSizes.large": 18,
      FONT_SIZE_TITLE: 22,
    });
  });

  it("leaves out a file's own constants, a style's own fontSize, and values that go with a size rather than being one", async () => {
    const { sizes } = await app({
      "src/styles/variables.ts": [
        "export default {",
        "  fontSizeNormalHeight: 20,",
        "  fontSizeToWidthRatio: 0.8,",
        "  fontSizeLineHeight: 18,",
        "  title: { fontSize: 22 },",
        "  fontSizeComputed: Math.max(12, 14),",
        '  fontSizeDefault: "16px",',
        "  fontSizeNone: 0,",
        "  fontSizes: { lineHeight: 20 },",
        "};",
      ].join("\n"),
      "src/Header.ts": "const TITLE_FONT_SIZE = 17;\nexport const header = TITLE_FONT_SIZE;",
      "src/A.tsx": `${RN}export const A = () => <View><Text /></View>;`,
    });
    expect(sizes).toEqual({});
  });

  it("counts the places reading each size, not its own declaration", async () => {
    const { tokens } = await app({
      "src/sizes.ts": "export const FONT_SIZE_SMALL = 12;\nexport const fonts = { headerFontSize: 20 };",
      "src/A.tsx": [
        RN,
        'import { FONT_SIZE_SMALL, fonts } from "./sizes";',
        "export const A = () => <View><Text style={{ fontSize: FONT_SIZE_SMALL }} /><Text style={{ fontSize: fonts.headerFontSize }} /><Text style={{ fontSize: fonts.headerFontSize }} /></View>;",
        "const other = { FONT_SIZE_SMALL: 1 };",
        "const read = other.FONT_SIZE_SMALL;",
        "function f(FONT_SIZE_SMALL: number) { return FONT_SIZE_SMALL; }",
        'const bracket = fonts["headerFontSize"];',
        "const fixed = fonts.headerFontSize.toFixed();",
      ].join("\n"),
    });
    const uses = (reference: string) => tokens?.typeStyles.find((s) => s.reference === reference)?.uses;
    expect(uses("FONT_SIZE_SMALL")).toBe(1);
    expect(uses("fonts.headerFontSize")).toBe(4);
  });

  it("are written to tokens.json as text styles of a size alone", async () => {
    const { scan } = await app({
      "src/styles/variables.ts": "export default { fontSizeLarge: 17 };",
      "src/A.tsx": `${RN}export const A = () => <View><Text /></View>;`,
    });
    const style = toDesignTokens(scan).typography?.fontSizeLarge;
    expect(style).toMatchObject({
      fontSize: { $value: { value: 17 } },
      $extensions: { designlane: { reference: "variables.fontSizeLarge" } },
    });
    expect(style).not.toHaveProperty("fontFamily");
    expect(style).not.toHaveProperty("fontWeight");
  });

  speedIt(
    "counts the reads of a long chain once, not once per link",
    async () => {
      await app({
        "src/sizes.ts": "export const fonts = { headerFontSize: 20 };",
        "src/A.tsx": `${RN}const x = fonts${".next".repeat(3000)};`,
      });
    },
    3000,
  );
});
