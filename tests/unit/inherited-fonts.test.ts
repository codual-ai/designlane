import { describe, expect, it } from "vitest";
import { toDesignMd } from "../../src/output/design-md.js";
import { toDesignTokens } from "../../src/output/tokens-json.js";
import { readApp } from "../../src/read/index.js";
import { mergeAgentTokens } from "../../src/scan/agent-tokens.js";
import { scanRepo } from "../../src/scan/index.js";
import { DesignTokensSchema } from "../../src/scan/schema.js";
import type { ScanResult, TypeStyle } from "../../src/scan/types.js";
import { swift } from "../helpers/catalog.js";
import { tempDir } from "../helpers/temp.js";

const RN = 'import { View, Text, StyleSheet } from "react-native";\n';
const MANIFEST = { "package.json": '{ "dependencies": { "react-native": "0.76.0" } }' };
/** A typography object whose styles set what they set, and leave the rest to the text around them. */
const TYPOGRAPHY = {
  "src/theme/typography.ts": [
    "export const typography = {",
    "  title: { fontSize: 28 },",
    '  label: { fontSize: 13, fontFamily: "Inter" },',
    '  strong: { fontSize: 17, fontWeight: "700" },',
    '  heading: { fontSize: 22, fontFamily: "Inter-SemiBold" },',
    "};",
  ].join("\n"),
  "src/A.tsx": `${RN}import { typography } from "./theme/typography";\nexport const A = () => <View><Text style={typography.title} /><Text style={typography.label} /><Text style={typography.strong} /><Text style={typography.heading} /></View>;`,
};

async function scanned(files: Record<string, string>) {
  const scan = await scanRepo(await tempDir(files));
  const tokens = scan.frameworks[0]?.tokens;
  const style = (name: string): TypeStyle | undefined => tokens?.typeStyles.find((s) => s.name === name);
  return { scan, tokens, style };
}

/** Each typography token's values in tokens.json (its family, size and weight), by its key. */
function typography(scan: ScanResult): Record<string, Record<string, unknown>> {
  const group = (toDesignTokens(scan).typography ?? {}) as Record<
    string,
    Record<string, { $value?: unknown }>
  >;
  return Object.fromEntries(
    Object.entries(group)
      .filter(([key]) => !key.startsWith("$"))
      .map(([key, token]) => [
        key,
        Object.fromEntries(
          ["fontFamily", "fontSize", "fontWeight"].flatMap((v) => (token[v] ? [[v, token[v]?.$value]] : [])),
        ),
      ]),
  );
}

