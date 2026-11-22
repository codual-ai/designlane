import { describe, expect, it } from "vitest";
import { applyMap, isMap } from "../../src/scan/agent-map.js";
import { scanRepo } from "../../src/scan/index.js";
import type { ValueLocation } from "../../src/scan/types.js";
import { tempDir } from "../helpers/temp.js";

/** The map read against an app of `files`. */
async function read(files: Record<string, string>, map: object) {
  const scan = await scanRepo(await tempDir(files));
  const reading = await applyMap(scan, { version: 1, ...map });
  const tokens = reading.scan.frameworks[0]?.tokens;
  /** The text a location covers, in the app's file. */
  const at = (l: ValueLocation | undefined) => l && files[l.file]?.slice(l.start, l.end);
  return { reading, tokens, at };
}

const SWIFT_THEME = [
  "import SwiftUI",
  "enum Theme {",
  "  static let surface = Color(red: 1, green: 1, blue: 1)",
  "  static let surfaceDark = Color(hex: 0x121212)",
  '  static let accent = Color("#3366CC")',
  "  static let body = Font.custom(",
  '    "Inter-SemiBold",',
  "    size: 17",
  "  ).weight(.semibold)",
  "  static let md: CGFloat = 16",
  "  static let card: CGFloat = 12",
  "}",
  'struct S: View { var body: some View { Text("a").foregroundStyle(Theme.surface).padding(Theme.md) } }',
].join("\n");

