import { describe, expect, it } from "vitest";
import { editDiff } from "../../src/edit/diff.js";
import { applyEdit, type EditPlan } from "../../src/edit/plan.js";
import {
  type Files,
  linkAt,
  outcome,
  PALETTE,
  plan,
  recolored,
  restyled,
  tokensFile,
} from "../helpers/edits.js";

const edited = (files: Files, planned: EditPlan) => {
  if (!planned.ok) throw new Error(planned.reason);
  return applyEdit(files[planned.edit.file] ?? "", planned.edit);
};

describe("a colour reached through a name", () => {
  it("takes its own value in place of the name, quoted as the value is, so the name's other users keep theirs", async () => {
    const tokens = tokensFile(PALETTE, {
      colors: [
        { key: "link", light: "#bfe1ff", at: { light: linkAt(0) } },
        { key: "surface", light: "#bfe1ff", at: { light: linkAt(1) } },
        {
          key: "blue0",
          light: "#bfe1ff",
          at: { light: { file: "src/colors.ts", text: "#BFE1FF", kind: "literal" } },
        },
      ],
    });
    const planned = await plan(PALETTE, tokens, { token: "link", property: "light", value: "#de2413" });
    expect(edited(PALETTE, planned)).toContain("light: { link: '#DE2413', surface: colors.blue0 }");
    const palette = await plan(PALETTE, tokens, { token: "blue0", property: "light", value: "#de2413" });
    expect(edited(PALETTE, palette)).toContain("blue0: '#DE2413'");
  });

  it("takes a Compose colour in place of the constant a scheme names, and an Android link's", async () => {
    const files: Files = {
      "Color.kt": "val Purple40 = Color(0xFF6650A4)\nval Light = lightColorScheme(primary = Purple40)",
      "res/values/colors.xml":
        '<color name="blue600">#3366CC</color>\n<color name="accent">@color/blue600</color>',
    };
    const tokens = tokensFile(files, {
      colors: [
        {
          key: "primary",
          light: "#6650a4",
          at: {
            light: {
              file: "Color.kt",
              text: "Color(0xFF6650A4)",
              kind: "expression",
              via: [{ file: "Color.kt", text: "Purple40", nth: 1 }],
            },
          },
        },
        {
          key: "accent",
          light: "#3366cc",
          at: {
            light: {
              file: "res/values/colors.xml",
              text: "#3366CC",
              kind: "literal",
              via: [{ file: "res/values/colors.xml", text: "@color/blue600" }],
            },
          },
        },
      ],
    });
    const primary = await plan(files, tokens, { token: "primary", property: "light", value: "#de2413" });
    expect(edited(files, primary)).toContain("lightColorScheme(primary = Color(0xFFDE2413))");
    const accent = await plan(files, tokens, { token: "accent", property: "light", value: "#de2413" });
    expect(edited(files, accent)).toContain('<color name="accent">#DE2413</color>');
  });

  it("refuses a name in another language from its value", async () => {
    const files: Files = {
      "res/values/colors.xml": '<color name="accent">#3366CC</color>',
      "Theme.kt": "val Light = lightColorScheme(tertiary = colorResource(R.color.accent))",
    };
    const via = [{ file: "Theme.kt", text: "R.color.accent" }];
    const at = { file: "res/values/colors.xml", text: "#3366CC", kind: "literal" as const, via };
    const tokens = tokensFile(files, { colors: [{ key: "tertiary", light: "#3366cc", at: { light: at } }] });
    expect(
      outcome(await plan(files, tokens, { token: "tertiary", property: "light", value: "#de2413" })),
    ).toMatch(/refused: .*another language/);
  });

  it("refuses a text style's value that comes from a style it builds on", async () => {
    const files: Files = {
      "Type.kt": "val Body = TextStyle(fontSize = 14.sp)\nval Large = Body.copy(fontWeight = Bold)",
    };
    const at = {
      file: "Type.kt",
      text: "14.sp",
      kind: "expression" as const,
      via: [{ file: "Type.kt", text: "Body", nth: 1 }],
    };
    const tokens = tokensFile(files, { styles: [{ key: "Large", size: 14, at: { fontSize: at } }] });
    expect(outcome(await plan(files, tokens, { token: "Large", property: "size", value: "16" }))).toMatch(
      /refused: it comes from `Body`/,
    );
  });
});

