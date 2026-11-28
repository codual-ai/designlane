import { readFile } from "node:fs/promises";
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
      ["Theme.body", "its family there is Inter-SemiBold, not Roboto"],
      ["Theme.md", "the code there writes 16, not 8"],
    ]);
    expect(reading.unconfirmed.map((u) => u.kind)).toEqual([
      "other-value",
      "no-line",
      "outside-app",
      "outside-app",
      "invalid-value",
      "no-definition",
      "other-value",
      "other-value",
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
  async function fromAgent(colors: Record<string, object>, ...flags: string[]) {
    const { run } = await import("../../src/cli/run.js");
    const root = await tempDir({
      "App/Theme.swift": SWIFT_THEME,
      "designlane/agent.json": JSON.stringify({ version: 1, colors }),
    });
    const out: string[] = [];
    const error: string[] = [];
    const code = await run([root, "--from-agent", `${root}/designlane/agent.json`, ...flags], {
      out: (t) => out.push(t),
      error: (t) => error.push(t),
    });
    return { root, code, out, error };
  }

  it("says how many it confirmed, a line for each kind of reason the rest were left out, and writes every one", async () => {
    const { root, code, out, error } = await fromAgent({
      "Theme.gone": { light: { value: "#000000", at: "App/Theme.swift:99" } },
      "Theme.surface": { light: { value: "#ffffff", at: "App/Theme.swift:3" } },
      "Theme.accent": { light: { value: "#000000", at: "App/Theme.swift:5" } },
      "Theme.accent2": { light: { value: "#000000", at: "App/Theme.swift:5" } },
    });
    expect(code).toBe(0);
    expect(out[0]).toMatch(/^Confirmed 1 entry of .*agent\.json where it says they're written$/);
    expect(error).toEqual(
      expect.arrayContaining([
        "designlane: left out 3 entries the code doesn't bear out:",
        "  2  the code there gives another value, like Theme.accent (App/Theme.swift:5): the code there writes #3366cc, not #000000",
        "  1  the file has no such line, like Theme.gone (App/Theme.swift:99): the file has no line 99",
      ]),
    );
    // The most common reason first.
    expect(error.filter((l) => l.startsWith("  ")).map((l) => l.trim()[0])).toEqual(["2", "1"]);
    expect(error.at(-1)).toMatch(
      /^designlane: every entry left out, with where and why: .*designlane[\\/]agent-check\.json$/,
    );
    const check = JSON.parse(await readFile(`${root}/designlane/agent-check.json`, "utf8"));
    expect(check.confirmed).toBe(1);
    expect(check.unconfirmed.map((u: { reference: string; kind: string }) => [u.reference, u.kind])).toEqual([
      ["Theme.gone", "no-line"],
      ["Theme.accent", "other-value"],
      ["Theme.accent2", "other-value"],
    ]);
  });

  it("keeps the lines few however many are left out, and writes no file with --no-write", async () => {
    const colors = Object.fromEntries(
      Array.from({ length: 3000 }, (_, i) => [
        `Theme.c${i}`,
        { light: { value: "#000000", at: "App/Theme.swift:99" } },
      ]),
    );
    const { root, error } = await fromAgent(colors, "--no-write");
    expect(error.filter((l) => l.startsWith("  "))).toHaveLength(1);
    expect(error).toContain(
      "designlane: left out 3,000 entries the code doesn't bear out:".replace("3,000", "3000"),
    );
    await expect(readFile(`${root}/designlane/agent-check.json`, "utf8")).rejects.toThrow();
  });

  it("says nothing of entries left out when none is, and writes the file empty", async () => {
    const { root, error } = await fromAgent({
      "Theme.surface": { light: { value: "#ffffff", at: "App/Theme.swift:3" } },
    });
    expect(error.filter((l) => l.includes("left out"))).toEqual([]);
    expect(JSON.parse(await readFile(`${root}/designlane/agent-check.json`, "utf8"))).toEqual({
      confirmed: 1,
      unconfirmed: [],
    });
  });

  it("lists every kind of reason with words of its own", async () => {
    const { UNCONFIRMED_KINDS } = await import("../../src/scan/agent-map.js");
    const words = Object.values(UNCONFIRMED_KINDS);
    expect(new Set(words).size).toBe(words.length);
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

  describe("a palette enum's colors, and a color given for each appearance on lines of their own", () => {
    const lines = [
      "enum CoreColor: Int {",
      "  case red_300 = 0xF59F95",
      "  case red_800 = 0x73140D",
      "}",
      "let pressed = SemanticColor(",
      '  "danger/pressed",',
      "  lightMode: .red_800,",
      "  darkMode: .red_300",
      ")",
    ];
    const palette = { "CoreColor.red_300": color("#f59f95", 2), "CoreColor.red_800": color("#73140d", 3) };

    it("reads an enum case's hex number, and each appearance's argument through the name it gives", async () => {
      const { reading, tokens, at } = await read(APPS.swift.files(lines), {
        colors: {
          "CoreColor.red_300": { light: { value: "#f59f95", at: "App/Theme.swift:3" } },
          "CoreColor.red_800": { light: { value: "#73140d", at: "App/Theme.swift:4" } },
          pressed: {
            light: { value: "#73140d", at: "App/Theme.swift:8" },
            dark: { value: "#f59f95", at: "App/Theme.swift:9" },
          },
        },
      });
      expect(reading.unconfirmed).toEqual([]);
      const pressed = tokens?.colors.find((c) => c.reference === "pressed")?.locations;
      expect(at(pressed?.light)).toBe("0x73140D");
      expect(pressed?.light?.via?.map((v) => at({ ...v, kind: "literal" }))).toEqual([".red_800"]);
      expect(at(pressed?.dark)).toBe("0xF59F95");
    });

    it("reads no appearance's argument beside an opacity, nor one labeled for the other appearance", async () => {
      const faded = [...lines.slice(0, 7), "  lightModeAlpha: 0.5,", ...lines.slice(7)];
      expect(await leftOut("swift", faded, { colors: { ...palette, pressed: color("#73140d", 7) } })).toEqual(
        ["pressed"],
      );
      expect(await leftOut("swift", lines, { colors: { ...palette, pressed: color("#f59f95", 8) } })).toEqual(
        ["pressed"],
      );
    });
    it("reads no argument of a call with another call after it", async () => {
      const lines = ["let pressed = Color(", "  light: .white,", "  dark: .black", ").opacity(0.5)"];
      expect(await leftOut("swift", lines, { colors: { pressed: color("#ffffff", 2) } })).toEqual([
        "pressed",
      ]);
    });

    it("reads no argument of a call inside the value", async () => {
      const lines = [
        "let pressed = choose(",
        "  fallback: Color(light: .white, dark: .black),",
        "  actual: .black",
        ")",
      ];
      expect(await leftOut("swift", lines, { colors: { pressed: color("#ffffff", 2) } })).toEqual([
        "pressed",
      ]);
    });

    it("takes a light argument read alone as no dark color, through any names", async () => {
      const lines = [
        "let pressed = Color(",
        "  light: .white,",
        "  dark: .black",
        ")",
        "let alias = pressed",
        "let alias2 = alias",
      ];
      const both = (line: number) => ({
        light: { value: "#ffffff", at: `@${line}` },
        dark: { value: "#ffffff", at: `@${line}` },
      });
      const pressed = color("#ffffff", 2);
      expect(await leftOut("swift", lines, { colors: { pressed, alias: both(5) } })).toEqual(["alias"]);
      expect(
        await leftOut("swift", lines, { colors: { pressed, alias: color("#ffffff", 5), alias2: both(6) } }),
      ).toEqual(["alias2"]);
    });

    it("still reads a string enum's color", async () => {
      const lines = ["enum Palette: String {", '  case red = "#73140D"', "}"];
      expect(await leftOut("swift", lines, { colors: { "Palette.red": color("#73140d", 2) } })).toEqual([]);
    });
  });

  describe("a Swift color written as another's name with opacity after it", () => {
    const GREY = "enum Palette { static let grey = Color(hex: 0xAFAFBA) }";
    const grey = { "Palette.grey": color("#afafba", 1) };

    it("is that color at the opacity the call gives it", async () => {
      const lines = [GREY, "let layer = Palette.grey.withAlphaComponent(0.6)"];
      expect(await leftOut("swift", lines, { colors: { ...grey, layer: color("#afafba99", 2) } })).toEqual(
        [],
      );
      expect(await leftOut("swift", lines, { colors: { ...grey, layer: color("#afafba", 2) } })).toEqual([
        "layer",
      ]);
    });

    it("multiplies the opacity with .opacity, and sets it with .withAlphaComponent", async () => {
      const lines = [
        GREY,
        "let faint = Palette.grey.opacity(0.5).opacity(0.5)",
        "let reset = Palette.grey.opacity(0.5).withAlphaComponent(0.6)",
      ];
      const colors = { ...grey, faint: color("#afafba40", 2), reset: color("#afafba99", 3) };
      expect(await leftOut("swift", lines, { colors })).toEqual([]);
    });

    it("takes an opacity that isn't a whole byte rounded either way, and no other", async () => {
      const lines = [GREY, "let layer = Palette.grey.withAlphaComponent(0.7)"];
      // 0.7 is 178.5 of 255.
      for (const value of ["#afafbab2", "#afafbab3"])
        expect(await leftOut("swift", lines, { colors: { ...grey, layer: color(value, 2) } })).toEqual([]);
      for (const value of ["#afafbab4", "#000000b3"])
        expect(await leftOut("swift", lines, { colors: { ...grey, layer: color(value, 2) } })).toEqual([
          "layer",
        ]);
    });

    it("keeps its own rounding of the opacity, and a name built on it starts from that", async () => {
      const lines = [
        GREY,
        "let layer = Palette.grey.withAlphaComponent(0.7)",
        "let card = layer.opacity(0.5)",
      ];
      const { tokens, reading } = await read(APPS.swift.files(lines), {
        colors: {
          "Palette.grey": { light: { value: "#afafba", at: "App/Theme.swift:2" } },
          layer: { light: { value: "#afafbab2", at: "App/Theme.swift:3" } },
          // Half of layer's own b3, 179 of 255: 89.5, written 59 or 5a.
          card: { light: { value: "#afafba5a", at: "App/Theme.swift:4" } },
        },
      });
      expect(tokens?.colors.find((c) => c.reference === "layer")?.light).toBe("#afafbab3");
      expect(reading.unconfirmed).toEqual([]);
    });

    it("takes a whole byte only as itself, whatever noise the arithmetic leaves", async () => {
      // 0.8 × 0.75 is 0.6, exactly 153 of 255.
      const lines = [GREY, "let even = Palette.grey.opacity(0.8).opacity(0.75)"];
      expect(await leftOut("swift", lines, { colors: { ...grey, even: color("#afafba99", 2) } })).toEqual([]);
      expect(await leftOut("swift", lines, { colors: { ...grey, even: color("#afafba9a", 2) } })).toEqual([
        "even",
      ]);
    });

    it("takes either rounding through a name built on it", async () => {
      const lines = [GREY, "let layer = Palette.grey.withAlphaComponent(0.7)", "let card = layer"];
      const colors = { ...grey, layer: color("#afafbab2", 2), card: color("#afafbab2", 3) };
      expect(await leftOut("swift", lines, { colors })).toEqual([]);
    });

    it("reads the opacity on the next line", async () => {
      const lines = [GREY, "let layer = Palette.grey", "  .opacity(0.5)"];
      expect(await leftOut("swift", lines, { colors: { ...grey, layer: color("#afafba80", 2) } })).toEqual(
        [],
      );
    });

    it("isn't read with another call after the opacity", async () => {
      const lines = [GREY, "let darker = Palette.grey.opacity(0.5).darker()"];
      expect(await leftOut("swift", lines, { colors: { ...grey, darker: color("#afafba80", 2) } })).toEqual([
        "darker",
      ]);
    });
  });

  it("keeps the name and its opacity whole as the way to the color", async () => {
    const lines = [
      "enum Palette { static let grey = Color(hex: 0xAFAFBA) }",
      "let layer = Palette.grey.opacity(0.5)",
    ];
    const { tokens, at } = await read(APPS.swift.files(lines), {
      colors: {
        "Palette.grey": { light: { value: "#afafba", at: "App/Theme.swift:2" } },
        layer: { light: { value: "#afafba80", at: "App/Theme.swift:3" } },
      },
    });
    const layer = tokens?.colors.find((c) => c.reference === "layer")?.locations?.light;
    expect(at(layer)).toBe("Color(hex: 0xAFAFBA)");
    expect(layer?.via?.map((v) => at({ ...v, kind: "literal" }))).toEqual(["Palette.grey.opacity(0.5)"]);
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

  it("keeps a weight given by a condition unchecked, never regular, and a color with an opacity the reading misses as none", async () => {
    // The condition may give the map's bold, so the style is kept by its size, its weight unplaced; but a weight is
    // given, so it isn't regular.
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
    ).toEqual(["Plain"]);
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

  it("reads Swift's argument labels, but not those inside a value nor a parameter's label for its default", async () => {
    expect(
      await leftOut(
        "swift",
        [
          "static let palette = ColorPalette(accent: .black, contrastingLabel: .white)",
          "private let _background: Color = .init(red: 1, green: 1, blue: 1)",
          "static let surface = Color(hex: 0x121212)",
          "init(width: CGFloat, cornerRadius: CGFloat = 4) {}",
        ],
        {
          colors: {
            "Palette.contrastingLabel": color("#ffffff", 1),
            "Palette.accent": color("#000000", 1),
            "ThemedColor.themedBackground": color("#ffffff", 2),
            "Theme.surface": color("#121212", 3),
            "Theme.red": color("#ffffff", 2),
          },
          radii: { "Frame.cornerRadius": { value: 4, at: "@4" } },
        },
      ),
    ).toEqual(["Theme.red"]);
  });

  it("reads a quoted key that starts with a digit, by the name in its brackets", async () => {
    expect(
      await leftOut("js", ["export const space = {", "  '4px': 4,", "  '8px (Deprecated)': 8,", "};"], {
        spacing: {
          "space['4px']": { value: 4, at: "@2" },
          "space['8px (Deprecated)']": { value: 8, at: "@3" },
          "space['12px']": { value: 4, at: "@2" },
        },
      }),
    ).toEqual(["space['12px']"]);
  });

  it("reads a size call's one argument, not one of several or of another call", async () => {
    expect(
      await leftOut(
        "kotlin",
        [
          "val card = RoundedCornerShape(size = 12.dp)",
          "val chip = RoundedCornerShape(8.dp)",
          "val top = RoundedCornerShape(topStart = 8.dp, topEnd = 8.dp)",
          "val dialog = PaddingValues(vertical = 24.dp)",
          "val other = Spacer(size = 8.dp)",
        ],
        {
          radii: {
            card: { value: 12, at: "@1" },
            chip: { value: 8, at: "@2" },
            top: { value: 8, at: "@3" },
            other: { value: 8, at: "@5" },
          },
          spacing: { dialog: { value: 24, at: "@4" } },
        },
      ),
    ).toEqual(["other", "top"]);
  });

  it("reads a Compose family from its font resource, or the family variable it's given", async () => {
    expect(
      await leftOut(
        "kotlin",
        [
          "val appFont = FontFamily(Font(R.font.roboto_regular_mono))",
          "val Code = TextStyle(fontFamily = appFont, fontSize = 14.sp)",
          "val Body = TextStyle(fontFamily = FontFamily(Font(R.font.inter_variable)), fontSize = 16.sp)",
          "val Other = TextStyle(fontFamily = FontFamily(Font(R.font.lato)), fontSize = 16.sp)",
          "val Mono = TextStyle(fontFamily = appFont, fontSize = 14.sp)",
          "val Serif = TextStyle(fontFamily = appFont, fontSize = 14.sp)",
        ],
        {
          textStyles: {
            Code: { family: "Roboto Mono", size: 14, at: "@2" },
            Body: { family: "Inter", size: 16, at: "@3" },
            Other: { family: "Inter", size: 16, at: "@4" },
            Mono: { family: "Mono", size: 14, at: "@5" },
            Serif: { family: "Roboto Serif", size: 14, at: "@6" },
          },
        },
      ),
    ).toEqual(["Mono", "Other", "Serif"]);
  });
});

describe("agent map: a text style checked part by part", () => {
  const RN = {
    "package.json": '{ "dependencies": { "react-native": "0.76.0" } }',
    "src/S.tsx": 'import { View } from "react-native";\nexport function S() { return <View />; }',
    "src/styles/variables.ts": ["export default {", "  fontSizeSmall: 9,", "  fontSizeLarge: 20,", "};"].join(
      "\n",
    ),
    "src/styles/typography.ts": [
      "import variables from './variables';",
      "const fontScale = {",
      "  small: variables.fontSizeSmall,",
      "};",
      "const lineHeightScale = {",
      "  small: 12,",
      "};",
      "export const textVariants = {",
      "  finePrint: {",
      "    ...fontFamilyScale.regular,",
      "    fontSize: fontScale.small,",
      "    lineHeight: lineHeightScale.small,",
      "  },",
      "  heading: {",
      "    fontSize: fontScale.small,",
      "  },",
      "};",
    ].join("\n"),
  };

  it("keeps a style by the parts it reads, and those from a spread without a place, for no edit to change", async () => {
    const { reading, tokens, at } = await read(RN, {
      textStyles: {
        "textVariants.finePrint": {
          family: "Brand Sans",
          size: 9,
          weight: "bold",
          at: "src/styles/typography.ts:9",
        },
      },
    });
    expect(reading.unconfirmed).toEqual([]);
    const style = tokens?.typeStyles.find((s) => s.reference === "textVariants.finePrint");
    expect(style).toMatchObject({ family: "Brand Sans", size: 9, weight: "bold" });
    expect(Object.keys(style?.locations ?? {})).toEqual(["fontSize"]);
    expect(at(style?.locations?.fontSize)).toBe("9");
  });

  it("follows a size's names to the number, across files and a default import, owner by owner", async () => {
    const { tokens, at } = await read(RN, {
      textStyles: { "textVariants.finePrint": { size: 9, at: "src/styles/typography.ts:9" } },
    });
    const size = tokens?.typeStyles.find((s) => s.reference === "textVariants.finePrint")?.locations
      ?.fontSize;
    // `lineHeightScale.small` is 12, but it's another owner's `small`.
    expect([size?.file, at(size)]).toEqual(["src/styles/variables.ts", "9"]);
    expect(
      size?.via?.map((v) => [v.file, v.line, RN[v.file as keyof typeof RN].slice(v.start, v.end)]),
    ).toEqual([
      ["src/styles/typography.ts", 11, "fontScale.small"],
      ["src/styles/typography.ts", 3, "variables.fontSizeSmall"],
    ]);
  });

  it("refuses a part the code gives otherwise, or leaves at the default, whatever else it can't read", async () => {
    const { reading } = await read(RN, {
      textStyles: {
        "textVariants.finePrint": { size: 12, at: "src/styles/typography.ts:9" },
        "textVariants.heading": { size: 9, weight: "bold", at: "src/styles/typography.ts:14" },
      },
    });
    expect(reading.unconfirmed.map((u) => [u.reference, u.why])).toEqual([
      ["textVariants.finePrint", "fontScale.small is 9, not 12"],
      // Nothing it's built on gives a weight, so it's regular.
      ["textVariants.heading", "the weight bold isn't written there"],
    ]);
  });

  it("reads the one size a call it's built with gives, and refuses a style it reads nothing of", async () => {
    const { reading, tokens, at } = await read(
      APPS.kotlin.files([
        "val Body = AppTextStyle(TextStyle(fontSize = 16.sp))",
        "val Copy = Body.copy(color = Color.Red)",
        "val Both = AppTextStyle(TextStyle(fontSize = 16.sp), TextStyle(fontSize = 12.sp))",
      ]),
      {
        textStyles: {
          Body: { size: 16, at: "app/src/main/java/a/Theme.kt:2" },
          Copy: { size: 16, at: "app/src/main/java/a/Theme.kt:3" },
          Both: { size: 16, at: "app/src/main/java/a/Theme.kt:4" },
        },
      },
    );
    expect(at(tokens?.typeStyles.find((s) => s.reference === "Body")?.locations?.fontSize)).toBe("16.sp");
    expect(reading.unconfirmed.map((u) => [u.reference, u.why])).toEqual([
      ["Copy", "no size is written there"],
      ["Both", "no size is written there"],
    ]);
  });

  it("takes a size from its own owners only, not a nested object's, another import's, or a namesake's", async () => {
    const files = {
      "package.json": '{ "dependencies": { "react-native": "0.76.0" } }',
      "src/S.tsx": 'import { View } from "react-native";\nexport function S() { return <View />; }',
      "src/sizes.ts": "export default {\n  small: compute(),\n};",
      "src/other.ts": "export const variables = {\n  small: 12,\n};",
      "src/theme.ts": [
        "import variables from './sizes';",
        "const light = {",
        "  fontScale: {",
        '    note: "}",',
        "    small: 14,",
        "  },",
        "};",
        "const dark = {",
        "  fontScale: {",
        "    small: 12,",
        "  },",
        "};",
        "export const styles = {",
        "  nested: { label: { fontSize: 12 } },",
        "  imported: { fontSize: variables.small },",
        "  lit: { fontSize: light.fontScale.small },",
        "};",
      ].join("\n"),
    };
    const { reading, tokens, at } = await read(files, {
      textStyles: {
        "styles.nested": { size: 12, at: "src/theme.ts:14" },
        "styles.imported": { size: 12, at: "src/theme.ts:15" },
        "styles.lit": { size: 14, at: "src/theme.ts:16" },
      },
    });
    expect(reading.unconfirmed.map((u) => [u.reference, u.why])).toEqual([
      ["styles.nested", "no size is written there"],
      // `./sizes` computes it; `other.ts`'s `variables` isn't the one imported.
      ["styles.imported", "variables.small isn't defined once in the app as a number"],
    ]);
    // `light`'s, past a string with a brace in it, not `dark`'s.
    const lit = tokens?.typeStyles.find((s) => s.reference === "styles.lit")?.locations?.fontSize;
    expect([lit?.line, at(lit)]).toEqual([5, "14"]);
  });
});