describe("agent map: checked where it says each value is written", () => {
  it("reads SwiftUI colors, a text style over several lines, and scales at their lines, each with where", async () => {
    const { reading, tokens, at } = await read(
      { "App/Theme.swift": SWIFT_THEME },
      {
        colors: {
          "Theme.surface": {
            light: { value: "#ffffff", at: "App/Theme.swift:3" },
            dark: { value: "#121212", at: "App/Theme.swift:4" },
          },
          "Theme.accent": { light: { value: "#3366cc", at: "App/Theme.swift:5" } },
        },
        textStyles: {
          "Theme.body": { family: "Inter", size: 17, weight: "semibold", at: "App/Theme.swift:6" },
        },
        spacing: { "Theme.md": { value: 16, at: "App/Theme.swift:10" } },
        radii: { "Theme.card": { value: 12, at: "App/Theme.swift:11" } },
      },
    );
    expect(reading.unconfirmed).toEqual([]);
    expect(reading.confirmed).toBe(5);
    const surface = tokens?.colors.find((c) => c.reference === "Theme.surface");
    expect(surface).toMatchObject({
      light: "#ffffff",
      dark: "#121212",
      kind: "code",
      source: "App/Theme.swift",
    });
    expect(at(surface?.locations?.light)).toBe("Color(red: 1, green: 1, blue: 1)");
    expect(at(surface?.locations?.dark)).toBe("Color(hex: 0x121212)");
    const body = tokens?.typeStyles.find((s) => s.reference === "Theme.body");
    expect(body).toMatchObject({ family: "Inter", size: 17, weight: "semibold" });
    expect(at(body?.locations?.fontSize)).toBe("17");
    expect(at(body?.locations?.fontFamily)).toBe("Inter-SemiBold");
    expect(body?.locations?.fontFamily?.kind).toBe("family-name");
    expect(at(body?.locations?.fontWeight)).toBe(".semibold");
    expect(tokens?.scales?.spacing.map((s) => [s.reference, s.value])).toEqual([["Theme.md", 16]]);
    expect(at(tokens?.scales?.radii[0]?.location)).toBe("12");
  });

  it("reads Compose's hex colors, a TextStyle, and dp values", async () => {
    const files = {
      "app/src/main/java/a/Theme.kt": [
        "import androidx.compose.runtime.Composable",
        "val Primary = Color(0xFF6650A4)",
        "val Body = TextStyle(",
        "  fontFamily = Inter,",
        "  fontSize = 16.sp,",
        "  fontWeight = FontWeight.Medium,",
        ")",
        "val Medium = 16.dp",
      ].join("\n"),
      "app/src/main/java/a/S.kt":
        'import androidx.compose.runtime.Composable\n@Composable fun S() { Text("a", color = Primary) }',
    };
    const { reading, tokens, at } = await read(files, {
      colors: { Primary: { light: { value: "#6650a4", at: "app/src/main/java/a/Theme.kt:2" } } },
      textStyles: { Body: { size: 16, weight: "medium", at: "app/src/main/java/a/Theme.kt:3" } },
      spacing: { Medium: { value: 16, at: "app/src/main/java/a/Theme.kt:8" } },
    });
    expect(reading.unconfirmed).toEqual([]);
    expect(at(tokens?.colors.find((c) => c.reference === "Primary")?.locations?.light)).toBe(
      "Color(0xFF6650A4)",
    );
    expect(at(tokens?.typeStyles.find((s) => s.reference === "Body")?.locations?.fontSize)).toBe("16.sp");
    expect(at(tokens?.scales?.spacing[0]?.location)).toBe("16.dp");
  });

  it("reads React Native's theme object, resource XML, and an asset catalog's color", async () => {
    const files = {
      "package.json": '{ "dependencies": { "react-native": "0.76.0" } }',
      "src/theme.ts": [
        "export const colors = {",
        "  primary: '#3366ff',",
        "  muted: 'rgb(153, 153, 153)',",
        "  subtle: 'hsl(0, 0%, 60%)',",
        "};",
      ].join("\n"),
      "src/S.tsx": 'import { View } from "react-native";\nexport function S() { return <View />; }',
    };
    const { reading, tokens, at } = await read(files, {
      colors: {
        "colors.primary": { light: { value: "#3366ff", at: "src/theme.ts:2" } },
        "colors.muted": { light: { value: "#999999", at: "src/theme.ts:3" } },
        "colors.subtle": { light: { value: "#999999", at: "src/theme.ts:4" } },
      },
    });
    expect(reading.unconfirmed).toEqual([]);
    expect(at(tokens?.colors.find((c) => c.reference === "colors.primary")?.locations?.light)).toBe(
      "#3366ff",
    );
    expect(at(tokens?.colors.find((c) => c.reference === "colors.muted")?.locations?.light)).toBe(
      "rgb(153, 153, 153)",
    );
    expect(at(tokens?.colors.find((c) => c.reference === "colors.subtle")?.locations?.light)).toBe(
      "hsl(0, 0%, 60%)",
    );
    const android = await read(
      {
        "app/src/main/res/values/colors.xml":
          '<resources>\n  <color name="accent">#FF3366CC</color>\n</resources>',
        "app/src/main/java/a/S.kt":
          'import androidx.compose.runtime.Composable\n@Composable fun S() { Text("a", color = colorResource(R.color.accent)) }',
      },
      {
        colors: {
          "R.color.accent": { light: { value: "#3366cc", at: "app/src/main/res/values/colors.xml:2" } },
        },
      },
    );
    expect(android.reading.unconfirmed).toEqual([]);
    expect(android.at(android.tokens?.colors[0]?.locations?.light)).toBe("#FF3366CC");
    const asset = await read(
      {
        "App/Assets.xcassets/Brand.colorset/Contents.json": JSON.stringify(
          {
            colors: [
              {
                idiom: "universal",
                color: {
                  "color-space": "srgb",
                  components: { red: "0x33", green: "0x66", blue: "0xCC", alpha: "1.000" },
                },
              },
            ],
          },
          null,
          2,
        ),
        "App/S.swift": 'import SwiftUI\nstruct S: View { var body: some View { Color("Brand") } }',
      },
      {
        colors: {
          'Color("Brand")': {
            light: { value: "#3366cc", at: "App/Assets.xcassets/Brand.colorset/Contents.json:3" },
          },
        },
      },
    );
    expect(asset.reading.unconfirmed).toEqual([]);
    expect(asset.tokens?.colors[0]).toMatchObject({ kind: "asset", light: "#3366cc" });
    expect(asset.tokens?.colors[0]?.locations?.light?.kind).toBe("components");
  });

  it("leaves out what the code doesn't bear out where the map says, and says why", async () => {
    const { reading, tokens } = await read(
      { "App/Theme.swift": SWIFT_THEME, "Other.swift": "let x = Color(hex: 0xFFFFFF)" },
      {
        colors: {
          "Theme.surface": { light: { value: "#000000", at: "App/Theme.swift:3" } },
          "Theme.accent": { light: { value: "#3366cc", at: "App/Theme.swift:99" } },
          "Theme.gone": { light: { value: "#ffffff", at: "App/Missing.swift:1" } },
          "Theme.outside": { light: { value: "#ffffff", at: "../outside.swift:1" } },
          "Theme.word": { light: { value: "blue-ish", at: "App/Theme.swift:3" } },
          "Theme.spacer": { light: { value: "#ffffff", at: "App/Theme.swift:10" } },
        },
        textStyles: { "Theme.body": { family: "Roboto", size: 17, at: "App/Theme.swift:6" } },
        spacing: { "Theme.md": { value: 8, at: "App/Theme.swift:10" } },
      },
    );
    expect(reading.confirmed).toBe(0);
    expect(reading.unconfirmed.map((u) => [u.reference, u.why])).toEqual([
      ["Theme.surface", "the code there writes #ffffff, not #000000"],
      ["Theme.accent", "the file has no line 99"],
      ["Theme.gone", "the file isn't in the app's folder"],
      ["Theme.outside", "the file isn't in the app's folder"],
      ["Theme.word", "blue-ish isn't a color"],
      ["Theme.spacer", "no spacer is defined there"],
      ["Theme.body", "the family Roboto isn't written there"],
      ["Theme.md", "the code there writes 16, not 8"],
    ]);
    expect(tokens?.colors.filter((c) => c.kind !== "inline")).toEqual([]);
  });
});

