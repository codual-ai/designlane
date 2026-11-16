import { describe, expect, it } from "vitest";
import { drawDesignSystemPage } from "../../figma-plugin/src/page.js";
import type { FakeNode } from "../helpers/fake-figma.js";
import { plugin, styleNamed, variableNamed } from "../helpers/figma-plugin.js";
import { tokensJson } from "../helpers/tokens-json.js";

type App = ReturnType<typeof plugin>;

const pages = (app: App) => app.fake.root.children;

/** The frame Designlane drew on its page. */
function sheetOf(app: App): FakeNode {
  const [page] = pages(app);
  const [sheet] =
    page?.findAllWithCriteria({ sharedPluginData: { namespace: "designmap", keys: ["sheet"] } }) ?? [];
  if (!sheet) throw new Error("no sheet drawn");
  return sheet;
}

const texts = (node: FakeNode) =>
  node.descendants().flatMap((child) => (child.type === "TEXT" ? [String(child.characters)] : []));

describe("the design system page", () => {
  it("is named after the app, with a swatch linked to each colour's variable in Light and in Dark", async () => {
    const app = plugin();
    await app.sync(
      tokensJson({ app: "shop", colors: [{ key: "surface", hex: "#18191c", dark: "#ffffff" }] }),
    );
    expect(pages(app).map((page) => page.name)).toEqual(["Shop (Designlane)"]);
    const surface = variableNamed(app.fake, "color/surface");
    const chips = sheetOf(app)
      .descendants()
      .filter((node) => JSON.stringify(node.fills ?? []).includes(surface.id));
    const [collection] = app.fake.collections.values();
    const modes = chips.map((chip) => collection && chip.explicitModes[collection.id]);
    expect(modes.map((id) => collection?.modes.find((mode) => mode.modeId === id)?.name)).toEqual([
      "Light",
      "Dark",
    ]);
    expect(texts(sheetOf(app))).toEqual(
      expect.arrayContaining(["color/surface", "Theme.surface", "#18191c / #ffffff"]),
    );
  });

  it("shows a sample of each text style in that style, and spacing and radius smallest first", async () => {
    const app = plugin();
    await app.sync(
      tokensJson({ spacing: [16, 8], radii: [12], styles: [{ key: "title", size: 24, weight: 700 }] }),
    );
    const title = styleNamed(app.fake, "Text/title");
    const samples = sheetOf(app)
      .descendants()
      .filter((node) => node.textStyleId === title.id);
    expect(samples.map((node) => node.characters)).toEqual(["The quick brown fox jumps over the lazy dog"]);
    const labels = texts(sheetOf(app));
    expect(labels.indexOf("spacing/8")).toBeLessThan(labels.indexOf("spacing/16"));
    const box = sheetOf(app)
      .descendants()
      .find((node) => node.cornerRadius === 12);
    expect(box?.type).toBe("RECTANGLE");
  });

  it("shows one swatch for a colour that looks the same in Dark", async () => {
    const app = plugin();
    await app.sync(
      tokensJson({
        colors: [
          { key: "bg", hex: "#ffffff", dark: "#000000" },
          { key: "ink", hex: "#111111" },
        ],
      }),
    );
    const ink = variableNamed(app.fake, "color/ink");
    const chips = sheetOf(app)
      .descendants()
      .filter((node) => JSON.stringify(node.fills ?? []).includes(ink.id));
    expect(chips.length).toBe(1);
    expect(texts(sheetOf(app))).toContain("#111111");
  });

  it("shows text styles largest first", async () => {
    const app = plugin();
    await app.sync(
      tokensJson({
        styles: [
          { key: "body", size: 17, weight: 400 },
          { key: "title", size: 28, weight: 700 },
        ],
      }),
    );
    const labels = texts(sheetOf(app)).filter((label) => label.startsWith("Text/"));
    expect(labels).toEqual(["Text/title  SF Pro Bold 28", "Text/body  SF Pro Regular 17"]);
  });

  it("leaves out tokens the code dropped", async () => {
    const app = plugin();
    await app.sync(tokensJson({ spacing: [8, 54] }));
    await app.sync(tokensJson({ spacing: [8] }));
    expect(texts(sheetOf(app))).not.toContain("spacing/54");
  });

  it("redraws only its own frame, where a designer moved it, keeping what a designer added", async () => {
    const app = plugin();
    await app.sync(tokensJson({ spacing: [8] }));
    sheetOf(app).x = 500;
    const [page] = pages(app);
    const note = app.fake.api.createText();
    page?.appendChild(note);
    await app.sync(tokensJson({ spacing: [8, 16] }));
    expect(page?.children.includes(note)).toBe(true);
    expect(page?.children.length).toBe(2);
    expect(sheetOf(app).x).toBe(500);
    expect(texts(sheetOf(app))).toContain("spacing/16");
  });

  it("finds its page again after a designer renames it", async () => {
    const app = plugin();
    await app.sync(tokensJson({ spacing: [8] }));
    const [page] = pages(app);
    if (page) page.name = "Tokens";
    await app.sync(tokensJson({ spacing: [8, 16] }));
    expect(pages(app).map((each) => each.name)).toEqual(["Tokens"]);
  });

  it("keeps the sheet in the section a designer moved it into", async () => {
    const app = plugin();
    await app.sync(tokensJson({ spacing: [8] }));
    const [page] = pages(app);
    const group = app.fake.api.createFrame();
    page?.appendChild(group);
    group.appendChild(sheetOf(app));
    await app.sync(tokensJson({ spacing: [8, 16] }));
    const sheets = page?.findAllWithCriteria({
      sharedPluginData: { namespace: "designmap", keys: ["sheet"] },
    });
    expect([sheets?.length, sheets?.[0]?.parent === group]).toEqual([1, true]);
  });

  it("shows the value a variable points at, when a designer links it to another", async () => {
    const app = plugin();
    await app.sync(tokensJson({ colors: [{ key: "ink", hex: "#111111" }], spacing: [8] }));
    const palette = app.fake.api.variables.createVariableCollection("Palette");
    const black = app.fake.api.variables.createVariable("black", palette, "COLOR");
    black.setValueForMode(palette.defaultModeId, { r: 0, g: 0, b: 0, a: 1 });
    const twelve = app.fake.api.variables.createVariable("twelve", palette, "FLOAT");
    twelve.setValueForMode(palette.defaultModeId, 12);
    const [collection] = app.fake.collections.values();
    const light = collection?.defaultModeId ?? "";
    variableNamed(app.fake, "color/ink").setValueForMode(light, { type: "VARIABLE_ALIAS", id: black.id });
    variableNamed(app.fake, "spacing/8").setValueForMode(light, { type: "VARIABLE_ALIAS", id: twelve.id });
    // Drawn straight away: a sync would first write the code's values over the links.
    await drawDesignSystemPage(undefined);
    expect(texts(sheetOf(app))).toContain("#000000");
    const squares = sheetOf(app)
      .descendants()
      .filter((node) => node.type === "RECTANGLE");
    expect(squares.map((square) => square.width)).toEqual([12]);
  });

  it("notes a style whose font this file can't load, without a sample", async () => {
    const unloadable: string[] = [];
    const app = plugin({ unloadable });
    await app.sync(tokensJson({ styles: [{ key: "title", size: 24, weight: 700 }] }));
    unloadable.push("SF Pro");
    await app.sync(tokensJson({ styles: [{ key: "title", size: 24, weight: 700 }], spacing: [8] }));
    expect(texts(sheetOf(app))).toContain("This file doesn't have the font to show a sample.");
    expect(texts(sheetOf(app))).not.toContain("The quick brown fox jumps over the lazy dog");
  });

  it("draws only text styles when the code has no variables", async () => {
    const app = plugin();
    await app.sync(tokensJson({ styles: [{ key: "title", size: 24, weight: 700 }] }));
    expect(texts(sheetOf(app))).not.toContain("Colours");
    expect(texts(sheetOf(app))).toContain("Typography");
  });

  it("keeps the last sheet, and says so, when drawing fails, leaving nothing half-drawn", async () => {
    const app = plugin();
    await app.sync(tokensJson({ spacing: [8] }));
    app.fake.api.createRectangle = () => {
      throw new Error("Figma is unavailable");
    };
    const notes = await app.sync(tokensJson({ spacing: [8, 16] }));
    expect(notes).toEqual([
      "The variables and text styles are synced, but the design system page couldn't be redrawn. (Figma is unavailable)",
    ]);
    const [page] = pages(app);
    expect(page?.children.length).toBe(1);
    expect(texts(sheetOf(app))).not.toContain("spacing/16");
  });

  it("leaves out a value it can't read, such as a link to a deleted variable", async () => {
    const app = plugin();
    await app.sync(tokensJson({ spacing: [8, 16] }));
    const [collection] = app.fake.collections.values();
    variableNamed(app.fake, "spacing/8").setValueForMode(collection?.defaultModeId ?? "", {
      type: "VARIABLE_ALIAS",
      id: "VariableID:gone",
    });
    // A sync rewrites such a value before drawing; the page still never draws what it can't read.
    await drawDesignSystemPage(undefined);
    expect(texts(sheetOf(app))).toEqual(expect.arrayContaining(["spacing/16"]));
    expect(texts(sheetOf(app))).not.toContain("spacing/8");
  });

  it("leaves no page behind when the first drawing fails", async () => {
    const app = plugin();
    app.fake.api.createRectangle = () => {
      throw new Error("Figma is unavailable");
    };
    await app.sync(tokensJson({ spacing: [8] }));
    expect(pages(app)).toEqual([]);
  });

  it("keeps the last sheet when the new one can't take its place", async () => {
    const app = plugin();
    await app.sync(tokensJson({ spacing: [8] }));
    const [page] = pages(app);
    if (page) {
      // Refuse only the new sheet taking the old one's place, not its first drawing.
      const insert = page.insertChild.bind(page);
      page.insertChild = (index, child) => {
        if (child.getSharedPluginData("designmap", "sheet") === "true")
          throw new Error("can't move it there");
        insert(index, child);
      };
    }
    await app.sync(tokensJson({ spacing: [8, 16] }));
    const sheets = page?.findAllWithCriteria({
      sharedPluginData: { namespace: "designmap", keys: ["sheet"] },
    });
    expect(sheets?.length).toBe(1);
    expect(texts(sheetOf(app))).not.toContain("spacing/16");
  });

  it("shows only the sections the code has", async () => {
    const app = plugin();
    await app.sync(tokensJson({ spacing: [8] }));
    const labels = texts(sheetOf(app));
    expect(["Colours", "Spacing", "Radius", "Typography"].filter((title) => labels.includes(title))).toEqual([
      "Spacing",
    ]);
  });

  it("leaves no page behind when drawing can't even start", async () => {
    const app = plugin({ unloadable: ["Inter"] });
    const notes = await app.sync(tokensJson({ spacing: [8] }));
    expect(pages(app)).toEqual([]);
    expect(notes).toEqual([
      "The variables and text styles are synced, but the design system page couldn't be redrawn. (could not load Inter)",
    ]);
  });

  it("keeps a sheet placed freely inside an auto-layout frame where the designer put it", async () => {
    const app = plugin();
    await app.sync(tokensJson({ spacing: [8] }));
    const [page] = pages(app);
    const board = app.fake.api.createFrame();
    board.layoutMode = "VERTICAL";
    page?.appendChild(board);
    const sheet = sheetOf(app);
    board.appendChild(sheet);
    sheet.layoutPositioning = "ABSOLUTE";
    sheet.x = 300;
    await app.sync(tokensJson({ spacing: [8, 16] }));
    expect([sheetOf(app).parent === board, sheetOf(app).layoutPositioning, sheetOf(app).x]).toEqual([
      true,
      "ABSOLUTE",
      300,
    ]);
  });
});
