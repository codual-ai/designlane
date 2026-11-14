import { describe, expect, it } from "vitest";
import { textAppearances } from "../../src/frameworks/android-text-appearances.js";
import { kotlin, RN_MANIFEST, swift, tsx } from "../helpers/catalog.js";
import { byReference, scanned } from "../helpers/locations.js";

describe("what a text style's span holds", () => {
  it("records no place for a family built as a template, and only the first family of a stack", async () => {
    const { tokens, written } = await scanned({
      ...RN_MANIFEST,
      "src/theme.ts": [
        'const FALLBACK = "sans-serif";',
        "export const typography = {",
        `  mono: { fontFamily: \`Brand Mono, \${FALLBACK}\`, fontSize: 13 },`,
        '  body: { fontFamily: "Inter, sans-serif", fontSize: 15 },',
        "};",
      ].join("\n"),
      "src/Home.tsx": tsx("export const H = () => <Text style={[typography.mono, typography.body]} />;"),
    });
    const { typeStyles } = tokens("react-native");
    const mono = byReference(typeStyles, "typography.mono");
    expect(mono.family).toBe("Brand Mono");
    expect(mono.locations?.fontFamily).toBeUndefined();
    expect(written(mono.locations?.fontSize)).toEqual(["13"]);
    expect(written(byReference(typeStyles, "typography.body").locations?.fontFamily)).toEqual(["Inter"]);
  });

  it("marks a font name holding the weight, a family's identifier, a literal and an expression", async () => {
    const { tokens } = await scanned({
      "Shop/Fonts.swift": swift(
        "extension Font {",
        '  static var brand: Font { .custom("Inter-Bold", size: 17) }',
        "  static let heading = Font.system(size: 22, weight: .semibold)",
        "}",
      ),
      "Shop/Home.swift": swift("let x = Text(a).font(.brand).font(.heading)"),
      "app/src/main/java/Type.kt": kotlin(
        "val Typography = Typography(titleLarge = TextStyle(fontFamily = Inter, fontSize = 22.sp))",
        "@Composable fun S() { MaterialTheme.typography.titleLarge }",
      ),
      ...RN_MANIFEST,
      "src/theme.ts": [
        "export const typography = {",
        '  body: { fontFamily: "Inter-SemiBold", fontSize: 16 },',
        '  title: { fontFamily: "Inter", fontSize: 22, fontWeight: "700" },',
        "};",
      ].join("\n"),
      "src/Home.tsx": tsx("export const H = () => <Text style={[typography.body, typography.title]} />;"),
    });
    const kinds = (framework: "swiftui" | "compose" | "react-native", reference: string) => {
      const locations = byReference(tokens(framework).typeStyles, reference).locations ?? {};
      return Object.fromEntries(Object.entries(locations).map(([key, location]) => [key, location.kind]));
    };
    expect(kinds("swiftui", "Font.brand")).toEqual({
      fontFamily: "family-name",
      fontWeight: "family-name",
      fontSize: "literal",
    });
    expect(kinds("swiftui", "Font.heading")).toEqual({ fontSize: "literal", fontWeight: "expression" });
    expect(kinds("compose", "MaterialTheme.typography.titleLarge")).toEqual({
      fontFamily: "identifier",
      fontSize: "expression",
    });
    expect(kinds("react-native", "typography.body")).toEqual({
      fontFamily: "family-name",
      fontWeight: "family-name",
      fontSize: "literal",
    });
    expect(kinds("react-native", "typography.title")).toEqual({
      fontFamily: "literal",
      fontSize: "literal",
      fontWeight: "literal",
    });
  });

  it("marks a text appearance's font file as an identifier and a weighted family as a font name", () => {
    const rel = "app/src/main/res/values/styles.xml";
    const text = [
      "<resources>",
      '  <style name="TextAppearance.App.Brand"><item name="android:fontFamily">@font/inter</item>',
      '    <item name="android:textSize">15sp</item><item name="android:textStyle">bold</item></style>',
      '  <style name="TextAppearance.App.Body"><item name="android:fontFamily">sans-serif-medium</item></style>',
      "</resources>",
    ].join("\n");
    const styles = textAppearances([{ rel, text }], []);
    const kinds = (name: string) =>
      Object.fromEntries(
        Object.entries(styles.find((s) => s.name === name)?.locations ?? {}).map(([key, l]) => [key, l.kind]),
      );
    expect(kinds("TextAppearance.App.Brand")).toEqual({
      fontFamily: "identifier",
      fontSize: "literal",
      fontWeight: "literal",
    });
    expect(kinds("TextAppearance.App.Body")).toEqual({
      fontFamily: "family-name",
      fontWeight: "family-name",
    });
  });

  it("counts offsets in UTF-16 code units, past a byte order mark and text outside the BMP", async () => {
    const { tokens, written } = await scanned({
      "Shop/Fonts.swift": `﻿import SwiftUI\n// Café 🎨\nextension Font { static var brand: Font { .custom("Inter-Bold", size: 17) } }`,
      "Shop/Home.swift": swift("let x = Text(a).font(.brand)"),
      ...RN_MANIFEST,
      "src/theme.ts": `﻿// Café 🎨\nexport const typography = { body: { fontFamily: "Inter", fontSize: 16 } };`,
      "src/Home.tsx": tsx("export const H = () => <Text style={typography.body} />;"),
    });
    const brand = byReference(tokens("swiftui").typeStyles, "Font.brand").locations;
    expect(written(brand?.fontFamily)).toEqual(["Inter-Bold"]);
    expect(written(brand?.fontSize)).toEqual(["17"]);
    const body = byReference(tokens("react-native").typeStyles, "typography.body").locations;
    expect(written(body?.fontFamily)).toEqual(["Inter"]);
    expect(written(body?.fontSize)).toEqual(["16"]);
  });
});