describe("refusing what can't be rewritten safely", () => {
  it("refuses a value another token writes in the same place", async () => {
    const files: Files = { "theme.ts": "const dark = { muted: '#999999' }; const black = { ...dark };" };
    const at = { light: { file: "theme.ts", text: "999999", kind: "literal" as const } };
    const tokens = tokensFile(files, {
      colors: [
        { key: "muted", light: "#999999", at },
        { key: "black-muted", light: "#999999", at },
      ],
    });
    expect(outcome(await plan(files, tokens, { token: "muted", property: "light", value: "#de2413" }))).toBe(
      "refused: muted's colour is written where black-muted's colour is (theme.ts:1), so changing it changes both. Give it its own value in the code first, or change it there by hand.",
    );
  });

  it("refuses a font's name holding the weight, and a family declared elsewhere", async () => {
    const code = 'const title = { fontFamily: "Inter-Bold", fontSize: 17 };';
    const name = { text: "Inter-Bold", kind: "family-name" as const };
    expect(await restyled("weight", "theme.ts", code, name, 700, "600")).toMatch(
      /refused: .*part of a font's name/,
    );
    const kotlin = "val Title = TextStyle(fontFamily = Inter)";
    const identifier = { text: "Inter", kind: "identifier" as const };
    expect(await restyled("family", "Type.kt", kotlin, identifier, "Inter", "Roboto")).toMatch(
      /refused: .*elsewhere/,
    );
  });

  it("refuses a named colour, a computed one, and a call it can't read whole", async () => {
    const expression = (text: string) => ({ text, kind: "expression" as const });
    const named = "static let ink: Color = .black";
    expect(await recolored("Theme.swift", named, expression(".black"), "#000000", "#de2413")).toMatch(
      /refused: Designmap can't safely rewrite `.black`/,
    );
    const faded = "static let ink = Color(hex: 0x112233).opacity(0.5)";
    expect(
      await recolored(
        "Theme.swift",
        faded,
        expression("Color(hex: 0x112233).opacity(0.5)"),
        "#112233",
        "#de2413",
      ),
    ).toMatch(/can't safely rewrite/);
    const white = "static let ink = Color(white: 0.5)";
    expect(
      await recolored("Theme.swift", white, expression("Color(white: 0.5)"), "#808080", "#de2413"),
    ).toMatch(/can't safely rewrite/);
  });

  it("refuses an opacity a notation without one can't hold", async () => {
    const code = "val Brand = Color(red = 34, green = 131, blue = 248)";
    const call = { text: "Color(red = 34, green = 131, blue = 248)", kind: "expression" as const };
    expect(await recolored("Color.kt", code, call, "#2283f8", "#de241380")).toMatch(
      /refused: .*can't hold #de241380/,
    );
  });
});

describe("finding the token", () => {
  const files: Files = {
    "Theme.swift": "let a = Color(hex: 0x3366CC)\nlet b = Color(hex: 0x112233)\nlet c = Color(hex: 0x445566)",
  };
  const at = (text: string) => ({ light: { file: "Theme.swift", text, kind: "expression" as const } });
  const tokens = tokensFile(files, {
    colors: [
      {
        key: "brand",
        reference: "Theme.brand",
        light: "#3366cc",
        dark: "#112233",
        at: at("Color(hex: 0x3366CC)"),
      },
      { key: "ink", reference: "Theme.ink", light: "#112233", at: at("Color(hex: 0x112233)") },
      { key: "hex-abcdef", light: "#abcdef" },
    ],
    themes: {
      Desert: [{ key: "brand", reference: "Theme.brand", light: "#445566", at: at("Color(hex: 0x445566)") }],
    },
    styles: [{ key: "title", size: 17 }],
  });
  const change = (token: string, property: "light" | "dark" | "size" = "light") => ({
    token,
    property,
    value: "#de2413",
  });

  it("finds a colour by its key, then by how the code refers to it, and a theme's by its theme", async () => {
    expect(outcome(await plan(files, tokens, change("ink")))).toBe("Color(hex: 0xDE2413)");
    expect(outcome(await plan(files, tokens, change("Theme.ink")))).toBe("Color(hex: 0xDE2413)");
    expect(outcome(await plan(files, tokens, change("Desert/brand")))).toBe("Color(hex: 0xDE2413)");
    expect(outcome(await plan(files, tokens, change("Theme.brand")))).toBe(
      "refused: Theme.brand could be any of 2 tokens (brand, Desert/brand); name it by its key.",
    );
  });

  it("says plainly what's missing", async () => {
    expect(outcome(await plan(files, tokens, change("teal")))).toBe("refused: tokens.json has no teal.");
    expect(outcome(await plan(files, tokens, change("brand", "dark")))).toMatch(
      /refused: tokens.json doesn't say where brand's dark colour is written/,
    );
    expect(outcome(await plan(files, tokens, change("ink", "dark")))).toBe(
      "refused: tokens.json gives ink no dark colour.",
    );
    expect(outcome(await plan(files, tokens, { token: "ink", property: "light", value: "red" }))).toMatch(
      /refused: `red` isn't a colour like #ff8800/,
    );
    expect(outcome(await plan(files, tokens, { token: "ink", property: "light", value: "#112233" }))).toBe(
      "refused: ink's colour is already #112233.",
    );
    const size = { text: "17", kind: "literal" as const };
    expect(await restyled("size", "theme.ts", "const t = { fontSize: 17 };", size, 17, "-3")).toMatch(
      /refused: `-3` isn't a size/,
    );
  });

  it("throws for a file Designmap didn't write", async () => {
    await expect(plan(files, { color: { brand: { $value: 1 } } }, change("brand"))).rejects.toThrow(
      /isn't a tokens.json Designmap writes/,
    );
  });
});

describe("applying an edit and showing it", () => {
  const asset = '{\n  "alpha" : "1.000",\n  "blue" : "0.137",\n  "green" : "0.855",\n  "red" : "0.075"\n}';
  const rel = "Assets.xcassets/Brand.colorset/Contents.json";
  const files: Files = { [rel]: `{"colors":[{"color":{"components":${asset}}}]}` };
  const tokens = tokensFile(files, {
    colors: [
      { key: "Brand", light: "#13da23", at: { light: { file: rel, text: asset, kind: "components" } } },
    ],
  });

  it("diffs only the lines that change", async () => {
    const planned = await plan(files, tokens, { token: "Brand", property: "light", value: "#de2413" });
    if (!planned.ok) throw new Error(planned.reason);
    expect(editDiff(files[rel] ?? "", planned.edit)).toBe(
      [
        `--- a/${rel}`,
        `+++ b/${rel}`,
        "@@ -3,3 +3,3 @@",
        '-  "blue" : "0.137",',
        '-  "green" : "0.855",',
        '-  "red" : "0.075"',
        '+  "blue" : "0.075",',
        '+  "green" : "0.141",',
        '+  "red" : "0.871"',
      ].join("\n"),
    );
  });

  it("refuses to apply an edit to text that changed since it was planned", async () => {
    const planned = await plan(files, tokens, { token: "Brand", property: "light", value: "#de2413" });
    if (!planned.ok) throw new Error(planned.reason);
    expect(() => applyEdit("{}", planned.edit)).toThrow(/changed since the edit was planned/);
  });
});
