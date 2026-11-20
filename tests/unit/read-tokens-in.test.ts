import { describe, expect, it } from "vitest";
import { type FileTokens, FileTokensSchema, readApp } from "../../src/read/index.js";
import { kotlin, swift, tsx } from "../helpers/catalog.js";
import { appIn, COMPOSE_APP, RN_APP, SWIFT_APP } from "../helpers/read-apps.js";

/** Each use as the text its span covers, with its token's key (or `-` for a value written in place). */
const written = (
  text: string,
  uses: { token?: { key: string } | undefined; span: { start: number; end: number } }[],
) => uses.map((u) => `${u.token?.key ?? "-"}:${text.slice(u.span.start, u.span.end)}`);

async function read(files: Record<string, string>, rel: string) {
  const app = await readApp(await appIn(files));
  const text = files[rel] ?? "";
  const found = app.tokensIn(rel) as FileTokens;
  expect(FileTokensSchema.safeParse(found).success).toBe(true);
  return { app, text, found };
}

describe("tokensIn: the values one file uses", () => {
  it("reads SwiftUI's named tokens and values written in place, each span exactly what's written", async () => {
    const rel = "App/Card.swift";
    const { text, found } = await read(
      {
        ...SWIFT_APP,
        [rel]: swift(
          "struct Card: View {",
          "  var body: some View {",
          "    Text(t).font(.brandTitle).foregroundStyle(Color.brand).padding(12)",
          "      .background(Color(red: 1, green: 0, blue: 0)).font(.system(size: 15, weight: .semibold))",
          "      .cornerRadius(8)",
          "  }",
          "}",
        ),
      },
      rel,
    );
    expect(written(text, found.colors)).toEqual(["brand:Color.brand", "-:Color(red: 1, green: 0, blue: 0)"]);
    expect(found.colors.map((c) => c.value)).toEqual(["#3366e6", "#ff0000"]);
    expect(written(text, found.typeStyles)).toEqual([
      "brandTitle:.brandTitle",
      "-:.system(size: 15, weight: .semibold)",
    ]);
    expect(found.typeStyles[1]?.value).toEqual({ size: 15, weight: 600 });
    expect(written(text, found.fonts)).toEqual(["brandTitle:.brandTitle"]);
    expect(found.fonts[0]?.value).toBe("Inter");
    expect(written(text, found.spacing)).toEqual(["-:12"]);
    expect(written(text, found.radii)).toEqual(["-:8"]);
    expect(found.colors[0]?.span).toMatchObject({ file: rel, line: 4 });
  });

  it("leaves out a token's own definition and anything in comments", async () => {
    const { found } = await read(
      {
        ...SWIFT_APP,
        "App/Theme.swift": `${SWIFT_APP["App/Theme.swift"]}\n// Color(red: 0, green: 1, blue: 0).font(.system(size: 9))`,
      },
      "App/Theme.swift",
    );
    expect(found.colors).toEqual([]);
    expect(found.typeStyles).toEqual([]);
  });

  it("doesn't take a token's own declaration for a use of it", async () => {
    const rel = "app/src/main/java/a/ui/theme/Color.kt";
    const { found } = await read(COMPOSE_APP, rel);
    expect(found.colors).toEqual([]);
  });

  it("reads Compose's named tokens and values written in place", async () => {
    const rel = "app/src/main/java/a/cart/Badge.kt";
    const { text, found } = await read(
      {
        ...COMPOSE_APP,
        [rel]: kotlin(
          "@Composable fun Badge() {",
          "  Text(t, color = Brand, style = Title, fontSize = 12.sp)",
          "  Box(Modifier.background(Color(0xFFFF0000)).padding(8.dp).clip(RoundedCornerShape(4.dp)))",
          "}",
        ),
      },
      rel,
    );
    expect(written(text, found.colors)).toEqual(["Brand:Brand", "-:Color(0xFFFF0000)"]);
    expect(written(text, found.typeStyles)).toEqual(["Title:Title", "-:12.sp"]);
    expect(written(text, found.spacing)).toEqual(["-:8.dp"]);
    expect(written(text, found.radii)).toEqual(["-:4.dp"]);
  });

  it("reads React Native's named tokens, colours in strings, style numbers and font names", async () => {
    const rel = "src/Badge.tsx";
    const { text, found } = await read(
      {
        ...RN_APP,
        [rel]: tsx(
          'import { colors } from "./theme";',
          "export const Badge = () => (",
          '  <View style={{ backgroundColor: colors.primary, borderColor: "#ff0000", padding: 8, borderRadius: 4 }}>',
          '    <Text style={{ fontFamily: "Inter-Bold", fontSize: 13 }}>{t}</Text>',
          "  </View>",
          ");",
        ),
      },
      rel,
    );
    expect(written(text, found.colors)).toEqual(["primary:colors.primary", "-:#ff0000"]);
    expect(written(text, found.spacing)).toEqual(["-:8"]);
    expect(written(text, found.radii)).toEqual(["-:4"]);
    expect(written(text, found.typeStyles)).toEqual(["-:13"]);
    expect(found.fonts.map((f) => f.value)).toEqual(["Inter"]);
  });

  it("names a colour every theme has by the app's own theme, and reads eight hex digits as the app's helper does", async () => {
    const set = (name: string, scheme: string, tint: string) =>
      `public struct ${name}: ColorSet {\n  public var scheme: ColorScheme = .${scheme}\n  public var tintColor: Color = ${tint}\n  public init() {}\n}`;
    const app = await readApp(
      await appIn({
        "App/ColorSet.swift": swift(
          "public protocol ColorSet { var scheme: ColorScheme { get }\n var tintColor: Color { get set } }",
          set("OceanDark", "dark", ".init(hex: 0x101523)"),
          set("OceanLight", "light", ".init(hex: 0x3366CC)"),
          set("DesertDark", "dark", ".init(hex: 0x433744)"),
          set("DesertLight", "light", ".init(hex: 0xDF915E)"),
        ),
        "App/Hex.swift": swift(
          "extension Color { init(hex argb: UInt32) { let a = Double((argb & 0xFF000000) >> 24) / 255 } }",
        ),
      }),
    );
    const found = app.tokensIn(
      "App/Card.swift",
      swift("let a = ColorSet.tintColor", "let b = Color(hex: 0x803366CC)"),
    );
    expect(found?.colors.map((c) => [c.token?.key, c.token?.theme, c.value])).toEqual([
      ["tintColor", undefined, "#3366cc"],
      [undefined, undefined, "#3366cc80"],
    ]);
  });

  it("writes every colour one way: lowercase, with opacity only when it isn't full", async () => {
    const app = await readApp(
      await appIn({
        ...RN_APP,
        "src/theme.ts": 'export const colors = { a: "#3366FF", b: "#3366ffff", c: "#3366ff80", d: "#ABC" };',
      }),
    );
    const found = app.tokensIn(
      "src/X.tsx",
      'export const x = [colors.a, colors.b, colors.c, colors.d, "#FFFFFFFF"];',
    );
    expect(found?.colors.map((c) => c.value)).toEqual([
      "#3366ff",
      "#3366ff",
      "#3366ff80",
      "#aabbcc",
      "#ffffff",
    ]);
    expect(
      FileTokensSchema.safeParse({ ...found, colors: [{ ...found?.colors[0], value: "#3366ffff" }] }).success,
    ).toBe(false);
  });

  it("reads text given in place of the file's, giving the same answer for the same text", async () => {
    const app = await readApp(await appIn(SWIFT_APP));
    const variant = swift(
      "struct Card: View { var body: some View { Text(t).foregroundStyle(Color.brand) } }",
    );
    const first = app.tokensIn("App/Elsewhere.swift", variant);
    expect(first?.colors.map((c) => c.token?.key)).toEqual(["brand"]);
    expect(JSON.stringify(app.tokensIn("App/Elsewhere.swift", variant))).toBe(JSON.stringify(first));
  });

  it("answers nothing for a file that isn't code of one of the app's frameworks", async () => {
    const app = await readApp(await appIn(SWIFT_APP));
    expect(app.tokensIn("README.md", "# Shop")).toBeUndefined();
    expect(app.tokensIn("App/Missing.swift")).toBeUndefined();
  });
});
