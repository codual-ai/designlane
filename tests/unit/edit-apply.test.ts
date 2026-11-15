import { describe, expect, it } from "vitest";
import { editDiff } from "../../src/edit/diff.js";
import { applyEdit, planEdit } from "../../src/edit/plan.js";
import { type Files, plan, tokensFile } from "../helpers/edits.js";

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

  it("reads each file once however many checks look at it, as the Figma plugin reads over the network", async () => {
    const theme = "Theme.swift";
    const brand = "Color(red: 0.2, green: 0.4, blue: 0.9)";
    const ink = "Color(red: 0.1, green: 0.1, blue: 0.1)";
    const mist = "Color(red: 0.9, green: 0.9, blue: 0.9)";
    const swift: Files = {
      [theme]: `enum Theme {\n  static let brand = ${brand}\n  static let ink = ${ink}\n  static let mist = ${mist}\n}`,
    };
    const three = tokensFile(swift, {
      colors: [
        { key: "brand", light: "#3366e6", at: { light: { file: theme, text: brand, kind: "expression" } } },
        { key: "ink", light: "#1a1a1a", at: { light: { file: theme, text: ink, kind: "expression" } } },
        { key: "mist", light: "#e6e6e6", at: { light: { file: theme, text: mist, kind: "expression" } } },
      ],
    });
    const reads = new Map<string, number>();
    await planEdit(
      three,
      async (file) => {
        reads.set(file, (reads.get(file) ?? 0) + 1);
        return swift[file];
      },
      { token: "brand", property: "light", value: "#de2413" },
    );
    expect(reads.get(theme)).toBe(1);
  });
});
