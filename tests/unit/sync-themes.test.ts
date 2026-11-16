import { describe, expect, it } from "vitest";
import { type DesignFile, planSync } from "../../src/sync/plan.js";
import { readTokensFile, type SyncColor, type SyncTokens } from "../../src/sync/tokens-file.js";
import { color, colorEntry, syncedFile, tokens, tokensOf } from "../helpers/sync-tokens.js";

describe("theme sets", () => {
  const THEMED = {
    "App/ColorSet.swift": [
      "import SwiftUI",
      "protocol ColorSet { var tint: Color { get } }",
      "struct MainLight: ColorSet { var tint: Color = Color(hex: 0x111111) }",
      "struct MainDark: ColorSet { var tint: Color = Color(hex: 0x222222) }",
      "struct DesertLight: ColorSet { var tint: Color = Color(hex: 0xdf915e) }",
      "struct DesertDark: ColorSet { var tint: Color = Color(hex: 0x433744) }",
    ].join("\n"),
  };
  const tint = (hex: string, dark?: string) =>
    color("color:ColorSet.tint", hex, { key: "tint", ...(dark ? { dark: { hex: dark, alpha: 1 } } : {}) });

  /** A design file as a first sync of `code` leaves it, its themes included. */
  function syncedThemes(code: SyncTokens): DesignFile {
    const themes = planSync(code, { variables: [], textStyles: [] }).themes.map(({ theme, variables }) => ({
      theme,
      variables: variables.create.map((token, i) => ({
        id: `${theme}/${token.identity}#${i}`,
        name: token.name,
        identity: token.identity,
        value: token.value,
        deprecated: false,
      })),
    }));
    return { ...syncedFile(code), themes };
  }

  it("reads each other theme apart, with the identity its colours have in the default theme", async () => {
    const read = await tokensOf(THEMED);
    const values = (colors: SyncColor[]) => colors.map((c) => [c.identity, c.light.hex, c.dark?.hex]);
    expect(values(read.colors)).toEqual([["color:ColorSet.tint", "#111111", "#222222"]]);
    expect(read.themes?.map((t) => [t.name, values(t.colors)])).toEqual([
      ["Desert", [["color:ColorSet.tint", "#df915e", "#433744"]]],
    ]);
  });

  it("reads a file written before themes as one with none, and one with only themes as not empty", () => {
    const desert = { color: { tint: colorEntry("#df915e", "ColorSet.tint") } };
    const theme = { desert: { $extensions: { designlane: { name: "Desert" } }, ...desert } };
    expect(readTokensFile({ $description: "old", ...desert }).themes).toBeUndefined();
    expect(readTokensFile({ $description: "themes", theme }).themes?.map((t) => t.name)).toEqual(["Desert"]);
    const empty = { desert: { $extensions: { designlane: { name: "Desert" } }, color: {} } };
    expect(() => readTokensFile({ $description: "empty", theme: empty })).toThrow(/has no tokens/);
  });

  it("matches a theme's colours only within that theme, though they share identities", () => {
    const code = tokens({
      colors: [tint("#111111")],
      themes: [{ name: "Desert", key: "Desert", colors: [tint("#df915e")] }],
    });
    const file = syncedThemes(code);
    const changed = tokens({
      colors: [tint("#111111")],
      themes: [{ name: "Desert", key: "Desert", colors: [tint("#ffffff")] }],
    });
    const plan = planSync(changed, file);
    expect([plan.variables.update, plan.variables.unchanged]).toEqual([[], 1]);
    expect(
      plan.themes.map((t) => [t.theme, t.variables.update.map((u) => u.id), t.variables.create]),
    ).toEqual([["Desert", ["Desert/color:ColorSet.tint#0"], []]]);
  });

  it("renames and deprecates within a theme, never pairing a colour gone from one with a new one in another", () => {
    const first = tokens({
      themes: [
        { name: "Desert", key: "Desert", colors: [color("color:Sand.old", "#df915e")] },
        { name: "Ocean", key: "Ocean", colors: [color("color:Sea.kept", "#000000")] },
      ],
    });
    const file = syncedThemes(first);
    const plan = planSync(
      tokens({
        themes: [
          { name: "Desert", key: "Desert", colors: [color("color:Sand.renamed", "#df915e")] },
          {
            name: "Ocean",
            key: "Ocean",
            colors: [color("color:Sea.kept", "#000000"), color("color:Sea.new", "#df915e")],
          },
        ],
      }),
      file,
    );
    const [desert, ocean] = plan.themes.map((t) => t.variables);
    expect(desert?.rename.map((r) => r.token.identity)).toEqual(["color:Sand.renamed"]);
    expect([desert?.deprecate, ocean?.rename, ocean?.create.map((c) => c.identity)]).toEqual([
      [],
      [],
      ["color:Sea.new"],
    ]);
  });

  it("deprecates the colours of a theme the code dropped, unless the scan missed part of the app", () => {
    const file = syncedThemes(
      tokens({ themes: [{ name: "Desert", key: "Desert", colors: [tint("#df915e")] }] }),
    );
    const gone = (complete: boolean) => planSync(tokens({ complete }), file).themes;
    expect(gone(true).map((t) => [t.theme, t.variables.deprecate.map((d) => d.name)])).toEqual([
      ["Desert", ["color/tint"]],
    ]);
    expect(gone(false).map((t) => t.variables.deprecate)).toEqual([[]]);
  });
});
