import { describe, expect, it } from "vitest";
import { type AppView, readApp } from "../../src/read/index.js";
import { RN_MANIFEST, swift, tsx } from "../helpers/catalog.js";
import { appIn, SWIFT_APP } from "../helpers/read-apps.js";

const HEX_HELPER = swift(
  "extension Color { init(hex argb: UInt32) { let a = Double((argb & 0xFF000000) >> 24) / 255 } }",
);
const colors = (view: AppView, rel: string, text: string) =>
  view.tokensIn(rel, text)?.colors.map((c) => `${c.token?.key ?? "-"}=${c.value}`);

describe("withChanges: the tokens a view's changes redefine", () => {
  it("updates a token whose value is reached through a file the view changes", async () => {
    const app = await readApp(
      await appIn({
        ...RN_MANIFEST,
        "src/palette.ts": 'export const palette = { blue: "#3366ff" };',
        "src/theme.ts":
          'import { palette } from "./palette";\nexport const colors = { primary: palette.blue };',
        "src/Row.tsx": tsx('import { colors } from "./theme";', "export const c = colors.primary;"),
      }),
    );
    const view = await app.withChanges({ "src/palette.ts": 'export const palette = { blue: "#ff0000" };' });
    expect(view.tokensIn("src/Row.tsx")?.colors.map((c) => c.value)).toEqual(["#ff0000"]);
    expect(app.tokensIn("src/Row.tsx")?.colors.map((c) => c.value)).toEqual(["#3366ff"]);
  });

  it("reads a changed theme with the app's hex helper, though the view doesn't change the helper", async () => {
    const theme = (hex: string) => swift(`extension Color { static let glass = Color(hex: ${hex}) }`);
    const app = await readApp(
      await appIn({ "App/Hex.swift": HEX_HELPER, "App/Theme.swift": theme("0x803366CC") }),
    );
    const view = await app.withChanges({ "App/Theme.swift": theme("0x80FF0000") });
    expect(colors(view, "App/X.swift", swift("let c = Color.glass"))).toEqual(["glass=#ff000080"]);
  });

  it("stops reading hex digits opacity first once the view deletes the helper", async () => {
    const app = await readApp(await appIn({ ...SWIFT_APP, "App/Hex.swift": HEX_HELPER }));
    const code = swift("let b = Color(hex: 0x803366CC)");
    expect(colors(app, "App/X.swift", code)).toEqual(["-=#3366cc80"]);
    const view = await app.withChanges({ "App/Hex.swift": null });
    expect(colors(view, "App/X.swift", code)).toEqual(["-=#803366cc"]);
  });

  it("reads every hex colour the app names again when a view adds or deletes the helper", async () => {
    const files = {
      "App/Theme.swift": swift("extension Color { static let brand = Color(hex: 0x803366CC) }"),
    };
    const app = await readApp(await appIn(files));
    const use = swift("let c = Color.brand");
    expect(colors(app, "App/X.swift", use)).toEqual(["brand=#803366cc"]);
    const helped = await app.withChanges({ "App/Hex.swift": HEX_HELPER });
    expect(colors(helped, "App/X.swift", use)).toEqual(["brand=#3366cc80"]);
    const unhelped = await helped.withChanges({ "App/Hex.swift": null });
    expect(colors(unhelped, "App/X.swift", use)).toEqual(["brand=#803366cc"]);
  });

  it("reads a font family a changed file newly writes", async () => {
    const app = await readApp(await appIn(SWIFT_APP));
    const added = swift('let f = Font.custom("Lato-Bold", size: 12)');
    const view = await app.withChanges({ "App/New.swift": added });
    expect(view.tokensIn("App/New.swift")?.fonts.map((f) => f.value)).toEqual(["Lato"]);
  });

  it("reads an asset catalog colour the view adds", async () => {
    const app = await readApp(await appIn(SWIFT_APP));
    const asset = JSON.stringify({
      colors: [
        {
          color: {
            "color-space": "srgb",
            components: { red: "1.000", green: "0.000", blue: "0.000", alpha: "1.000" },
          },
        },
      ],
    });
    const view = await app.withChanges({ "App/Assets.xcassets/Alert.colorset/Contents.json": asset });
    expect(colors(view, "App/X.swift", swift('let c = Color("Alert")'))).toEqual(["Alert=#ff0000"]);
  });

  it("keeps the keys its base gave, though a new token takes a name one already has", async () => {
    const app = await readApp(await appIn(SWIFT_APP));
    const use = swift("let c = Color.brand");
    const view = await app.withChanges({
      "App/Palette.swift": swift("enum Palette { static let brand = Color(white: 0) }"),
    });
    expect(colors(app, "App/X.swift", use)).toEqual(["brand=#3366e6"]);
    expect(colors(view, "App/X.swift", use)).toEqual(["brand=#3366e6"]);
    expect(colors(view, "App/X.swift", swift("let c = Palette.brand"))).toEqual(["Palette-brand=#000000"]);
  });

  it("drops a font family once no text style the view has uses it", async () => {
    const app = await readApp(await appIn(SWIFT_APP));
    const named = swift('let f = Font.custom("Inter-Bold", size: 12)');
    expect(app.tokensIn("App/X.swift", named)?.fonts.map((f) => f.value)).toEqual(["Inter"]);
    const view = await app.withChanges({
      "App/Theme.swift": swift(
        "extension Color { static let brand = Color(red: 0.2, green: 0.4, blue: 0.9) }",
      ),
    });
    expect(view.tokensIn("App/X.swift", named)?.fonts).toEqual([]);
  });
});

describe("tokensIn and update", () => {
  it("doesn't take a font named inside a token's own definition for a use of it", async () => {
    const app = await readApp(await appIn(SWIFT_APP));
    expect(app.tokensIn("App/Theme.swift")?.fonts).toEqual([]);
  });

  it("keeps updating after one update fails", async () => {
    const app = await readApp(await appIn(SWIFT_APP));
    await expect(app.update("App/Bad.swift", 42 as unknown as string)).rejects.toThrow();
    await app.update("App/A.swift", swift("let a = Color.brand"));
    expect(app.tokensIn("App/A.swift")?.colors).toHaveLength(1);
  });

  it("lands two updates made at once", async () => {
    const app = await readApp(await appIn(SWIFT_APP));
    await Promise.all([
      app.update("App/A.swift", swift("let a = Color.brand")),
      app.update("App/B.swift", swift("let b = Color.brand")),
    ]);
    expect(app.tokensIn("App/A.swift")?.colors).toHaveLength(1);
    expect(app.tokensIn("App/B.swift")?.colors).toHaveLength(1);
  });
});
