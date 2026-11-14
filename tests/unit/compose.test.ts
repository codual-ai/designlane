import { describe, expect, it } from "vitest";
import { androidHex, argbHex } from "../../src/frameworks/compose-color-values.js";
import { familyFromFile } from "../../src/frameworks/compose-fonts.js";
import { kotlinCodeOnly } from "../../src/frameworks/kotlin-source.js";
import { toDesignTokens } from "../../src/output/tokens-json.js";
import { scanRepo } from "../../src/scan/index.js";
import { themesOutsideNote } from "../../src/scan/notes.js";
import type { ColorToken } from "../../src/scan/types.js";
import { speedIt } from "../helpers/speed.js";
import { tempDir } from "../helpers/temp.js";

const IMPORTS = "import androidx.compose.runtime.Composable\nimport androidx.compose.ui.graphics.Color\n";

async function compose(files: Record<string, string>) {
  const withImports = Object.fromEntries(
    Object.entries(files).map(([rel, text]) => [rel, rel.endsWith(".kt") ? IMPORTS + text : text]),
  );
  const scan = await scanRepo(await tempDir(withImports));
  const found = scan.frameworks.find((f) => f.framework === "compose");
  if (!found) throw new Error("no Compose found");
  return { scan, ...found };
}

const colorOf = (colors: ColorToken[], reference: string) =>
  colors.find((c) => (c.reference ?? c.name) === reference);

