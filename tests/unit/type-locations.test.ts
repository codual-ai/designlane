import { describe, expect, it } from "vitest";
import { textAppearances } from "../../src/frameworks/android-text-appearances.js";
import type { ValueLocation } from "../../src/scan/types.js";
import { kotlin, RN_MANIFEST, swift, tsx } from "../helpers/catalog.js";
import { byReference, scanned } from "../helpers/locations.js";

describe("where a SwiftUI app's text styles are written", () => {
  it("records a helper's size, weight and family where its one font writes them", async () => {
    const { tokens, written } = await scanned({
      "App/Fonts.swift": swift(
        "extension Font {",
        "  static let heading = Font.system(size: 22, weight: .semibold)",
        '  static var brand: Font { .custom("Inter-Bold", size: 17) }',
        "  static var label: Font { Font.system(size: 13).weight(.medium) }",
        "  static var em: Font { Font.system(size: 15).bold() }",
        "  static var fit: Font { Font.system(size: 12).withSize(scaled()).weight(pick()) }",
        "}",
      ),
      "App/Home.swift": swift(
        "let x = Text(a).font(.heading).font(.brand).font(.label).font(.em).font(.fit)",
      ),
    });
    const { typeStyles } = tokens("swiftui");
    const heading = byReference(typeStyles, "Font.heading").locations;
    expect(written(heading?.fontSize)).toEqual(["22"]);
    expect(written(heading?.fontWeight)).toEqual([".semibold"]);
    const brand = byReference(typeStyles, "Font.brand").locations;
    expect(written(brand?.fontFamily)).toEqual(["Inter-Bold"]);
    expect(written(brand?.fontWeight)).toEqual(["Inter-Bold"]);
    expect(written(brand?.fontSize)).toEqual(["17"]);
    expect(written(byReference(typeStyles, "Font.label").locations?.fontWeight)).toEqual([".medium"]);
    expect(written(byReference(typeStyles, "Font.em").locations?.fontWeight)).toEqual([".bold()"]);
    expect(byReference(typeStyles, "Font.fit").locations).toBeUndefined();
  });

  it("records no place for what a use sets, or for a helper choosing between fonts", async () => {
    const { tokens, written } = await scanned({
      "App/Fonts.swift": swift(
        "extension Font {",
        "  static func brand(size: CGFloat) -> Font { .system(size: size, weight: .bold) }",
        "  static var display: Font { big ? .system(size: 30) : .system(size: 20) }",
        "  static var small: Font { .system(size: 12, weight: .regular) }",
        "}",
      ),
      "App/Home.swift": swift(
        "let x = Text(a).font(.brand(size: 24)).font(.display).font(.small).font(.small.bold()).font(.small.withSize(30))",
      ),
    });
    const { typeStyles } = tokens("swiftui");
    // A style made from a helper shares the helper's values, so editing one would change the other.
    const derived = ["small bold", "small 30", "brand 24"].map((name) =>
      typeStyles.find((s) => s.name === name),
    );
    expect(derived.map((style) => style?.size)).toEqual([12, 30, 24]);
    expect(derived.map((style) => style?.locations)).toEqual([undefined, undefined, undefined]);
    expect(written(byReference(typeStyles, "Font.small").locations?.fontSize)).toEqual(["12"]);
    expect(byReference(typeStyles, "Font.display").locations).toBeUndefined();
  });

  it("records a parenthesized literal's own text, and a modifier from its dot past a comment", async () => {
    const { tokens, written } = await scanned({
      "App/Fonts.swift": swift(
        "extension Font {",
        '  static var brand: Font { Font.custom(( "Inter"), size: (17)) }',
        "  static var em: Font {",
        "    Font.system(size: 15)",
        "      // keep",
        "      .bold()",
        "  }",
        "}",
      ),
      "App/Home.swift": swift("let x = Text(a).font(.brand).font(.em)"),
    });
    const { typeStyles } = tokens("swiftui");
    const brand = byReference(typeStyles, "Font.brand").locations;
    expect(written(brand?.fontFamily)).toEqual(["Inter"]);
    expect(written(brand?.fontSize)).toEqual(["17"]);
    expect([brand?.fontFamily?.start, brand?.fontSize?.end].every(Number.isInteger)).toBe(true);
    const em = byReference(typeStyles, "Font.em").locations?.fontWeight;
    expect(written(em)).toEqual([".bold()"]);
    expect(em?.line).toBe(7);
  });
});