describe("agent map: colors written through names, and what's written as no name", () => {
  it("reads a color written as another's name where that one's value is, through each name, in any order", async () => {
    const files = {
      "app/src/main/java/a/Theme.kt": [
        "import androidx.compose.runtime.Composable",
        "private val Light = lightColorScheme(",
        "  primary = Purple40,",
        "  surface = Color.White,",
        "  secondary = Purple40,",
        ")",
        "val Purple40 = Color(0xFF6650A4)",
        '@Composable fun S() { Text("a", color = Purple40) }',
      ].join("\n"),
    };
    const { reading, tokens, at } = await read(files, {
      colors: {
        "MaterialTheme.colorScheme.primary": {
          light: { value: "#6650a4", at: "app/src/main/java/a/Theme.kt:3" },
        },
        "MaterialTheme.colorScheme.surface": {
          light: { value: "#ffffff", at: "app/src/main/java/a/Theme.kt:4" },
        },
        // The name it's written as holds another value: not this one.
        "MaterialTheme.colorScheme.secondary": {
          light: { value: "#112233", at: "app/src/main/java/a/Theme.kt:5" },
        },
        Purple40: { light: { value: "#6650a4", at: "app/src/main/java/a/Theme.kt:7" } },
      },
    });
    expect(reading.unconfirmed.map((u) => u.reference)).toEqual(["MaterialTheme.colorScheme.secondary"]);
    const primary = tokens?.colors.find((c) => c.reference === "MaterialTheme.colorScheme.primary")?.locations
      ?.light;
    expect(at(primary)).toBe("Color(0xFF6650A4)");
    expect(primary?.via?.map((v) => at({ ...v, kind: "literal" }))).toEqual(["Purple40"]);
    expect(
      at(tokens?.colors.find((c) => c.reference === "MaterialTheme.colorScheme.surface")?.locations?.light),
    ).toBe("Color.White");
  });

  it("reads SwiftUI's .white and .black, a CSS color's name, and no name it doesn't bear out", async () => {
    const swift = await read(
      {
        "App/Theme.swift": [
          "import SwiftUI",
          "struct Set { var background: Color = .white",
          "  var label: Color = .black",
          "  var tint: Color = .red }",
          'struct S: View { var body: some View { Text("a") } }',
        ].join("\n"),
      },
      {
        colors: {
          "Set.background": { light: { value: "#ffffff", at: "App/Theme.swift:2" } },
          "Set.label": { light: { value: "#000000", at: "App/Theme.swift:3" } },
          "Set.tint": { light: { value: "#ff0000", at: "App/Theme.swift:4" } },
        },
      },
    );
    expect(swift.reading.unconfirmed.map((u) => u.reference)).toEqual(["Set.tint"]);
    const rn = await read(
      {
        "package.json": '{ "dependencies": { "react-native": "0.76.0" } }',
        "src/theme.ts": "export const colors = { card: 'white' };",
        "src/S.tsx": 'import { View } from "react-native";\nexport function S() { return <View />; }',
      },
      { colors: { "colors.card": { light: { value: "#ffffff", at: "src/theme.ts:1" } } } },
    );
    expect(rn.reading.unconfirmed).toEqual([]);
    expect(rn.at(rn.tokens?.colors.find((c) => c.reference === "colors.card")?.locations?.light)).toBe(
      "white",
    );
  });

  it("reads the platform font and a regular weight as nothing written, and checks a weight that is", async () => {
    const { reading, tokens } = await read(
      {
        "App/Font.swift": [
          "import SwiftUI",
          "extension Font {",
          "  static let body = Font.system(size: 17)",
          "  static let title = Font.system(size: 28)",
          "}",
          'struct S: View { var body: some View { Text("a").font(.body) } }',
        ].join("\n"),
      },
      {
        textStyles: {
          "Font.body": { family: "system", size: 17, weight: "regular", at: "App/Font.swift:3" },
          "Font.title": { family: "system", size: 28, weight: "bold", at: "App/Font.swift:4" },
        },
      },
    );
    expect(reading.unconfirmed.map((u) => [u.reference, u.why])).toEqual([
      ["Font.title", "the weight bold isn't written there"],
    ]);
    expect(tokens?.typeStyles.find((s) => s.reference === "Font.body")).toMatchObject({
      family: "System",
      size: 17,
    });
  });
});

