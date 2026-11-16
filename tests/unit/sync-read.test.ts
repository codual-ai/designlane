import { describe, expect, it } from "vitest";
import { scanRepo, toDesignTokens } from "../../src/index.js";
import { readTokensFile, type SyncTokens } from "../../src/sync/tokens-file.js";
import { APP, colorEntry, tokensOf } from "../helpers/sync-tokens.js";
import { tempDir } from "../helpers/temp.js";

describe("reading tokens.json", () => {
  it("reads each token with the identity a sync tracks it by", async () => {
    const read = await tokensOf(APP);
    expect(read.colors.map((c) => [c.identity, c.light])).toEqual([
      ["color:Theme.brand", { hex: "#3366e6", alpha: 1 }],
      ["color:Theme.glass", { hex: "#ff0000", alpha: 0.502 }],
      ["color:accent@App/Home.swift", { hex: "#008000", alpha: 1 }],
    ]);
    expect(read.textStyles).toEqual([
      {
        identity: "type:Font.heading|heading",
        key: "heading",
        value: { family: "SF Pro", size: 22, weight: 600 },
        reference: "Font.heading",
      },
    ]);
    // Spacing and radii the code writes in place are DESIGN.md's, not a sync's.
    expect([read.spacing, read.radii]).toEqual([[], []]);
  });

  it("gives a file-local colour the same identity whether or not another file has one of that name", async () => {
    const alone = await tokensOf(APP);
    const withAnother = await tokensOf({
      ...APP,
      "App/Other.swift": "import SwiftUI\nlet accent = Color(red: 1, green: 1, blue: 0)",
    });
    expect(alone.colors.find((c) => c.key === "accent")?.identity).toBe("color:accent@App/Home.swift");
    expect(withAnother.colors.map((c) => c.identity)).toEqual(
      expect.arrayContaining(["color:accent@App/Home.swift", "color:accent@App/Other.swift"]),
    );
  });

  it("tells apart two colours one file declares under the same name, in declaration order", () => {
    const read = readTokensFile({
      $description: "test",
      color: {
        accent: colorEntry("#111111", "accent", "A.swift", 4),
        "accent-2": colorEntry("#222222", "accent", "A.swift", 9),
      },
    });
    expect(read.colors.map((c) => c.identity)).toEqual(["color:accent@A.swift", "color:accent@A.swift#2"]);
  });

  it("keeps two same-named colours' identities when one's value changes and their keys swap", () => {
    const identityOf = (json: object, hex: string) =>
      readTokensFile({ $description: "test", ...json }).colors.find((c) => c.light.hex === hex)?.identity;
    const before = {
      color: {
        accent: colorEntry("#111111", "accent", "A.swift", 4),
        "accent-2": colorEntry("#999999", "accent", "A.swift", 9),
      },
    };
    const after = {
      color: {
        accent: colorEntry("#999999", "accent", "A.swift", 9),
        "accent-2": colorEntry("#aaaaaa", "accent", "A.swift", 4),
      },
    };
    expect(identityOf(after, "#999999")).toBe(identityOf(before, "#999999"));
    expect(identityOf(after, "#aaaaaa")).toBe(identityOf(before, "#111111"));
  });

  it("keeps each size of a font helper its own identity when another size changes", async () => {
    const appUsing = (sizes: number[]) => ({
      "App/Fonts.swift":
        "import SwiftUI\nextension Font { static func app(size: CGFloat, weight: Font.Weight) -> Font { .system(size: size, weight: weight) } }",
      "App/Home.swift": `import SwiftUI\nstruct Home: View { var body: some View { VStack { ${sizes
        .map((n) => `Text(t).font(.app(size: ${n}, weight: .bold))`)
        .join("\n")} } } }`,
    });
    const identityOfSize = (read: SyncTokens, size: number) =>
      read.textStyles.find((s) => s.value.size === size)?.identity;
    const before = await tokensOf(appUsing([15, 20]));
    const after = await tokensOf(appUsing([25, 20]));
    expect(identityOfSize(after, 20)).toBe(identityOfSize(before, 20));
    expect(identityOfSize(after, 25)).not.toBe(identityOfSize(before, 15));
  });

  it("knows when the scan couldn't read the whole app", async () => {
    const scan = await scanRepo(await tempDir(APP));
    const read = (s: typeof scan) => readTokensFile(JSON.parse(JSON.stringify(toDesignTokens(s))));
    expect(read(scan).complete).toBe(true);
    expect(read({ ...scan, unreadable: ["Locked"] }).complete).toBe(false);
    expect(read({ ...scan, truncated: true }).complete).toBe(false);
  });

  it("refuses a file shaped otherwise, or with no tokens, rather than deprecating everything", () => {
    expect(() => readTokensFile({ swiftui: {}, compose: {} })).toThrow(
      /^This isn't a tokens\.json Designlane writes/,
    );
    expect(() => readTokensFile({ $description: "empty", color: {} })).toThrow(
      /has no tokens\. Run designlane/,
    );
  });

  it("syncs an app whose code names nothing, unless the scan missed part of it", () => {
    const empty = (partial: boolean) => ({
      $description: "test",
      $extensions: { designlane: { app: "Shop", ...(partial ? { partial: true } : {}) } },
    });
    expect(readTokensFile(empty(false))).toMatchObject({ colors: [], textStyles: [], complete: true });
    expect(() => readTokensFile(empty(true))).toThrow(/has no tokens\. Run designlane/);
  });

  it("refuses a token Designlane wouldn't write, naming it and saying what to do", () => {
    const refusal = (file: object) => () => readTokensFile({ $description: "test", ...file });
    const say = (path: string) =>
      new RegExp(`Run designlane on the app again[\\s\\S]*${path.replace(".", "\\.")}`);
    expect(refusal({ color: { brand: { $type: "color", $value: "blue" } } })).toThrow(say("color.brand"));
    expect(refusal({ color: { brand: "blue" } })).toThrow(say("color"));
    const ext = { designlane: { name: "empty", uses: 1 } };
    expect(refusal({ typography: { empty: { $extensions: ext } } })).toThrow(say("typography.empty"));
    const tooOpaque = { colorSpace: "srgb", components: [0, 0, 0], hex: "#000000", alpha: 2 };
    const ink = {
      $type: "color",
      $value: tooOpaque,
      $extensions: { designlane: { source: "A.swift", uses: 1 } },
    };
    expect(refusal({ color: { ink } })).toThrow(say("color.ink"));
    const darkOnStyle = { designlane: { name: "s", uses: 1, modes: { dark: tooOpaque } } };
    expect(
      refusal({
        typography: { s: { $extensions: darkOnStyle, fontWeight: { $type: "fontWeight", $value: 400 } } },
      }),
    ).toThrow(say("typography.s"));
  });
});