describe("where a Compose app's text styles are written", () => {
  it("records no place for a size a copy sets that can't be read, and keeps the app's own role", async () => {
    const typography = (size: number) =>
      kotlin(
        "val Body = TextStyle(fontSize = 14.sp)",
        "val Typography = Typography(",
        `  titleLarge = TextStyle(fontSize = ${size}.sp),`,
        "  bodyLarge = Body.copy(fontSize = dynamicSize()),",
        ")",
        "@Composable fun S() { MaterialTheme.typography.titleLarge; MaterialTheme.typography.bodyLarge }",
      );
    const { tokens } = await scanned({
      "automotive/src/main/java/Type.kt": typography(18),
      "phone/src/main/java/Type.kt": typography(24),
    });
    const { typeStyles } = tokens("compose");
    const title = byReference(typeStyles, "MaterialTheme.typography.titleLarge");
    expect(title).toMatchObject({
      size: 24,
      locations: { fontSize: { file: "phone/src/main/java/Type.kt" } },
    });
    expect(byReference(typeStyles, "MaterialTheme.typography.bodyLarge").locations?.fontSize).toBeUndefined();
  });

  it("records a role's values, its family from the typography's default, and a copy's through its base", async () => {
    const { tokens, written } = await scanned({
      "app/src/main/java/Type.kt": kotlin(
        "val Body = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Normal)",
        "val Typography = Typography(",
        "  defaultFontFamily = Inter,",
        "  titleLarge = TextStyle(fontSize = 22.sp, fontWeight = FontWeight.SemiBold),",
        "  bodyLarge = Body.copy(fontWeight = FontWeight.Bold),",
        ")",
        "@Composable fun S() { MaterialTheme.typography.titleLarge; MaterialTheme.typography.bodyLarge }",
      ),
    });
    const { typeStyles } = tokens("compose");
    const title = byReference(typeStyles, "MaterialTheme.typography.titleLarge").locations;
    expect(written(title?.fontSize)).toEqual(["22.sp"]);
    expect(written(title?.fontWeight)).toEqual(["FontWeight.SemiBold"]);
    expect(written(title?.fontFamily)).toEqual(["Inter"]);
    const bold = byReference(typeStyles, "MaterialTheme.typography.bodyLarge").locations;
    expect(written(bold?.fontWeight)).toEqual(["FontWeight.Bold"]);
    expect(written(bold?.fontSize)).toEqual(["Body", "14.sp"]);
  });

  it("keeps the app's default family over a Wear module's", async () => {
    const typography = (family: string) =>
      kotlin(
        `val ${family} = FontFamily(Font(R.font.${family.toLowerCase()}))`,
        `val Typography = Typography(defaultFontFamily = ${family})`,
        "@Composable fun S() { MaterialTheme.typography.bodyMedium }",
      );
    const { tokens, written } = await scanned({
      "app/src/main/java/Type.kt": typography("Inter"),
      "wear/src/main/java/Type.kt": typography("Roboto"),
    });
    const body = byReference(tokens("compose").typeStyles, "MaterialTheme.typography.bodyMedium");
    expect(body.family).toBe("Inter");
    expect(body.locations?.fontFamily?.file).toBe("app/src/main/java/Type.kt");
    expect(written(body.locations?.fontFamily)).toEqual(["Inter"]);
  });

  it("records a text appearance's own items, a parent's through the parent, and a dimension through its link", () => {
    const rel = "app/src/main/res/values/styles.xml";
    const text = [
      "<resources>",
      '  <dimen name="body_size">15sp</dimen>',
      '  <!-- <style name="TextAppearance.Old"><item name="android:textSize">99sp</item></style> -->',
      '  <style name="TextAppearance.App">',
      '    <item name="android:fontFamily">sans-serif-medium</item>',
      "  </style>",
      '  <style name="TextAppearance.App.Body">',
      '    <item name="android:textSize">@dimen/body_size</item>',
      "  </style>",
      "</resources>",
    ].join("\n");
    const at = (location: ValueLocation | undefined) =>
      location && [...(location.via ?? []), location].map((span) => text.slice(span.start, span.end));
    const body = textAppearances([{ rel, text }], []).find((s) => s.name === "TextAppearance.App.Body");
    expect(at(body?.locations?.fontSize)).toEqual(["@dimen/body_size", "15sp"]);
    expect(at(body?.locations?.fontFamily)).toEqual(["TextAppearance.App.Body", "sans-serif-medium"]);
    expect(at(body?.locations?.fontWeight)).toEqual(["TextAppearance.App.Body", "sans-serif-medium"]);
    expect(body?.locations?.fontSize?.line).toBe(2);
    expect(body?.locations?.fontSize?.via?.[0]?.line).toBe(8);
  });

  it("records no place for a size a style sets that can't be read, over its parent's", () => {
    const rel = "app/src/main/res/values/styles.xml";
    const text = [
      "<resources>",
      '<style name="TextAppearance.App">',
      '  <item name="android:textSize">15sp</item><item name="android:fontFamily">serif</item>',
      "</style>",
      '<style name="TextAppearance.App.Small"><item name="android:textSize">?attr/small</item></style>',
      "</resources>",
    ].join("\n");
    const styles = textAppearances([{ rel, text }], []);
    expect(styles.find((s) => s.name === "TextAppearance.App")?.locations?.fontSize).toBeDefined();
    const small = styles.find((s) => s.name === "TextAppearance.App.Small");
    expect(small).toBeDefined();
    expect(small?.locations?.fontSize).toBeUndefined();
  });
});

