import { readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../../src/cli/run.js";
import { type Files, tokensFile } from "../helpers/edits.js";
import { tempDir } from "../helpers/temp.js";

const THEME = "Shop/Theme.swift";
const APP: Files = { [THEME]: "enum Theme {\n  static let brand = Color(hex: 0x3366CC)\n}" };
const TOKENS = tokensFile(APP, {
  colors: [
    {
      key: "brand",
      reference: "Theme.brand",
      light: "#3366cc",
      at: { light: { file: THEME, text: "Color(hex: 0x3366CC)", kind: "expression" } },
    },
  ],
});
const DIFF = [
  `--- a/${THEME}`,
  `+++ b/${THEME}`,
  "@@ -2,1 +2,1 @@",
  "-  static let brand = Color(hex: 0x3366CC)",
  "+  static let brand = Color(hex: 0xDE2413)",
].join("\n");

async function designlane(...argv: string[]) {
  const out: string[] = [];
  const error: string[] = [];
  const code = await run(argv, { out: (t) => out.push(t), error: (t) => error.push(t) });
  return { code, out: out.join("\n"), error: error.join("\n") };
}

async function app(tokensName = "tokens.json", tokens: unknown = TOKENS) {
  return tempDir({ ...APP, [`designlane/${tokensName}`]: JSON.stringify(tokens) });
}

describe("designlane edit", () => {
  it("prints the diff and writes nothing with --dry-run", async () => {
    const root = await app();
    const { code, out } = await designlane(
      "edit",
      "Theme.brand",
      "light",
      "#de2413",
      "--dir",
      root,
      "--dry-run",
    );
    expect(code).toBe(0);
    expect(out).toBe(DIFF);
    expect(await readFile(path.join(root, THEME), "utf8")).toBe(APP[THEME]);
  });

  it("writes the edit without --dry-run", async () => {
    const root = await app();
    const { code } = await designlane("edit", "brand", "light", "#de2413", "--dir", root);
    expect(code).toBe(0);
    expect(await readFile(path.join(root, THEME), "utf8")).toContain("Color(hex: 0xDE2413)");
  });

  it("says why it refuses, and exits 1", async () => {
    const root = await app();
    const { code, error } = await designlane("edit", "brand", "dark", "#de2413", "--dir", root);
    expect(code).toBe(1);
    expect(error).toBe("designlane: tokens.json gives brand no dark colour.");
  });

  it("refuses an unknown property, and a missing value", async () => {
    const root = await app();
    expect(await designlane("edit", "brand", "colour", "#de2413", "--dir", root)).toMatchObject({
      code: 2,
      error: expect.stringContaining("colour isn't a property: use light, dark, family, size, weight"),
    });
    expect((await designlane("edit", "brand", "light", "--dir", root)).code).toBe(2);
  });

  it("finds one app's tokens file, and asks which when there are two", async () => {
    const one = await app("tokens.ios.json");
    expect((await designlane("edit", "brand", "light", "#de2413", "--dir", one, "--dry-run")).out).toBe(DIFF);
    const two = await tempDir({
      ...APP,
      "designlane/tokens.ios.json": JSON.stringify(TOKENS),
      "designlane/tokens.android.json": JSON.stringify(TOKENS),
    });
    const { code, error } = await designlane("edit", "brand", "light", "#de2413", "--dir", two);
    expect(code).toBe(2);
    expect(error).toContain("name the app's with --tokens");
    const named = path.join(two, "designlane", "tokens.ios.json");
    const chosen = await designlane(
      "edit",
      "brand",
      "light",
      "#de2413",
      "--dir",
      two,
      "--tokens",
      named,
      "--dry-run",
    );
    expect(chosen.out).toBe(DIFF);
    const relative = await designlane(
      "edit",
      "brand",
      "light",
      "#de2413",
      "--dir",
      two,
      "--tokens",
      "designlane/tokens.ios.json",
      "--dry-run",
    );
    expect(relative.out).toBe(DIFF);
  });

  it("says when a file is too large to read", async () => {
    const root = await app();
    await writeFile(path.join(root, THEME), `${APP[THEME]}\n${"// padding\n".repeat(60_000)}`);
    const { code, error } = await designlane("edit", "brand", "light", "#de2413", "--dir", root);
    expect(code).toBe(1);
    expect(error).toBe(
      `designlane: Designlane can't read ${THEME}: it's over 512 KB, more than it reads as source.`,
    );
  });

  it("never reads a file outside the app, through a symlink or a path", async () => {
    const outside = await tempDir({ "Theme.swift": APP[THEME] ?? "" });
    const root = await tempDir({ "designlane/tokens.json": JSON.stringify(TOKENS) });
    await symlink(outside, path.join(root, "Shop"));
    const linked = await designlane("edit", "brand", "light", "#de2413", "--dir", root);
    expect(linked).toMatchObject({ code: 1, error: `designlane: ${THEME} isn't in the app any more.` });
    const escaping = JSON.parse(
      JSON.stringify(TOKENS).replaceAll(THEME, `../${path.basename(outside)}/Theme.swift`),
    );
    const parent = await app("tokens.json", escaping);
    expect((await designlane("edit", "brand", "light", "#de2413", "--dir", parent)).error).toMatch(
      /isn.t in the app any more/,
    );
  });

  it("says so when the app has no tokens file", async () => {
    const root = await tempDir(APP);
    expect(await designlane("edit", "brand", "light", "#de2413", "--dir", root)).toMatchObject({
      code: 1,
      error: expect.stringContaining("no designlane/tokens.json"),
    });
  });
});