describe("Kotlin text", () => {
  it("blanks comments, strings, templates and characters, keeping offsets and newlines", () => {
    const text = [
      "/* outer /* inner */ still a comment { */ val a = 1",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a Kotlin string template, not a JavaScript one.
      'val s = "a ${if (x) "}" else "{"} b" // {',
      'val raw = """',
      '  { "quoted" }',
      '"""',
      "val c = '{'",
      "val e = '\\''",
    ].join("\n");
    const code = kotlinCodeOnly(text);
    expect(code).toHaveLength(text.length);
    expect(code.split("\n")).toHaveLength(7);
    expect(code).not.toMatch(/[{}"']/);
    expect(code).toContain("val a = 1");
    expect(code).toContain("val c =");
  });
});

describe("Compose colour values", () => {
  it("reads Compose's alpha-first hex, and Android resources' alpha-first hex", () => {
    expect(argbHex("0xFFD0BCFF")).toBe("#d0bcff");
    expect(argbHex("0x80000000")).toBe("#00000080");
    expect(argbHex("0xFF6650a4L")).toBe("#6650a4");
    // An Int without alpha digits is see-through, as Compose draws it.
    expect(argbHex("0x6650a4")).toBe("#6650a400");
    expect(androidHex("#FF6650A4")).toBe("#6650a4");
    expect(androidHex("#806650A4")).toBe("#6650a480");
    expect(androidHex("#fff")).toBe("#ffffff");
    expect(androidHex("@color/x")).toBeUndefined();
  });
});

describe("Compose colours", () => {
  it("reads named colours, objects' colours and copies, but not a function's local values", async () => {
    const { tokens } = await compose({
      "app/ui/theme/Color.kt": [
        "val Purple80 = Color(0xFFD0BCFF)",
        "internal val Grey = Color(red = 0.5f, green = 0.5f, blue = 0.5f)",
        "val Faded = Purple80.copy(alpha = 0.5f)",
        "object Palette {",
        "  val Brand: Color = Color(0xFF6650A4)",
        "}",
        "@Composable fun Card() {",
        "  val local = Color(0xFF123456)",
        "  Box(Modifier.background(Palette.Brand).border(1.dp, Purple80))",
        "}",
      ].join("\n"),
    });
    expect(colorOf(tokens.colors, "Purple80")).toMatchObject({ light: "#d0bcff", kind: "code", line: 3 });
    expect(colorOf(tokens.colors, "Grey")?.light).toBe("#808080");
    expect(colorOf(tokens.colors, "Faded")?.light).toBe("#d0bcff80");
    expect(colorOf(tokens.colors, "Palette.Brand")).toMatchObject({ light: "#6650a4", uses: 1 });
    expect(colorOf(tokens.colors, "local")).toBeUndefined();
    // The local colour is still a colour the app uses, written inline.
    expect(tokens.colors.find((c) => c.kind === "inline")?.light).toBe("#123456");
  });

  it("gives each Material role its Light and Dark value, from the scheme pair the theme uses", async () => {
    const { tokens } = await compose({
      "app/ui/theme/Color.kt": [
        "val Purple40 = Color(0xFF6650A4)",
        "val Purple80 = Color(0xFFD0BCFF)",
        "val ContrastPurple = Color(0xFF21005D)",
        "val Pink = Color(0xFFFFD8E4)",
      ].join("\n"),
      "app/ui/theme/Theme.kt": [
        "private val LightAppColors = lightColorScheme(primary = Purple40, surface = Color.White, tertiary = Pink)",
        "private val DarkAppColors = darkColorScheme(primary = Purple80, surface = Color.Black)",
        "private val HighContrastLight = lightColorScheme(primary = ContrastPurple)",
      ].join("\n"),
      "app/ui/Screen.kt":
        "@Composable fun S() { Text(color = MaterialTheme.colorScheme.primary); Box(Modifier.background(Pink)) }",
    });
    expect(colorOf(tokens.colors, "MaterialTheme.colorScheme.primary")).toMatchObject({
      light: "#6650a4",
      dark: "#d0bcff",
      uses: 1,
    });
    expect(colorOf(tokens.colors, "MaterialTheme.colorScheme.surface")).toMatchObject({
      light: "#ffffff",
      dark: "#000000",
    });
    // Colours only the theme reads are part of it, whether the scheme is used or a contrast variant isn't; one a
    // screen uses as well stays, with that use.
    expect(colorOf(tokens.colors, "Purple40")).toBeUndefined();
    expect(colorOf(tokens.colors, "ContrastPurple")).toBeUndefined();
    expect(colorOf(tokens.colors, "Pink")).toMatchObject({ light: "#ffd8e4", uses: 1 });
  });

  it("reads an app's own colour class, named as the code reads it", async () => {
    const { tokens } = await compose({
      "app/theme/AppColors.kt": [
        "@Immutable data class AppColors(",
        "  val brand: Color,",
        "  val background: Color,",
        "  val text: Color,",
        "  val elevation: Dp,",
        ")",
        "val LightColors = AppColors(brand = Color(0xFF4B30ED), background = Color.White, text = Color.Black, elevation = 1.dp)",
        "val DarkColors = AppColors(Color(0xFFDED6FE), Color(0xFF121212), Color.White, 2.dp)",
      ].join("\n"),
      "app/Screen.kt": [
        "@Composable fun S() {",
        "  Text(color = AppTheme.colors.text, bg = AppTheme.colors.brand)",
        "  Box(Modifier.background(AppTheme.colors.brand))",
        "}",
      ].join("\n"),
    });
    expect(colorOf(tokens.colors, "AppTheme.colors.brand")).toMatchObject({
      light: "#4b30ed",
      dark: "#ded6fe",
      uses: 2,
    });
    expect(colorOf(tokens.colors, "AppTheme.colors.background")).toMatchObject({
      light: "#ffffff",
      dark: "#121212",
    });
    expect(tokens.colors.some((c) => c.name === "elevation")).toBe(false);
  });

  it("names a constant in nested objects or a companion object as code outside reads it", async () => {
    const { tokens } = await compose({
      "app/Palette.kt": [
        "object Palette { object Dark { val Bg = Color(0xFF000001) } }",
        "class Brand { companion object { val Accent = Color(0xFF000002) } }",
        "@Composable fun S() { Box(Modifier.background(Palette.Dark.Bg).border(1.dp, Brand.Accent)) }",
      ].join("\n"),
    });
    expect(colorOf(tokens.colors, "Palette.Dark.Bg")).toMatchObject({ light: "#000001", uses: 1 });
    expect(colorOf(tokens.colors, "Brand.Accent")).toMatchObject({ light: "#000002", uses: 1 });
  });

  it("reads colours whose arguments have comments beside them", async () => {
    const { tokens } = await compose({
      "app/Color.kt": [
        "val A = Color(0xFF112233 /* brand */)",
        "val B = Color(",
        "  0xFF445566, // muted",
        ")",
        "val C = Color(",
        "  // red",
        "  0xFF778899)",
      ].join("\n"),
    });
    expect(["A", "B", "C"].map((name) => colorOf(tokens.colors, name)?.light)).toEqual([
      "#112233",
      "#445566",
      "#778899",
    ]);
  });

  it("reads a copy of any colour with its new alpha, but not a copy changing a channel", async () => {
    const { tokens } = await compose({
      "app/Color.kt": [
        "val Scrim = Color(0xFF000000).copy(alpha = 0.32f)",
        "val Brand = Color(0xFF0000FF)",
        "val Tinted = Brand.copy(alpha = 0.5f, red = 1f)",
        "@Composable fun S() { Box(Modifier.background(Color(0xFFFF0000).copy(alpha = 0.5f))) }",
      ].join("\n"),
    });
    expect(colorOf(tokens.colors, "Scrim")?.light).toBe("#00000052");
    expect(colorOf(tokens.colors, "Tinted")).toBeUndefined();
    expect(tokens.colors.find((c) => c.kind === "inline")?.light).toBe("#ff000080");
  });

  it("tells an app colour class's Light and Dark instances apart by the if they're in, skipping unreadable ones", async () => {
    const { tokens } = await compose({
      "app/Theme.kt": [
        "data class AppColors(val brand: Color, val bg: Color, val text: Color)",
        "val LocalAppColors = staticCompositionLocalOf { AppColors(Color.Unspecified, Color.Unspecified, Color.Unspecified) }",
        "@Composable fun AppTheme(dark: Boolean) {",
        "  val colors = if (dark) AppColors(Color(0xFF000001), Color(0xFF000002), Color(0xFF000003))",
        "  else AppColors(Color(0xFFFFFFF1), Color(0xFFFFFFF2), Color(0xFFFFFFF3))",
        "}",
        "object AppTheme { val colors: AppColors @Composable get() = LocalAppColors.current }",
      ].join("\n"),
      "app/Screen.kt": "@Composable fun S() { Text(color = AppTheme.colors.brand) }",
    });
    expect(colorOf(tokens.colors, "AppTheme.colors.brand")).toMatchObject({
      light: "#fffff1",
      dark: "#000001",
    });
  });

  it("never names a theme colour after the R class, and finds a colour by the end of its path", async () => {
    const { tokens } = await compose({
      "app/Theme.kt": [
        "data class AppColors(val primary: Color, val bg: Color, val fg: Color)",
        "val Light = AppColors(Color(0xFF000001), Color(0xFF000002), Color(0xFF000003))",
        "object Palette { object Day { val Brand = Color(0xFF111111) }; object Night { val Brand = Color(0xFF222222) } }",
        "val Scheme = lightColorScheme(primary = Day.Brand)",
        "val DarkScheme = darkColorScheme(primary = Night.Brand)",
      ].join("\n"),
      "app/Screen.kt": [
        "@Composable fun S() {",
        "  Text(color = colorResource(R.color.primary)); Text(color = colorResource(R.color.bg)); Text(color = colorResource(R.color.fg))",
        "  Text(color = AppTheme.colors.primary)",
        "}",
      ].join("\n"),
    });
    expect(colorOf(tokens.colors, "AppTheme.colors.primary")?.light).toBe("#000001");
    expect(tokens.colors.some((c) => c.reference?.startsWith("R.color.primary"))).toBe(false);
    expect(colorOf(tokens.colors, "MaterialTheme.colorScheme.primary")).toMatchObject({
      light: "#111111",
      dark: "#222222",
    });
  });

  it("takes the app's own colour resources over a build variant's, and plain night values over qualified ones", async () => {
    const { tokens } = await compose({
      "app/src/debug/res/values/colors.xml": '<resources><color name="brand">#FFFF0000</color></resources>',
      "app/src/main/res/values/colors.xml": '<resources><color name="brand">#FF111111</color></resources>',
      "app/src/main/res/values-night/colors.xml":
        '<resources><color name="brand">#FF222222</color></resources>',
      "app/src/main/res/values-night-v31/colors.xml":
        '<resources><color name="brand">@android:color/system_accent1_200</color></resources>',
      "app/src/main/Screen.kt": "@Composable fun S() { Text(color = colorResource(R.color.brand)) }",
    });
    expect(colorOf(tokens.colors, "R.color.brand")).toMatchObject({ light: "#111111", dark: "#222222" });
  });

  it("counts uses of a colour that the code reads a property of, so it isn't folded into the theme", async () => {
    const { tokens } = await compose({
      "app/Theme.kt": [
        "object Palette { val Brand = Color(0xFF6650A4) }",
        "val Scheme = lightColorScheme(primary = Palette.Brand)",
      ].join("\n"),
      "app/Screen.kt": "@Composable fun S() { val v = Palette.Brand.value }",
    });
    expect(colorOf(tokens.colors, "Palette.Brand")).toMatchObject({ uses: 1 });
  });

  it("reads a bare name as the colour in the same file, as Kotlin does for private ones", async () => {
    const { tokens } = await compose({
      "feature/a/Theme.kt":
        "private val Primary = Color(0xFF000001)\nval SchemeA = lightColorScheme(primary = Primary)",
      "feature/b/Theme.kt":
        "private val Primary = Color(0xFF000002)\nval DarkB = darkColorScheme(secondary = Primary)",
    });
    expect(colorOf(tokens.colors, "MaterialTheme.colorScheme.primary")?.light).toBe("#000001");
  });

  it("reads colour resources with their night values, and counts their uses in code", async () => {
    const { tokens } = await compose({
      "app/src/main/res/values/colors.xml":
        '<resources><color name="brand">#FF6650A4</color><color name="accent">@color/brand</color></resources>',
      "app/src/main/res/values-night/colors.xml":
        '<resources><color name="brand">#FFD0BCFF</color></resources>',
      "app/Screen.kt": "@Composable fun S() { Text(color = colorResource(R.color.brand)) }",
    });
    expect(colorOf(tokens.colors, "R.color.brand")).toMatchObject({
      light: "#6650a4",
      dark: "#d0bcff",
      kind: "asset",
      uses: 1,
    });
    expect(colorOf(tokens.colors, "R.color.accent")).toMatchObject({ light: "#6650a4", dark: "#d0bcff" });
  });
});

describe("Compose type", () => {
  it("reads the Material type scale's roles, fonts named after their files, and defaults for roles it reads", async () => {
    const { tokens } = await compose({
      "app/ui/theme/Type.kt": [
        "val WorkSans = FontFamily(Font(R.font.work_sans_regular), Font(R.font.work_sans_semibold, FontWeight.SemiBold))",
        "private val baseline = Typography()",
        "val AppTypography = Typography(",
        "  bodyLarge = TextStyle(fontFamily = WorkSans, fontWeight = FontWeight.Normal, fontSize = 16.sp),",
        "  titleLarge = baseline.titleLarge.copy(fontWeight = FontWeight(700)),",
        ")",
      ].join("\n"),
      "app/Screen.kt": [
        "@Composable fun S() {",
        "  Text(style = MaterialTheme.typography.bodyLarge)",
        "  Text(style = MaterialTheme.typography.labelSmall)",
        "}",
      ].join("\n"),
    });
    const role = (name: string) => tokens.typeStyles.find((s) => s.name === name);
    expect(role("bodyLarge")).toMatchObject({
      kind: "text-style",
      family: "Work Sans",
      size: 16,
      weight: "regular",
      reference: "MaterialTheme.typography.bodyLarge",
      uses: 1,
    });
    expect(role("titleLarge")).toMatchObject({ family: "System", size: 22, weight: "bold", uses: 0 });
    expect(role("labelSmall")).toMatchObject({ size: 11, weight: "medium", uses: 1 });
    expect(tokens.fonts).toEqual(["Work Sans"]);
  });

  it("reads Google fonts, and named text styles as the app's own", async () => {
    const { tokens } = await compose({
      "app/Type.kt": [
        'val latoName = GoogleFont("Lato")',
        "val lato = FontFamily(Font(googleFont = latoName, fontProvider = provider))",
        "val HeadingStyle = TextStyle(fontSize = 24.sp, fontWeight = FontWeight.SemiBold, fontFamily = lato)",
      ].join("\n"),
      "app/Screen.kt": "@Composable fun S() { Text(style = HeadingStyle); Text(style = HeadingStyle) }",
    });
    expect(tokens.typeStyles).toContainEqual({
      name: "HeadingStyle",
      kind: "app",
      family: "Lato",
      size: 24,
      weight: "semibold",
      reference: "HeadingStyle",
      uses: 2,
      locations: expect.any(Object),
    });
  });

  it("reads Material 2's defaults, and gives roles a Typography leaves unset its default family", async () => {
    const m2 = await compose({
      "app/Screen.kt":
        "import androidx.compose.material.MaterialTheme\n@Composable fun S() { Text(style = MaterialTheme.typography.h6) }",
    });
    expect(m2.tokens.typeStyles).toContainEqual(
      expect.objectContaining({ name: "h6", size: 20, weight: "medium" }),
    );
    const family = await compose({
      "app/Type.kt": [
        "val Karla = FontFamily(Font(R.font.karla_regular))",
        "val T = Typography(defaultFontFamily = Karla, h1 = TextStyle(fontSize = 1_000.sp, fontWeight = FontWeight.W600))",
      ].join("\n"),
      "app/Screen.kt": "@Composable fun S() { Text(style = MaterialTheme.typography.body1) }",
    });
    const role = (name: string) => family.tokens.typeStyles.find((s) => s.name === name);
    expect(role("h1")).toMatchObject({ family: "Karla", size: 1000, weight: "semibold" });
    expect(role("body1")).toMatchObject({ family: "Karla", size: 16, uses: 1 });
  });

  it("starts a role copied from the app's own style from that style, and counts copies as uses", async () => {
    const { tokens } = await compose({
      "app/Type.kt": [
        "val Base = TextStyle(fontWeight = FontWeight.Bold)",
        "val Heading = TextStyle(fontSize = 24.sp)",
        "val T = Typography(titleLarge = Base.copy(fontSize = 30.sp))",
      ].join("\n"),
      "app/Screen.kt": [
        "@Composable fun S() {",
        "  Text(style = MaterialTheme.typography.titleLarge)",
        "  Text(style = Heading); Text(style = Heading.copy(color = Red)); Text(style = Heading.copy(color = Blue))",
        "}",
      ].join("\n"),
    });
    const style = (name: string) => tokens.typeStyles.find((s) => s.name === name);
    expect(style("titleLarge")).toMatchObject({ size: 30, weight: "bold" });
    expect(style("Heading")?.uses).toBe(3);
  });

  it("names a family after its font files, without weights, with initials in capitals", () => {
    expect(familyFromFile("dm_sans_regular")).toBe("DM Sans");
    expect(familyFromFile("ibm_plex_sans_bold")).toBe("IBM Plex Sans");
    expect(familyFromFile("work_sans_semibold")).toBe("Work Sans");
    expect(familyFromFile("montserrat_regular")).toBe("Montserrat");
    expect(familyFromFile("karla_bold_italic")).toBe("Karla");
  });
});

describe("Compose spacing and radii", () => {
  it("reads dp values from padding, gaps and spacers, and corner shapes", async () => {
    const { tokens } = await compose({
      "app/Screen.kt": [
        "@Composable fun S() {",
        "  Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {",
        "    Spacer(Modifier.height(24.dp))",
        "    Box(Modifier.size(48.dp).clip(RoundedCornerShape(12.dp)))",
        "    Card(shape = RoundedCornerShape(topStart = 4.dp, topEnd = 4.dp))",
        "    Card(shape = RoundedCornerShape(50))",
        "  }",
        "}",
      ].join("\n"),
    });
    expect(tokens.spacing).toEqual([8, 16, 24]);
    expect(tokens.radii).toEqual([4, 12]);
  });
});

describe("a Compose app's tokens.json", () => {
  it("records Android, so the system font is Roboto and Figma shows Android code", async () => {
    const { scan } = await compose({
      "app/Type.kt": "val T = Typography(bodyLarge = TextStyle(fontSize = 16.sp))",
      "app/Screen.kt": "@Composable fun S() { Text(style = MaterialTheme.typography.bodyLarge) }",
    });
    const file = toDesignTokens(scan);
    expect(file.$extensions?.designmap.platform).toBe("android");
    expect(JSON.stringify(file.typography)).toContain('"Roboto"');
  });
});

describe("hostile Compose files", () => {
  // Big enough that reading more than once per line would take minutes, as it once did.
  const SIZE = 200_000;
  const repeat = (line: string) => line.repeat(Math.floor(SIZE / line.length));

  speedIt.each([
    ["calls that never close", repeat("Typography(\nlightColorScheme(\nf(Color(\nTextStyle(\npadding(\n")],
    ["thousands of colour constants", repeat("val C = Color(0xFF000000)\n")],
    ["constants in an object, on one line", `object P { ${repeat("val C = Color(0xFF000000); ")} }`],
    ["thousands of named text styles", repeat("val T = TextStyle(fontSize = 12.sp)\n")],
    [
      "thousands of colour schemes",
      Array.from(
        { length: 4000 },
        (_, i) =>
          `val Light${i} = lightColorScheme(primary = Color.Red)\nval Dark${i} = darkColorScheme(primary = Color.Blue)\n`,
      ).join(""),
    ],
    ["deeply nested calls", repeat(`${"Typography(padding(Color(".repeat(300)}${")))".repeat(300)}\n`)],
    [
      "thousands of different colour classes",
      Array.from(
        { length: 3000 },
        (_, i) =>
          `data class K${i}(val a: Color, val b: Color, val c: Color)\nval x${i} = K${i}(Color.Red, Color.Red, Color.Red)\n`,
      ).join(""),
    ],
  ])("reads %s quickly", async (_, text) => {
    const started = performance.now();
    await compose({ "app/Hostile.kt": text });
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});

describe("themes outside the project", () => {
  it("says so when the code reads its theme from a library, but not for Android's own themes", async () => {
    const { scan } = await compose({
      "app/Screen.kt": [
        "import io.example.designsystem.theme.CompanyTheme",
        "import androidx.glance.GlanceTheme",
        "@Composable fun S() {",
        "  Text(color = CompanyTheme.colors.textPrimary, style = CompanyTheme.typography.body)",
        "  Box(Modifier.background(CompanyTheme.colors.bgCanvas))",
        "  Text(color = GlanceTheme.colors.primary); Text(color = GlanceTheme.colors.primary); Text(color = GlanceTheme.colors.onPrimary)",
        "}",
      ].join("\n"),
    });
    expect(themesOutsideNote(scan)).toBe(
      "This app's theme (`CompanyTheme`) is defined outside this project, so its colours and text styles aren't " +
        "here. Run Designmap on the repo that defines it, and connect the Figma plugin there.",
    );
  });

  it("isn't flagged for a theme the project defines", async () => {
    const { scan } = await compose({
      "app/Theme.kt": "object AppTheme { val colors: AppColors get() = LocalColors.current }",
      "app/Screen.kt":
        "@Composable fun S() { Text(color = AppTheme.colors.a); Text(color = AppTheme.colors.b); Text(color = AppTheme.colors.c) }",
    });
    expect(themesOutsideNote(scan)).toBeUndefined();
  });
});
