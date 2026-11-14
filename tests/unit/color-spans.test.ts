import { describe, expect, it } from "vitest";
import { kotlin, RN_MANIFEST, swift, tsx } from "../helpers/catalog.js";
import { byReference, colorset, scanned } from "../helpers/locations.js";

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
