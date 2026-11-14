import { describe, expect, it } from "vitest";
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

describe("refusing when the code changed since the scan", () => {
  const files: Files = { "colors.ts": "const a = '#3366CC';" };
  const tokens = tokensFile(files, {
    colors: [
      {
        key: "Brand",
        light: "#3366cc",
        at: { light: { file: "colors.ts", text: "#3366CC", kind: "literal" } },
      },
    ],
  });
  const change = { token: "Brand", property: "light" as const, value: "#de2413" };

  it("refuses a value that's no longer the one tokens.json has", async () => {
    expect(outcome(await plan({ "colors.ts": "const a = '#3366CD';" }, tokens, change))).toBe(
      "refused: colors.ts:1 now reads `#3366CD`: the code changed since designmap last ran. Run designmap again.",
    );
  });

  it("refuses a value moved to another line, and a file that's gone", async () => {
    expect(outcome(await plan({ "colors.ts": "\nst a = '#3366CC';" }, tokens, change))).toMatch(
      /refused: colors.ts:1 has changed/,
    );
    expect(outcome(await plan({}, tokens, change))).toBe("refused: colors.ts isn't in the app any more.");
  });
});

describe("refusing a value the code changed around", () => {
  it("refuses a span that's now part of a longer value, or has a call after it", async () => {
    const files: Files = { "theme.ts": "const t = { fontSize: 17 };" };
    const tokens = tokensFile(files, {
      styles: [
        { key: "Title", size: 17, at: { fontSize: { file: "theme.ts", text: "17", kind: "literal" } } },
      ],
    });
    const grown = await plan({ "theme.ts": "const t = { fontSize: 170 };" }, tokens, {
      token: "Title",
      property: "size",
      value: "24",
    });
    expect(outcome(grown)).toMatch(/refused: theme.ts:1 now reads `17`: the code changed/);
    const swift = "static let ink = Color(hex: 0x112233)";
    const colors = tokensFile(
      { "T.swift": swift },
      {
        colors: [
          {
            key: "ink",
            light: "#112233",
            at: { light: { file: "T.swift", text: "Color(hex: 0x112233)", kind: "expression" } },
          },
        ],
      },
    );
    const chained = await plan({ "T.swift": `${swift}.opacity(0.5)` }, colors, {
      token: "ink",
      property: "light",
      value: "#de2413",
    });
    expect(outcome(chained)).toMatch(/the code changed/);
  });

  it("refuses a colour whose name now names another value", async () => {
    const tokens = tokensFile(PALETTE, {
      colors: [{ key: "link", light: "#bfe1ff", at: { light: linkAt(0) } }],
    });
    const renamed = {
      "src/colors.ts": (PALETTE["src/colors.ts"] ?? "").replace("link: colors.blue0", "link: colors.gray1"),
    };
    expect(
      outcome(await plan(renamed, tokens, { token: "link", property: "light", value: "#de2413" })),
    ).toMatch(/refused: src\/colors.ts:3 has changed/);
  });

  it("refuses a hex number the code works out, a CSS channel with decimals, and an opacity that changed", async () => {
    const expression = (text: string) => ({ text, kind: "expression" as const });
    const offset = "static let ink = Color(hex: 0x112233 + offset)";
    expect(
      await recolored("T.swift", offset, expression("Color(hex: 0x112233 + offset)"), "#112233", "#de2413"),
    ).toMatch(/can't safely rewrite/);
    const css = ":root { --ink: rgb(0.0, 0.0, 0.0); }";
    const literal = { text: "rgb(0.0, 0.0, 0.0)", kind: "literal" as const };
    expect(await recolored("theme.css", css, literal, "#000000", "#ff0000")).toMatch(/can't safely rewrite/);
    const faded = 'const a = "rgba(34, 131, 248, 0.2)";';
    const rgba = { text: "rgba(34, 131, 248, 0.2)", kind: "literal" as const };
    expect(await recolored("colors.ts", faded, rgba, "#2283f880", "#de2413")).toMatch(/the code changed/);
  });

  it("refuses a value the code now works out, but not one a comment follows", async () => {
    const size = (code: string) =>
      restyled("size", "theme.ts", code, { text: "17", kind: "literal" }, 17, "24");
    expect(await size("const t = { fontSize: 17 * 2 };")).toMatch(/the code changed/);
    expect(await size("const t = { fontSize: base + 17 };")).toMatch(/the code changed/);
    expect(await size("const t = { fontSize: 17 // body\n};")).toBe("24");
    expect(await size("const t = { fontSize: /* body */ 17 };")).toBe("24");
  });

  it("refuses a size too large to write", async () => {
    const code = "val Title = TextStyle(fontSize = 22.sp)";
    const at = { text: "22.sp", kind: "expression" as const };
    expect(await restyled("size", "Type.kt", code, at, 22, "9".repeat(310))).toMatch(/isn't a size/);
  });

  it("writes more decimals when the code's can't hold the new colour", async () => {
    const asset = '{ "red" : "0.0", "green" : "0.0", "blue" : "0.0" }';
    const rel = "Assets.xcassets/Ink.colorset/Contents.json";
    expect(await recolored(rel, asset, { text: asset, kind: "components" }, "#000000", "#010101")).toBe(
      '{ "red" : "0.004", "green" : "0.004", "blue" : "0.004" }',
    );
  });
});
