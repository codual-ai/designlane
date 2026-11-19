import { describe, expect, it } from "vitest";
import { type AppView, readApp } from "../../src/read/index.js";
import { swift } from "../helpers/catalog.js";
import { appIn, RN_APP, SWIFT_APP } from "../helpers/read-apps.js";

const CARD = "App/CartRow.swift";
const THEME = "App/Theme.swift";
const colorsOf = (view: AppView) =>
  view.tokensIn(CARD)?.colors.map((c) => `${c.token?.key ?? "-"}=${c.value}`);

describe("withChanges: a view of the app with some files changed", () => {
  it("reads a changed file's new text, leaving the app as it was", async () => {
    const app = await readApp(await appIn(SWIFT_APP));
    const view = await app.withChanges({
      [CARD]: swift(
        "struct CartRow: View { var body: some View { Text(t).foregroundStyle(Color(white: 1)) } }",
      ),
    });
    expect(colorsOf(view)).toEqual(["-=#ffffff"]);
    expect(colorsOf(app)).toEqual(["brand=#3366e6"]);
  });

  it("names a token by the view's theme when a change redefines it", async () => {
    const app = await readApp(await appIn(SWIFT_APP));
    const view = await app.withChanges({
      [THEME]: SWIFT_APP[THEME].replace(
        "Color(red: 0.2, green: 0.4, blue: 0.9)",
        "Color(red: 1, green: 0, blue: 0)",
      ),
    });
    expect(colorsOf(view)).toEqual(["brand=#ff0000"]);
    expect(colorsOf(app)).toEqual(["brand=#3366e6"]);
  });

  it("drops a token the view's theme no longer declares, and adds one it newly declares", async () => {
    const app = await readApp(await appIn(SWIFT_APP));
    const theme = swift("extension Color { static let ink = Color(white: 0) }");
    const view = await app.withChanges({
      [THEME]: theme,
      [CARD]: swift("struct CartRow: View { var body: some View { Text(t).foregroundStyle(Color.ink) } }"),
    });
    expect(colorsOf(view)).toEqual(["ink=#000000"]);
    expect(view.tokensIn("App/Other.swift", swift("let c = Color.brand"))?.colors).toEqual([]);
  });

  it("reads a file the view adds and answers nothing for one it deletes", async () => {
    const app = await readApp(await appIn(RN_APP));
    const added = "src/Added.tsx";
    const view = await app.withChanges({
      [added]: 'import { colors } from "./theme";\nexport const a = colors.muted;',
      "src/CartRow.tsx": null,
    });
    expect(view.tokensIn(added)?.colors.map((c) => c.token?.key)).toEqual(["muted"]);
    expect(view.tokensIn("src/CartRow.tsx")).toBeUndefined();
    expect(app.tokensIn("src/CartRow.tsx")).toBeDefined();
  });

  it("reads eight hex digits opacity first once a view adds a helper that reads them so", async () => {
    const app = await readApp(await appIn(SWIFT_APP));
    const code = swift("let b = Color(hex: 0x803366CC)");
    expect(app.tokensIn("App/X.swift", code)?.colors.map((c) => c.value)).toEqual(["#803366cc"]);
    const view = await app.withChanges({
      "App/Hex.swift": swift(
        "extension Color { init(hex argb: UInt32) { let a = Double((argb & 0xFF000000) >> 24) / 255 } }",
      ),
    });
    expect(view.tokensIn("App/X.swift", code)?.colors.map((c) => c.value)).toEqual(["#3366cc80"]);
  });

  it("builds a view on a view, each keeping its own changes", async () => {
    const app = await readApp(await appIn(SWIFT_APP));
    const white = await app.withChanges({
      [CARD]: swift(
        "struct CartRow: View { var body: some View { Text(t).foregroundStyle(Color(white: 1)) } }",
      ),
    });
    const red = await white.withChanges({
      [THEME]: SWIFT_APP[THEME].replace(
        "Color(red: 0.2, green: 0.4, blue: 0.9)",
        "Color(red: 1, green: 0, blue: 0)",
      ),
    });
    expect(red.tokensIn("App/X.swift", swift("let c = Color.brand"))?.colors.map((c) => c.value)).toEqual([
      "#ff0000",
    ]);
    expect(colorsOf(red)).toEqual(["-=#ffffff"]);
    expect(white.tokensIn("App/X.swift", swift("let c = Color.brand"))?.colors.map((c) => c.value)).toEqual([
      "#3366e6",
    ]);
  });
});

describe("update: changing the app itself", () => {
  it("re-reads one file in place, as a file watcher sees an edit", async () => {
    const app = await readApp(await appIn(SWIFT_APP));
    await app.update(
      THEME,
      SWIFT_APP[THEME].replace("Color(red: 0.2, green: 0.4, blue: 0.9)", "Color(white: 0)"),
    );
    expect(colorsOf(app)).toEqual(["brand=#000000"]);
    await app.update(CARD, null);
    expect(app.tokensIn(CARD)).toBeUndefined();
  });
});