describe("where a React Native app's text styles are written", () => {
  it("records a typography object's values, through the constants and styles they name", async () => {
    const { tokens, written } = await scanned({
      ...RN_MANIFEST,
      "src/theme.ts": [
        "const base = { lg: scale(20) };",
        "const sizes = { title: base.lg };",
        'export const fonts = { regular: { fontFamily: "Inter-Regular", fontSize: 14 } };',
        "export const typography = {",
        '  body: { ...fonts.regular, fontSize: 16, fontWeight: "400" },',
        '  title: { ...typography.body, fontSize: sizes.title, fontWeight: "700" },',
        "  caption: { fontFamily: typography.body.fontFamily, fontSize: scale(12) },",
        "};",
      ].join("\n"),
      "src/Home.tsx": tsx(
        "export const H = () => <Text style={[typography.body, typography.title, typography.caption]} />;",
      ),
    });
    const { typeStyles } = tokens("react-native");
    const title = byReference(typeStyles, "typography.title").locations;
    expect(written(title?.fontSize)).toEqual(["sizes.title", "base.lg", "20"]);
    expect(written(title?.fontWeight)).toEqual(["700"]);
    expect(written(title?.fontFamily)).toEqual(["typography.body", "fonts.regular", "Inter-Regular"]);
    const caption = byReference(typeStyles, "typography.caption").locations;
    expect(written(caption?.fontFamily)).toEqual([
      "typography.body.fontFamily",
      "fonts.regular",
      "Inter-Regular",
    ]);
    expect(written(caption?.fontSize)).toEqual(["12"]);
    expect(written(byReference(typeStyles, "fonts.regular").locations?.fontWeight)).toEqual([
      "Inter-Regular",
    ]);
  });

  it("records no place for a value the code works out, over one a spread style gave", async () => {
    const { tokens } = await scanned({
      ...RN_MANIFEST,
      "src/theme.ts": [
        "export const typography = {",
        '  body: { fontSize: 16, fontFamily: "Inter-Regular" },',
        "  title: { ...typography.body, ...fontFamilyScale.strong, fontSize: size() },",
        "};",
      ].join("\n"),
      "src/Home.tsx": tsx("export const H = () => <Text style={typography.title} />;"),
    });
    const title = tokens("react-native").typeStyles.find((s) => s.reference === "typography.title");
    expect(title).toMatchObject({ family: "", weight: "computed" });
    expect(title?.locations).toBeUndefined();
  });

  it("records no place for a value two files hold at one path, reached by a path alias", async () => {
    const theme = "export const sizes = { title: 20 };";
    const { tokens } = await scanned({
      ...RN_MANIFEST,
      "src/a/sizes.ts": theme,
      "src/b/sizes.ts": theme,
      "src/theme.ts": [
        'import { sizes } from "@/b/sizes";',
        'export const typography = { title: { fontSize: sizes.title, fontFamily: "Inter" } };',
      ].join("\n"),
      "src/Home.tsx": tsx("export const H = () => <Text style={typography.title} />;"),
    });
    const title = byReference(tokens("react-native").typeStyles, "typography.title");
    expect(title.size).toBe(20);
    expect(title.locations?.fontSize).toBeUndefined();
  });

  it("records a named font size, at the size a scaler is given", async () => {
    const { tokens, written } = await scanned({
      ...RN_MANIFEST,
      "src/variables.ts": "export default { fontSizeNormal: scale(15), fontSizeSmall: 12 };",
      "src/Home.tsx": tsx("export const H = () => <Text style={{ fontSize: variables.fontSizeNormal }} />;"),
    });
    const { typeStyles } = tokens("react-native");
    expect(written(byReference(typeStyles, "variables.fontSizeNormal").locations?.fontSize)).toEqual(["15"]);
    expect(written(byReference(typeStyles, "variables.fontSizeSmall").locations?.fontSize)).toEqual(["12"]);
  });
});
