import { describe, expect, it } from "vitest";
import { type Files, outcome, plan, restyled, tokensFile } from "../helpers/edits.js";

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