describe("agent map: what leads", () => {
  it("puts the map's tokens of a kind in place of Designlane's, keeps values written without a name, and leaves a kind the map doesn't give", async () => {
    const files = {
      "App/Theme.swift": [
        "import SwiftUI",
        "extension Color {",
        "  static let brand = Color(red: 0.2, green: 0.4, blue: 0.8)",
        "  static let noise = Color(red: 0.9, green: 0.1, blue: 0.1)",
        "}",
        'struct S: View { var body: some View { Text("a").foregroundStyle(Color.brand).background(Color.noise).foregroundColor(Color(hex: 0xABCDEF)).font(.system(size: 13)) } }',
      ].join("\n"),
    };
    const before = (await scanRepo(await tempDir(files))).frameworks[0]?.tokens;
    expect(before?.colors.map((c) => c.reference)).toContain("Color.noise");
    const { tokens } = await read(files, {
      colors: { "Color.brand": { light: { value: "#3366cc", at: "App/Theme.swift:3" } } },
    });
    const named = tokens?.colors.filter((c) => c.kind !== "inline").map((c) => c.reference);
    expect(named).toEqual(["Color.brand"]);
    expect(tokens?.colors.filter((c) => c.kind === "inline").length).toBe(
      before?.colors.filter((c) => c.kind === "inline").length,
    );
    expect(tokens?.typeStyles).toEqual(before?.typeStyles);
  });

  it("reads the themes beside the default one", async () => {
    const { tokens, reading } = await read(
      {
        "App/Theme.swift": [
          "import SwiftUI",
          "enum Light { static let surface = Color(hex: 0xFFFFFF) }",
          "enum Sepia { static let surface = Color(hex: 0xF4ECD8) }",
        ].join("\n"),
      },
      {
        colors: { "theme.surface": { light: { value: "#ffffff", at: "App/Theme.swift:2" } } },
        themes: { Sepia: { "theme.surface": { light: { value: "#f4ecd8", at: "App/Theme.swift:3" } } } },
      },
    );
    expect(reading.unconfirmed).toEqual([]);
    expect(tokens?.themes?.map((t) => [t.name, t.colors.map((c) => c.light)])).toEqual([
      ["Sepia", ["#f4ecd8"]],
    ]);
  });

  it("tells a map from the first agent file, and refuses a map that isn't one", async () => {
    expect(isMap({ version: 1, colors: {} })).toBe(true);
    expect(isMap({ colors: {} })).toBe(false);
    const scan = await scanRepo(await tempDir({ "App/Theme.swift": SWIFT_THEME }));
    await expect(
      applyMap(scan, { version: 1, colors: { a: { light: { value: "#fff", at: "nowhere" } } } }),
    ).rejects.toThrow(/file:line/);
    await expect(applyMap(scan, { version: 2 })).rejects.toThrow(/expected shape/);
  });
});

