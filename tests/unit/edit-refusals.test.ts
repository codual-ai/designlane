import { describe, expect, it } from "vitest";
import { type Files, outcome, plan, recolored, restyled, tokensFile } from "../helpers/edits.js";

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
      "refused: Changing muted's colour (theme.ts:1) would also change black-muted's colour. Give each its own value in the code first, or change it there by hand.",
    );
  });

  it("refuses a colour another colour is worked out from by its name", async () => {
    const files: Files = {
      "Color.kt": "val Brand = Color(0xFF112233)\nval Faded = Brand.copy(alpha = 0.5f)",
    };
    const tokens = tokensFile(files, {
      colors: [
        {
          key: "Brand",
          reference: "Brand",
          light: "#112233",
          at: { light: { file: "Color.kt", text: "Color(0xFF112233)", kind: "expression" } },
        },
        {
          key: "Faded",
          reference: "Faded",
          light: "#11223380",
          declared: { file: "Color.kt", text: "val Faded" },
        },
      ],
    });
    expect(outcome(await plan(files, tokens, { token: "Brand", property: "light", value: "#de2413" }))).toBe(
      "refused: Changing Brand's colour (Color.kt:1) would also change Faded's colour. Give each its own value in the code first, or change it there by hand.",
    );
    const unrelated = {
      ...files,
      "Color.kt": "val Brand = Color(0xFF112233)\nval Faded = Color(0x80112233)",
    };
    expect(
      outcome(await plan(unrelated, tokens, { token: "Brand", property: "light", value: "#de2413" })),
    ).toBe("Color(0xFFDE2413)");
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
