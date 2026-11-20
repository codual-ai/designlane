import { describe, expect, it } from "vitest";
import { FileTokensSchema, readApp } from "../../src/read/index.js";
import { kotlin, swift } from "../helpers/catalog.js";
import { appIn, SWIFT_APP } from "../helpers/read-apps.js";

/** An app whose users pick a theme, each with a light and a dark set of the same colors. */
const set = (name: string, scheme: string, tint: string) =>
  [
    `public struct ${name}: ColorSet {`,
    `  public var scheme: ColorScheme = .${scheme}`,
    `  public var tintColor: Color = ${tint}`,
    "  public init() {}",
    "}",
  ].join("\n");
const THEMES = swift(
  "public protocol ColorSet {",
  "  var scheme: ColorScheme { get }",
  "  var tintColor: Color { get set }",
  "}",
  set("OceanDark", "dark", ".init(hex: 0x101523)"),
  set("OceanLight", "light", ".init(hex: 0x3366CC)"),
  set("DesertDark", "dark", ".init(hex: 0x433744)"),
  set("DesertLight", "light", ".init(hex: 0xDF915E)"),
);

/** Each use as the text its span covers, its key, whether it's themed or unresolved, and its value. */
function uses(
  text: string,
  list: {
    token?: { key: string; themed?: true | undefined } | undefined;
    value: unknown;
    span: { start: number; end: number };
  }[],
) {
  return list.map((u) => [
    text.slice(u.span.start, u.span.end),
    u.token?.key,
    u.token?.themed ?? false,
    u.value,
  ]);
}

describe("tokensIn: colors read through a theme", () => {
  it("names a color the themes declare, read through a variable holding the picked theme, by its default value", async () => {
    const app = await readApp(await appIn({ "App/ColorSet.swift": THEMES }));
    const text = swift(
      "struct Card: View {",
      "  @Environment(\\.theme) var theme",
      "  var body: some View { Text(t).foregroundStyle(theme.tintColor).background(colors.tintColor.opacity(0.5)) }",
      "}",
    );
    const found = app.tokensIn("App/Card.swift", text);
    expect(FileTokensSchema.safeParse(found).success).toBe(true);
    expect(uses(text, found?.colors ?? [])).toEqual([
      ["theme.tintColor", "tintColor", true, "#3366cc"],
      ["colors.tintColor", "tintColor", true, "#3366cc"],
    ]);
  });

  it("takes neither a name standing alone nor a color only one theme has for a theme's", async () => {
    const themes = THEMES.replace(
      "  public var tintColor: Color = .init(hex: 0xDF915E)",
      "  public var tintColor: Color = .init(hex: 0xDF915E)\n  public var glow: Color = .init(hex: 0xFF0000)",
    );
    const app = await readApp(await appIn({ ...SWIFT_APP, "App/ColorSet.swift": themes }));
    const text = swift(
      "let tintColor = 1",
      "let a = settings.brand",
      "let b = button.tintColor",
      "let c = Color.tintColor",
      "let d = asset.tintColor",
      "let e = theme.glow",
    );
    expect(app.tokensIn("App/X.swift", text)?.colors).toEqual([]);
  });

  it("names what a theme declared outside the app holds, with no value", async () => {
    const reads = Array.from({ length: 3 }, (_, i) => `val c${i} = CompanyTheme.colors.primary`);
    const rel = "app/src/main/java/a/Home.kt";
    const text = kotlin(
      "@Composable fun Home() { Text(t, color = CompanyTheme.colors.primary, style = CompanyTheme.typography.title) }",
      "val gap = CompanyTheme.spacing.small",
      "val corner = CompanyTheme.shapes.medium",
      ...reads,
    );
    const app = await readApp(await appIn({ [rel]: text }));
    const found = app.tokensIn(rel);
    expect(FileTokensSchema.safeParse(found).success).toBe(true);
    expect(found?.colors.every((c) => c.token?.key === "CompanyTheme.colors.primary")).toBe(true);
    expect(found?.colors[0]).toMatchObject({
      token: { key: "CompanyTheme.colors.primary" },
      value: null,
      unresolved: true,
    });
    expect(found?.typeStyles[0]).toMatchObject({
      token: { key: "CompanyTheme.typography.title" },
      value: null,
      unresolved: true,
    });
  });
});