describe("designlane --from-agent with a map", () => {
  it("says how many tokens it confirmed, and each it left out with where and why", async () => {
    const { run } = await import("../../src/cli/run.js");
    const root = await tempDir({
      "App/Theme.swift": SWIFT_THEME,
      "designlane/agent.json": JSON.stringify({
        version: 1,
        colors: {
          "Theme.surface": { light: { value: "#ffffff", at: "App/Theme.swift:3" } },
          "Theme.accent": { light: { value: "#000000", at: "App/Theme.swift:5" } },
        },
      }),
    });
    const out: string[] = [];
    const error: string[] = [];
    const code = await run([root, "--from-agent", `${root}/designlane/agent.json`, "--no-write"], {
      out: (t) => out.push(t),
      error: (t) => error.push(t),
    });
    expect(code).toBe(0);
    expect(out[0]).toMatch(/^Confirmed 1 token of .*agent\.json where it says they're written$/);
    expect(error).toContain(
      "designlane: left out Theme.accent (App/Theme.swift:5): the code there writes #3366cc, not #000000",
    );
  });
});

/** An app of one file of `lines`, in SwiftUI, Compose or React Native, and the place of its line `n`. */
const APPS = {
  swift: {
    file: "App/Theme.swift",
    files: (lines: string[]) => ({
      "App/Theme.swift": [
        "import SwiftUI",
        ...lines,
        'struct S: View { var body: some View { Text("a") } }',
      ].join("\n"),
    }),
  },
  kotlin: {
    file: "app/src/main/java/a/Theme.kt",
    files: (lines: string[]) => ({
      "app/src/main/java/a/Theme.kt": [
        "import androidx.compose.runtime.Composable",
        ...lines,
        '@Composable fun S() { Text("a") }',
      ].join("\n"),
    }),
  },
  js: {
    file: "src/theme.ts",
    files: (lines: string[]) => ({
      "package.json": '{ "dependencies": { "react-native": "0.76.0" } }',
      "src/theme.ts": ["// theme", ...lines].join("\n"),
      "src/S.tsx": 'import { View } from "react-native";\nexport function S() { return <View />; }',
    }),
  },
};

/** What's left out of a map whose entries are each at a line of `lines` (counting from 1). */
async function leftOut(app: keyof typeof APPS, lines: string[], map: Record<string, Record<string, object>>) {
  const { file, files } = APPS[app];
  const placed = JSON.parse(JSON.stringify(map).replace(/"@(\d+)"/g, (_, n) => `"${file}:${Number(n) + 1}"`));
  const { reading } = await read(files(lines), placed);
  return reading.unconfirmed.map((u) => u.reference).sort();
}

const color = (value: string, line: number) => ({ light: { value, at: `@${line}` } });

describe("agent map: only a definition's own value, read whole, confirms it", () => {
  it("doesn't read a comment, or a neighbor's value on the same line", async () => {
    expect(
      await leftOut("swift", ["let x = Color.black // #ffffff", "let a = Color.black; let b = Color.white"], {
        colors: {
          x: color("#ffffff", 1),
          a: color("#ffffff", 2),
          b: color("#ffffff", 2),
          c: color("#000000", 2),
        },
      }),
    ).toEqual(["a", "c", "x"]);
    const xml = await read(
      {
        "app/src/main/res/values/colors.xml":
          '<resources>\n  <!-- <color name="accent">#FFFFFFFF</color> -->\n  <color name="muted">#FF999999</color>\n</resources>',
        "app/src/main/java/a/S.kt":
          'import androidx.compose.runtime.Composable\n@Composable fun S() { Text("a", color = colorResource(R.color.accent)) }',
      },
      {
        colors: {
          "colorResource(R.color.accent)": {
            light: { value: "#ffffff", at: "app/src/main/res/values/colors.xml:2" },
          },
        },
      },
    );
    expect(xml.reading.unconfirmed.map((u) => u.why)).toEqual(["no accent is defined there"]);
    // A quote or bracket in a comment opens nothing: the line's own value is read.
    expect(
      await leftOut(
        "kotlin",
        [
          "// Don`t touch (",
          "/* old (",
          " */",
          "val Primary = Color(0xFF111111)",
          "val Other = Color(0xFF6650A4)",
        ],
        {
          colors: { Primary: color("#6650a4", 4), Other: color("#6650a4", 5) },
        },
      ),
    ).toEqual(["Primary"]);
  });

  it("reads no value at a line that opens a type, and none of a sum, a negative number or an argument", async () => {
    expect(
      await leftOut(
        "swift",
        [
          "enum Theme {",
          "  static let md: CGFloat = 16 // was 8",
          "  static let lg: CGFloat = 8 * 2",
          "  static let inset: CGFloat = -8",
          "  static let pad = Spacer(minLength: 8)",
          "}",
        ],
        {
          spacing: {
            "Theme.xs": { value: 16, at: "@1" },
            "Theme.md": { value: 8, at: "@2" },
            "Theme.lg": { value: 8, at: "@3" },
            "Theme.inset": { value: 8, at: "@4" },
            "Theme.pad": { value: 8, at: "@5" },
          },
          radii: { "Theme.card": { value: 16, at: "@2" } },
        },
      ),
    ).toEqual(["Theme.card", "Theme.inset", "Theme.lg", "Theme.md", "Theme.pad", "Theme.xs"]);
  });

  it("reads a color whole: not one faded after, made by another call, or of another opacity", async () => {
    expect(
      await leftOut(
        "swift",
        [
          "let faded = Color.white.opacity(0.5)",
          "let gone = Color(red: 1, green: 1, blue: 1).opacity(0)",
          "let point = Point(1, 1, 1)",
          "let font = Font.system(size: 17, weight: .black)",
          "let white = Color.white",
        ],
        {
          colors: {
            faded: color("#ffffff", 1),
            gone: color("#ffffff", 2),
            point: color("#ffffff", 3),
            font: color("#000000", 4),
            white: color("#ffffff", 5),
          },
        },
      ),
    ).toEqual(["faded", "font", "gone", "point"]);
    expect(
      await leftOut("js", ["export const clear = '#ffffff00';", "export const card = '#ffffff';"], {
        colors: { clear: color("#ffffff", 1), card: color("#ffffff00", 2) },
      }),
    ).toEqual(["card", "clear"]);
  });

  it("reads a light and a dark color given together each as itself", async () => {
    expect(
      await leftOut("swift", ["let card = Color(light: .white, dark: Color(hex: 0x121212))"], {
        colors: {
          card: { light: { value: "#121212", at: "@1" }, dark: { value: "#121212", at: "@1" } },
        },
      }),
    ).toEqual(["card"]);
    expect(
      await leftOut("swift", ["let card = Color(light: .white, dark: Color(hex: 0x121212))"], {
        colors: { card: { light: { value: "#ffffff", at: "@1" }, dark: { value: "#121212", at: "@1" } } },
      }),
    ).toEqual([]);
  });

  it("reads through a name only the color it names, as light or dark, and none it can't tell", async () => {
    expect(
      await leftOut(
        "swift",
        [
          "let brand = Color(light: Color(hex: 0x3366CC), dark: Color(hex: 0x99BBFF))",
          "let onCard = brand",
          "let onSheet = brand",
          'let label = Text("brand")',
        ],
        {
          colors: {
            brand: { light: { value: "#3366cc", at: "@1" }, dark: { value: "#99bbff", at: "@1" } },
            onCard: { light: { value: "#99bbff", at: "@2" } },
            onSheet: { light: { value: "#3366cc", at: "@3" }, dark: { value: "#99bbff", at: "@3" } },
            label: color("#3366cc", 4),
          },
        },
      ),
    ).toEqual(["label", "onCard"]);
    expect(
      await leftOut(
        "kotlin",
        [
          "object Light { val accent = Color.White }",
          "object Dark { val accent = Color.Black }",
          "val primary = Light.accent",
          "val other = Other.accent",
          "val bare = accent",
        ],
        {
          colors: {
            "Light.accent": color("#ffffff", 1),
            "Dark.accent": color("#000000", 2),
            primary: color("#000000", 3),
            other: color("#ffffff", 4),
            bare: color("#ffffff", 5),
          },
        },
      ),
    ).toEqual(["bare", "other", "primary"]);
  });

  it("reads a theme's color through the theme's own", async () => {
    const { reading, tokens } = await read(
      APPS.kotlin.files(["val accent = Color.Black", "val primary = accent"]),
      {
        themes: {
          Dark: {
            accent: { light: { value: "#000000", at: `${APPS.kotlin.file}:2` } },
            primary: { light: { value: "#000000", at: `${APPS.kotlin.file}:3` } },
          },
        },
      },
    );
    expect(reading.unconfirmed).toEqual([]);
    expect(tokens?.themes?.[0]?.colors.map((c) => c.reference)).toEqual(["accent", "primary"]);
  });

  it("reads a style's size, family and weight each by its own label, and the platform's font as none", async () => {
    const style = (family: string | undefined, size: number, weight: string, line: number) => ({
      ...(family && { family }),
      size,
      weight,
      at: `@${line}`,
    });
    expect(
      await leftOut(
        "swift",
        [
          'let a = Text("Interest rates").font(.system(size: 17))',
          'let b = Font.custom("Winter", size: 17)',
          'let c = Font.custom("Roboto", size: 17)',
          "let d = Font.system(size: 17, weight: .bold)",
          'let e = Text("a").font(.system(size: 17)).foregroundColor(.black)',
          "let f = Font.system(size: 17).padding(Spacing.medium)",
          "let g = Font.system(size: 17)",
          'let h = Font.custom("Inter-SemiBold", size: 17)',
        ],
        {
          textStyles: {
            a: style("Inter", 17, "regular", 1),
            b: style("Inter", 17, "regular", 2),
            c: style("system", 17, "regular", 3),
            d: style("system", 17, "regular", 4),
            e: style("system", 17, "black", 5),
            f: style("system", 17, "medium", 6),
            g: style("system", 17, "regular", 7),
            h: style("Inter", 17, "regular", 8),
          },
        },
      ),
    ).toEqual(["a", "b", "c", "d", "e", "f", "h"]);
    expect(
      await leftOut(
        "js",
        [
          "export const t = { fontSize: 12, lineHeight: 20 };",
          "export const u = { fontSize: 700, fontWeight: '400' };",
        ],
        {
          textStyles: { t: { size: 20, at: "@1" }, u: { size: 700, weight: "bold", at: "@2" } },
        },
      ),
    ).toEqual(["t", "u"]);
  });

  it("reads an asset catalog's color only at an entry or object holding one", async () => {
    const contents = JSON.stringify(
      {
        colors: [
          {
            idiom: "universal",
            color: { components: { red: "0x11", green: "0x22", blue: "0x33", alpha: "1.000" } },
          },
          {
            idiom: "universal",
            appearances: [{ appearance: "luminosity", value: "dark" }],
            color: { components: { red: "0xEE", green: "0xEE", blue: "0xEE", alpha: "1.000" } },
          },
        ],
      },
      null,
      2,
    );
    const lineOf = (text: string, from = 0) =>
      contents.slice(0, contents.indexOf(text, from)).split("\n").length;
    const file = "App/Assets.xcassets/Brand.colorset/Contents.json";
    const { reading } = await read(
      { ...APPS.swift.files(['let x = Color("Brand")']), [file]: contents },
      {
        colors: {
          top: { light: { value: "#112233", at: `${file}:1` } },
          brand: {
            light: { value: "#112233", at: `${file}:${lineOf('"components"')}` },
            dark: { value: "#eeeeee", at: `${file}:${lineOf('"appearances"') - 2}` },
          },
        },
      },
    );
    expect(reading.unconfirmed.map((u) => u.reference)).toEqual(["top"]);
  });

  it("gives up Designlane's own scale of a kind the map gives, even when none of the map's is borne out", async () => {
    const scan = await scanRepo(await tempDir({ "App/Theme.swift": SWIFT_THEME }));
    const framework = scan.frameworks[0];
    if (!framework) throw new Error("no app");
    const at = { file: "App/Theme.swift", line: 10, start: 0, end: 0, kind: "literal" as const };
    framework.tokens.scales = {
      spacing: [
        { name: "md", value: 16, reference: "Theme.md", source: at.file, line: 10, uses: 1, location: at },
      ],
      radii: [],
    };
    const reading = await applyMap(scan, {
      version: 1,
      spacing: { "Theme.md": { value: 99, at: "App/Theme.swift:10" } },
    });
    expect(reading.scan.frameworks[0]?.tokens.scales).toBeUndefined();
  });

  it("reads the one definition at a line only for what's named for it, as light or dark", async () => {
    expect(
      await leftOut(
        "swift",
        [
          "static let surface = Color.white",
          "static let surfaceDark = Color(hex: 0x121212)",
          "static var brand: Color {",
          "  Color(hex: 0x3366CC)",
          "}",
        ],
        {
          colors: {
            "Color.surface": { light: { value: "#121212", at: "@2" } },
            "Color.card": { light: { value: "#ffffff", at: "@1" }, dark: { value: "#121212", at: "@2" } },
            "Color.accent": color("#3366cc", 4),
            "Color.brand": color("#3366cc", 4),
            "Color.sheet": { light: { value: "#ffffff", at: "@1" } },
          },
        },
      ),
    ).toEqual(["Color.accent", "Color.card", "Color.sheet", "Color.surface"]);
    expect(
      await leftOut(
        "swift",
        ["static let surface = Color.white", "static let surfaceDark = Color(hex: 0x121212)"],
        {
          colors: {
            "Color.surface": { light: { value: "#ffffff", at: "@1" }, dark: { value: "#121212", at: "@2" } },
          },
        },
      ),
    ).toEqual([]);
  });

  it("reads JavaScript keys only as an object's, and none it can't tell apart", async () => {
    expect(
      await leftOut(
        "js",
        [
          "export const theme = { light: { text: '#000000' }, dark: { text: '#ffffff' } };",
          "export const pick = (isDark: boolean) => isDark ? dark : '#ffffff';",
          "export const primary: string = '#3366ff';",
          "export const md: number = 16;",
          "export const styles = {",
          "  title: {",
          "    fontSize: 20,",
          "  },",
          "};",
        ],
        {
          colors: {
            "theme.dark.text": color("#000000", 1),
            "palette.dark": color("#ffffff", 2),
            primary: color("#3366ff", 3),
          },
          spacing: { md: { value: 16, at: "@4" } },
          textStyles: { "styles.title": { size: 20, at: "@7" } },
        },
      ),
    ).toEqual(["palette.dark", "theme.dark.text"]);
    const css = await read(
      { ...APPS.js.files([]), "src/tokens.css": ":root { --space-sm: 4px; --space-md: 8px; }" },
      {
        spacing: {
          "--space-md": { value: 8, at: "src/tokens.css:1" },
          "--space-sm": { value: 8, at: "src/tokens.css:1" },
        },
      },
    );
    expect(css.reading.unconfirmed.map((u) => u.reference)).toEqual(["--space-sm"]);
  });

  it("reads a weight written as a modifier or in the font's name as no regular one, and more of the platform's", async () => {
    expect(
      await leftOut(
        "swift",
        [
          "static let t = Font.system(size: 17).bold()",
          'static let u = Font.custom("Inter-Bold", size: 17)',
          "static let v = UIFont.systemFont(ofSize: 17)",
          "static let w = UIColor.white",
          "static let badge = FrameConfig(width: 28, cornerRadius: 14)",
        ],
        {
          textStyles: {
            t: { family: "system", size: 17, weight: "regular", at: "@1" },
            u: { family: "Inter", size: 17, weight: "regular", at: "@2" },
            v: { family: "system", size: 17, at: "@3" },
          },
          colors: { w: color("#ffffff", 4) },
          radii: { "FrameConfig.badge.cornerRadius": { value: 14, at: "@5" } },
        },
      ),
    ).toEqual(["t", "u"]);
    expect(
      await leftOut("kotlin", ["val Body = TextStyle(fontFamily = FontFamily.Default, fontSize = 16.sp)"], {
        textStyles: { Body: { family: "default", size: 16, at: "@1" } },
      }),
    ).toEqual([]);
  });

  it("reads no definition in a string, nor a style's property of another name or of a nested object", async () => {
    expect(
      await leftOut(
        "js",
        [
          'export const message = "x = Color.white;";',
          "export const body = { lineHeight: 20 };",
          "export const title = { nested: { fontSize: 12 }, fontSize: 24 };",
        ],
        {
          colors: { x: color("#ffffff", 1) },
          textStyles: {
            body: { size: 20, at: "@2" },
            "title.a": { size: 12, at: "@3" },
            title: { size: 24, at: "@3" },
          },
        },
      ),
    ).toEqual(["body", "title.a", "x"]);
  });

  it("reads a weight given by a condition as none, and a color with an opacity the reading misses as none", async () => {
    expect(
      await leftOut(
        "kotlin",
        [
          "val Body = TextStyle(fontSize = 17.sp, fontWeight = if (flag) FontWeight.Bold else FontWeight.Normal)",
          "val Plain = TextStyle(fontSize = 17.sp, fontWeight = if (flag) FontWeight.Bold else FontWeight.Normal)",
        ],
        {
          textStyles: {
            Body: { size: 17, weight: "bold", at: "@1" },
            Plain: { size: 17, weight: "regular", at: "@2" },
          },
        },
      ),
    ).toEqual(["Body", "Plain"]);
    expect(
      await leftOut(
        "swift",
        ["let gone = Color(hex: 0xFFFFFF, opacity: 0)", "let point = Point(light: .white, dark: .black)"],
        {
          colors: { gone: color("#ffffff", 1), point: color("#ffffff", 2) },
        },
      ),
    ).toEqual(["gone", "point"]);
  });

  it("reads a theme's name through its own color, wherever the map lists it, and no dark it wasn't given", async () => {
    const file = APPS.kotlin.file;
    const lines = [
      "object Light { val accent = Color.White }",
      "object Dark { val accent = Color.Black }",
      "val primary = accent",
    ];
    const { reading } = await read(APPS.kotlin.files(lines), {
      colors: { accent: { light: { value: "#ffffff", at: `${file}:2` } } },
      themes: {
        Dark: {
          primary: { light: { value: "#ffffff", at: `${file}:4` } },
          accent: { light: { value: "#000000", at: `${file}:3` } },
        },
      },
    });
    expect(reading.unconfirmed.map((u) => u.reference)).toEqual(["Dark: primary"]);
    expect(
      await leftOut("swift", ["let brand = Color(light: .white, dark: .black)", "let card = brand"], {
        colors: {
          brand: color("#ffffff", 1),
          card: { light: { value: "#ffffff", at: "@2" }, dark: { value: "#ffffff", at: "@2" } },
        },
      }),
    ).toEqual(["card"]);
  });

  it("reads an asset catalog's light color only from an entry for any appearance, its dark one only from dark's", async () => {
    const contents = JSON.stringify(
      {
        colors: [
          {
            idiom: "universal",
            appearances: [{ appearance: "luminosity", value: "dark" }],
            color: { components: { red: "0xEE", green: "0xEE", blue: "0xEE", alpha: "1.000" } },
          },
        ],
      },
      null,
      2,
    );
    const line = contents.slice(0, contents.indexOf('"components"')).split("\n").length;
    const file = "App/Assets.xcassets/Brand.colorset/Contents.json";
    const { reading } = await read(
      { ...APPS.swift.files(['let x = Color("Brand")', "let w = Color.white"]), [file]: contents },
      {
        colors: {
          light: { light: { value: "#eeeeee", at: `${file}:${line}` } },
          w: {
            light: { value: "#ffffff", at: "App/Theme.swift:3" },
            dark: { value: "#eeeeee", at: `${file}:${line}` },
          },
        },
      },
    );
    expect(reading.unconfirmed.map((u) => u.reference)).toEqual(["light"]);
  });
});
