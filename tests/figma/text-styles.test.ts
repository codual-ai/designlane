import { describe, expect, it } from "vitest";
import { plugin, styleNamed } from "../helpers/figma-plugin.js";
import { tokensJson } from "../helpers/tokens-json.js";

describe("syncing text styles into a Figma file", () => {
  it("creates no style whose font won't load, with a note, and syncs the rest", async () => {
    const app = plugin({ unloadable: ["SF Pro"] });
    const json = tokensJson({
      spacing: [8],
      styles: [{ key: "heading", size: 22, weight: 600 }],
    });
    expect(await app.sync(json)).toEqual([
      "Text/heading was left out: its font couldn't be loaded in this file.",
    ]);
    expect([app.fake.styles.size, app.fake.variables.size]).toEqual([0, 1]);
  });

  it("leaves out, by name, a style in a font this file doesn't have, rather than showing it new every time", async () => {
    const app = plugin({ fonts: { Inter: ["Regular"], "SF Pro": ["Regular"] } });
    const json = tokensJson({
      styles: [
        { key: "body", size: 17, weight: 400 },
        { key: "heading", size: 22, weight: 600 },
      ],
    });
    const plan = await app.plan(json);
    expect([plan.create, plan.missingFonts]).toEqual([
      ["Text/body"],
      ["Text/heading (SF Pro at weight 600)"],
    ]);
    expect(await app.apply()).toEqual([
      "Text/heading was left out: this file doesn't have SF Pro at weight 600.",
    ]);
    expect((await app.plan(json)).create).toEqual([]);
  });

  it("skips a style smaller than Figma allows, with a note", async () => {
    const app = plugin();
    const json = tokensJson({ styles: [{ key: "tiny", size: 0.5, weight: 400 }] });
    expect(await app.sync(json)).toEqual(["Text/tiny was left out: size 0.5 is smaller than Figma allows."]);
    expect(app.fake.styles.size).toBe(0);
  });

  it("keeps a style's weight, and leaves its font alone, when the code changes only its size", async () => {
    const app = plugin();
    await app.sync(tokensJson({ styles: [{ key: "title", size: 20, weight: 700 }] }));
    const style = styleNamed(app.fake, "Text/title");
    const fontSets = style.fontSets;
    await app.sync(tokensJson({ styles: [{ key: "title", size: 24 }] }));
    expect([style.fontName.style, style.fontSize, style.fontSets]).toEqual(["Bold", 24, fontSets]);
  });

  it("keeps a designer's italic when the code changes only the size", async () => {
    const app = plugin({ fonts: { "SF Pro": ["Regular", "Bold", "Bold Italic"] } });
    await app.sync(tokensJson({ styles: [{ key: "title", size: 20, weight: 700 }] }));
    const style = styleNamed(app.fake, "Text/title");
    await app.fake.api.loadFontAsync({ family: "SF Pro", style: "Bold Italic" });
    style.fontName = { family: "SF Pro", style: "Bold Italic" };
    await app.sync(tokensJson({ styles: [{ key: "title", size: 24, weight: 700 }] }));
    expect([style.fontName.style, style.fontSize]).toEqual(["Bold Italic", 24]);
  });

  it("leaves out at plan time a style whose own font this file doesn't have, when the code changes only its size", async () => {
    const app = plugin();
    await app.sync(tokensJson({ styles: [{ key: "title", size: 20, weight: 700 }] }));
    app.fake.removeFamily("SF Pro");
    const plan = await app.plan(tokensJson({ styles: [{ key: "title", size: 24 }] }));
    expect([plan.update, plan.missingFonts]).toEqual([[], ["Text/title (SF Pro)"]]);
  });

  it("leaves out a style renamed in the code when this file doesn't have its font", async () => {
    const app = plugin();
    await app.sync(tokensJson({ styles: [{ key: "title", size: 24, weight: 700 }] }));
    app.fake.removeFamily("SF Pro");
    const plan = await app.plan(tokensJson({ styles: [{ key: "heading", size: 24, weight: 700 }] }));
    expect([plan.rename, plan.missingFonts]).toEqual([[], ["Text/title (SF Pro at weight 700)"]]);
  });

  it("plans a size change for a style whose family has only its own weight", async () => {
    const app = plugin({ fonts: { "SF Pro": ["Black"] } });
    await app.sync(tokensJson({ styles: [{ key: "hero", size: 40, weight: 900 }] }));
    const plan = await app.plan(tokensJson({ styles: [{ key: "hero", size: 44 }] }));
    expect([plan.update, plan.missingFonts]).toEqual([["Text/hero"], []]);
  });

  it("leaves out a style whose font was removed between planning and applying, with a note", async () => {
    const app = plugin();
    await app.plan(tokensJson({ styles: [{ key: "heading", size: 22, weight: 600 }] }));
    app.fake.removeFamily("SF Pro");
    expect(await app.apply()).toEqual([
      "Text/heading was left out: this file doesn't have SF Pro at weight 600.",
    ]);
    expect(app.fake.styles.size).toBe(0);
  });

  it("gives a new style the iOS body size when the code works out its size while the app runs", async () => {
    const app = plugin();
    await app.sync(tokensJson({ styles: [{ key: "body", weight: 400 }] }));
    expect(styleNamed(app.fake, "Text/body").fontSize).toBe(17);
  });

  it("marks a dropped style deprecated in its description, never deleting it, and restores it", async () => {
    const app = plugin();
    const body = { key: "body", size: 17, weight: 400 };
    await app.sync(tokensJson({ styles: [body, { key: "title", size: 24, weight: 700 }] }));
    const title = styleNamed(app.fake, "Text/title");
    title.description = "Screen titles";
    await app.sync(tokensJson({ styles: [body] }));
    expect([app.fake.styles.size, title.description]).toEqual([
      2,
      "Deprecated: Designlane no longer finds this in the code.",
    ]);
    await app.sync(tokensJson({ styles: [body, { key: "title", size: 24, weight: 700 }] }));
    expect(title.description).toBe("Screen titles");
  });

  it("notes a style deleted between planning and applying, and carries on", async () => {
    const app = plugin();
    await app.sync(tokensJson({ styles: [{ key: "body", size: 17, weight: 400 }] }));
    await app.plan(tokensJson({ styles: [{ key: "body", size: 18, weight: 400 }] }));
    app.fake.styles.delete(styleNamed(app.fake, "Text/body").id);
    expect(await app.apply()).toEqual(["Text/body was left out: it was deleted after the plan was made."]);
  });

  it("makes no collection when the code has only text styles", async () => {
    const app = plugin();
    await app.sync(tokensJson({ styles: [{ key: "title", size: 20, weight: 700 }] }));
    expect(app.fake.collections.size).toBe(0);
  });
});