describe("a family or weight the code leaves to the text around it", () => {
  it("is recorded as inherited, not as the platform's font and the regular weight", async () => {
    const { tokens, style } = await scanned({ ...MANIFEST, ...TYPOGRAPHY });
    expect(DesignTokensSchema.safeParse(tokens).success).toBe(true);
    expect(style("title")?.inherits).toEqual(["family", "weight"]);
    expect(style("label")?.inherits).toEqual(["weight"]);
    expect(style("strong")?.inherits).toEqual(["family"]);
    // A font file's name carries its weight.
    expect(style("heading")?.inherits).toBeUndefined();
  });

  it("is left out of tokens.json, and out of DESIGN.md's description", async () => {
    const { scan } = await scanned({ ...MANIFEST, ...TYPOGRAPHY });
    const values = typography(scan);
    expect(Object.keys(values.title ?? {})).toEqual(["fontSize"]);
    expect(Object.keys(values.label ?? {})).toEqual(["fontFamily", "fontSize"]);
    expect(Object.keys(values.strong ?? {})).toEqual(["fontSize", "fontWeight"]);
    expect(Object.keys(values.heading ?? {})).toEqual(["fontFamily", "fontSize", "fontWeight"]);
    const md = toDesignMd(scan);
    expect(md).toMatch(/\*\*title\*\* \(28px\)/);
    expect(md).not.toMatch(/SF Pro 28px/);
  });

  it("is left out of what the library reads a use of the style as", async () => {
    const app = await readApp(await tempDir({ ...MANIFEST, ...TYPOGRAPHY }));
    const values = app.tokensIn("src/A.tsx")?.typeStyles.map((u) => [u.token?.key, u.value]);
    expect(values).toContainEqual(["title", { size: 28 }]);
    expect(values).toContainEqual(["label", { family: "Inter", size: 13 }]);
  });

  it("stays inherited in a merged style only when every use leaves it out", async () => {
    const { style } = await scanned({
      ...MANIFEST,
      "src/A.tsx": `${RN}export const A = () => <View><Text style={{ fontSize: 15 }} /><Text style={{ fontSize: 15, fontWeight: "normal" }} /></View>;`,
      "src/B.tsx": `${RN}export const B = () => <View><Text style={{ fontSize: 12 }} /><Text style={{ fontSize: 12 }} /></View>;`,
    });
    expect(style("System 15")).toMatchObject({ uses: 2, inherits: ["family"] });
    expect(style("System 12")).toMatchObject({ uses: 2, inherits: ["family", "weight"] });
  });

  it("is a Tailwind class list's family and weight when it names none", async () => {
    const { style } = await scanned({
      ...MANIFEST,
      "tailwind.config.js":
        'module.exports = { theme: { extend: { fontFamily: { inter: ["Inter", "sans-serif"] } } } };',
      "src/H.tsx": `${RN}export const H = () => <View><Text className="text-lg font-semibold font-inter" /><Text className="text-3xl" /><Text className="text-sm font-bold" /></View>;`,
    });
    expect(style("Inter 18 semibold")?.inherits).toBeUndefined();
    expect(style("System 30")?.inherits).toEqual(["family", "weight"]);
    expect(style("System 14 bold")?.inherits).toEqual(["family"]);
  });

  it("isn't a SwiftUI system font, which the code names with its weight", async () => {
    const { scan, style } = await scanned({
      "App/Theme.swift": swift("extension Font { static let body17 = Font.system(size: 17) }"),
      "App/Home.swift": swift("struct Home: View { var body: some View { Text(t).font(.body17) } }"),
    });
    expect(style("body17")?.inherits).toBeUndefined();
    expect(typography(scan).body17).toMatchObject({ fontFamily: "SF Pro", fontWeight: 400 });
  });

  it("isn't a Tailwind family class's, though Designlane can't name the family", async () => {
    const { style } = await scanned({
      ...MANIFEST,
      "tailwind.config.js": "module.exports = { theme: {} };",
      "src/H.tsx": `${RN}export const H = () => <View><Text className="text-lg font-sans" /><Text className="text-xl font-[Open_Sans]" /><Text className="text-2xl font-mono font-bold" /><Text className="text-4xl font-[Inter-Bold]" /></View>;`,
    });
    expect(style("System 18")).toMatchObject({ inherits: ["weight"] });
    expect(style("Open Sans 20")).toMatchObject({ inherits: ["weight"] });
    expect(style("Unknown font 24 bold")).toMatchObject({ family: "" });
    expect(style("Unknown font 24 bold")).not.toHaveProperty("inherits");
    expect(style("Inter 36 bold")).toMatchObject({ family: "Inter", weight: "bold" });
    expect(style("Inter 36 bold")).not.toHaveProperty("inherits");
  });

  it("keeps apart two styles of one name that differ only in what they inherit, whichever comes first", async () => {
    const styles = (first: string, second: string) =>
      scanned({
        ...MANIFEST,
        "src/a/typography.ts": `export const typography = { body: ${first} };`,
        "src/b/typography.ts": `export const typography = { body: ${second} };`,
        "src/A.tsx": `${RN}import { typography } from "./a/typography";\nexport const A = () => <Text style={typography.body} />;`,
      }).then(({ tokens }) =>
        (tokens?.typeStyles ?? []).filter((t) => t.name === "body").map((t) => t.inherits ?? []),
      );
    const set = '{ fontSize: 16, fontFamily: "System", fontWeight: "400" }';
    const left = "{ fontSize: 16 }";
    expect((await styles(left, set)).sort()).toEqual([[], ["family", "weight"]]);
    expect((await styles(set, left)).sort()).toEqual([[], ["family", "weight"]]);
  });

  it("is an agent's text style's weight when the agent gives none", async () => {
    const { scan } = await scanned({
      ...MANIFEST,
      "src/fonts.ts": 'export const fonts = buildFonts({ headline: ["Inter", 22], caption: ["Inter", 12] });',
      "src/A.tsx": `${RN}import { fonts } from "./fonts";\nexport const A = () => <Text style={[fonts.headline, fonts.caption]} />;`,
    });
    const { scan: merged } = await mergeAgentTokens(scan, {
      textStyles: {
        "fonts.headline": { family: "Inter", size: 22 },
        "fonts.caption": { size: 12, weight: "bold" },
      },
    });
    const styles = merged.frameworks[0]?.tokens.typeStyles ?? [];
    expect(styles.find((t) => t.reference === "fonts.headline")?.inherits).toEqual(["weight"]);
    expect(styles.find((t) => t.reference === "fonts.caption")?.inherits).toBeUndefined();
  });
});
