import { describe, expect, it } from "vitest";
import { modeNamed, onlyCollection, plugin, rgb, variableNamed } from "../helpers/figma-plugin.js";
import { tokensJson } from "../helpers/tokens-json.js";

describe("syncing variables into a Figma file", () => {
  it("records the code reference as iOS code syntax and description, and scopes each variable by its kind", async () => {
    const app = plugin();
    await app.sync(tokensJson({ colors: [{ key: "surface", hex: "#18191c" }], spacing: [8], radii: [12] }));
    const surface = variableNamed(app.fake, "color/surface");
    expect([surface.codeSyntax, surface.description]).toEqual([
      { iOS: "Theme.surface" },
      "In the code: Theme.surface",
    ]);
    expect([
      surface.scopes,
      variableNamed(app.fake, "spacing/8").scopes,
      variableNamed(app.fake, "radius/12").scopes,
    ]).toEqual([["FRAME_FILL", "SHAPE_FILL", "TEXT_FILL", "STROKE_COLOR"], ["GAP"], ["CORNER_RADIUS"]]);
  });

  it("records an Android app's code reference as Android code syntax, dropping an iOS one it wrote before", async () => {
    const app = plugin();
    await app.sync(tokensJson({ colors: [{ key: "surface", hex: "#18191c" }] }));
    await app.sync(tokensJson({ colors: [{ key: "surface", hex: "#1c2333" }], platform: "android" }));
    expect(variableNamed(app.fake, "color/surface").codeSyntax).toEqual({ ANDROID: "Theme.surface" });
  });

  it("keeps the variable, and the name a designer gave it, for a token renamed in the code", async () => {
    const app = plugin();
    await app.sync(tokensJson({ colors: [{ key: "surface", hex: "#18191c" }] }));
    const surface = variableNamed(app.fake, "color/surface");
    surface.name = "bg/surface";
    const plan = await app.plan(tokensJson({ colors: [{ key: "background", hex: "#18191c" }] }));
    expect(plan.rename).toEqual([{ from: "bg/surface", to: "Theme.background" }]);
    await app.apply();
    expect([app.fake.variables.size, surface.name, surface.codeSyntax, surface.description]).toEqual([
      1,
      "bg/surface",
      { iOS: "Theme.background" },
      "In the code: Theme.background",
    ]);
  });

  it("clears the code syntax and description of a token the code no longer names", async () => {
    const app = plugin();
    await app.sync(tokensJson({ colors: [{ key: "surface", hex: "#18191c" }] }));
    const surface = variableNamed(app.fake, "color/surface");
    await app.sync(tokensJson({ colors: [{ key: "surface", hex: "#18191c", named: false }] }));
    expect([app.fake.variables.size, surface.codeSyntax, surface.description]).toEqual([1, {}, ""]);
  });

  it("names its collection after the app, and groups colours the code doesn't name", async () => {
    const app = plugin();
    await app.sync(
      tokensJson({ app: "shop", colors: [{ key: "hex-33a854", hex: "#33a854", named: false }] }),
    );
    expect([onlyCollection(app.fake).name, [...app.fake.variables.values()].map((v) => v.name)]).toEqual([
      "Shop (Designlane)",
      ["color/Unnamed/33a854"],
    ]);
  });

  it("updates a changed colour in place and keeps the name a designer gave it", async () => {
    const app = plugin();
    await app.sync(tokensJson({ colors: [{ key: "surface", hex: "#18191c" }] }));
    const surface = variableNamed(app.fake, "color/surface");
    surface.name = "bg/surface";
    expect((await app.plan(tokensJson({ colors: [{ key: "surface", hex: "#1a1b1e" }] }))).update).toEqual([
      "bg/surface",
    ]);
    await app.apply();
    expect(app.fake.variables.size).toBe(1);
    expect(surface.valuesByMode[modeNamed(app.fake, "Light")]).toEqual(rgb("#1a1b1e"));
  });

  it("keeps a description and publishing choice a designer made", async () => {
    const app = plugin();
    await app.sync(tokensJson({ colors: [{ key: "ink", hex: "#111111" }] }));
    const ink = variableNamed(app.fake, "color/ink");
    ink.description = "Body text on light surfaces";
    ink.hiddenFromPublishing = true;
    await app.sync(tokensJson({ colors: [{ key: "ink", hex: "#222222" }] }));
    expect([ink.description, ink.hiddenFromPublishing]).toEqual(["Body text on light surfaces", true]);
  });

  it("marks a dropped token deprecated, never deleting it, and restores it when the code has it again", async () => {
    const app = plugin();
    await app.sync(tokensJson({ spacing: [8, 54] }));
    await app.sync(tokensJson({ spacing: [8] }));
    const spacing54 = variableNamed(app.fake, "spacing/54");
    const state = () => [
      spacing54.getSharedPluginData("designmap", "deprecated"),
      spacing54.hiddenFromPublishing,
    ];
    expect(state()).toEqual(["true", true]);
    expect((await app.plan(tokensJson({ spacing: [8, 54] }))).restore).toEqual(["spacing/54"]);
    await app.apply();
    expect(state()).toEqual(["", false]);
  });

  it("gives a token back the description and publishing choice it had when it returns to the code", async () => {
    const app = plugin();
    await app.sync(tokensJson({ spacing: [8, 54] }));
    const spacing54 = variableNamed(app.fake, "spacing/54");
    spacing54.description = "Hero padding";
    spacing54.hiddenFromPublishing = true;
    await app.sync(tokensJson({ spacing: [8] }));
    expect(spacing54.description).toBe("Deprecated: Designlane no longer finds this in the code.");
    await app.sync(tokensJson({ spacing: [8, 54] }));
    expect([spacing54.description, spacing54.hiddenFromPublishing]).toEqual(["Hero padding", true]);
  });

  it("writes dark values to its Dark mode, never to a mode a designer added", async () => {
    const app = plugin();
    await app.sync(tokensJson({ colors: [{ key: "bg", hex: "#ffffff", dark: "#000000" }] }));
    const brand = onlyCollection(app.fake).addMode("Brand");
    const bg = variableNamed(app.fake, "color/bg");
    bg.setValueForMode(brand, rgb("#ff0000"));
    await app.sync(tokensJson({ colors: [{ key: "bg", hex: "#eeeeee", dark: "#111111" }] }));
    expect(onlyCollection(app.fake).modes.map((mode) => mode.name)).toEqual(["Light", "Dark", "Brand"]);
    expect(bg.valuesByMode[modeNamed(app.fake, "Dark")]).toEqual(rgb("#111111"));
    expect(bg.valuesByMode[brand]).toEqual(rgb("#ff0000"));
  });

  it("adds its Dark mode back rather than writing into a mode a designer added in its place", async () => {
    const app = plugin();
    await app.sync(tokensJson({ colors: [{ key: "bg", hex: "#ffffff", dark: "#000000" }] }));
    const collection = onlyCollection(app.fake);
    collection.removeMode(modeNamed(app.fake, "Dark"));
    const brand = collection.addMode("Brand");
    const bg = variableNamed(app.fake, "color/bg");
    bg.setValueForMode(brand, rgb("#ff0000"));
    await app.sync(tokensJson({ colors: [{ key: "bg", hex: "#ffffff", dark: "#111111" }] }));
    expect(collection.modes.map((mode) => mode.name)).toEqual(["Light", "Brand", "Dark"]);
    expect([bg.valuesByMode[brand], bg.valuesByMode[modeNamed(app.fake, "Dark")]]).toEqual([
      rgb("#ff0000"),
      rgb("#111111"),
    ]);
  });

  it("adds its Light mode back when a designer deleted it", async () => {
    const app = plugin();
    await app.sync(tokensJson({ colors: [{ key: "bg", hex: "#ffffff", dark: "#000000" }] }));
    const collection = onlyCollection(app.fake);
    collection.removeMode(modeNamed(app.fake, "Light"));
    const plan = await app.plan(tokensJson({ colors: [{ key: "bg", hex: "#ffffff", dark: "#000000" }] }));
    expect(plan.update).toEqual(["color/bg"]);
    await app.apply();
    const bg = variableNamed(app.fake, "color/bg");
    expect(collection.modes.map((mode) => mode.name)).toEqual(["Dark", "Light"]);
    expect([
      bg.valuesByMode[modeNamed(app.fake, "Light")],
      bg.valuesByMode[modeNamed(app.fake, "Dark")],
    ]).toEqual([rgb("#ffffff"), rgb("#000000")]);
  });

  it("finds nothing to change for a dark value that is the light one", async () => {
    const app = plugin();
    const json = tokensJson({ colors: [{ key: "bg", hex: "#ffffff", dark: "#FFFFFF" }] });
    await app.sync(json);
    expect((await app.plan(json)).unchanged).toBe(1);
  });

  it("finds a number a designer changed in its Dark mode", async () => {
    const app = plugin();
    const json = tokensJson({ colors: [{ key: "bg", hex: "#ffffff", dark: "#000000" }], spacing: [8] });
    await app.sync(json);
    variableNamed(app.fake, "spacing/8").setValueForMode(modeNamed(app.fake, "Dark"), 9);
    expect((await app.plan(json)).update).toEqual(["spacing/8"]);
  });

  it("when the Figma plan allows one mode, leaves dark values out with a note, and finds nothing else to change", async () => {
    const app = plugin({ maxModes: 1 });
    const json = tokensJson({ colors: [{ key: "bg", hex: "#ffffff", dark: "#000000" }] });
    expect(await app.sync(json)).toEqual([
      'Dark values weren\'t added: the collection "Designlane" has as many modes as this Figma plan allows.',
    ]);
    const again = await app.plan(json);
    expect([again.update, again.unchanged, again.darkLeftOut, again.applicable]).toEqual([[], 1, true, true]);
    expect(await app.apply()).toEqual([
      'Dark values weren\'t added: the collection "Designlane" has as many modes as this Figma plan allows.',
    ]);
  });

  it("on a full collection, finds nothing to do for dark values that are the light ones", async () => {
    const app = plugin({ maxModes: 1 });
    await app.sync(tokensJson({ colors: [{ key: "ink", hex: "#111111", dark: "#000000" }] }));
    const plan = await app.plan(tokensJson({ colors: [{ key: "ink", hex: "#111111", dark: "#111111" }] }));
    expect([plan.darkLeftOut, plan.applicable]).toEqual([false, false]);
  });

  it("adds the Dark mode once a full collection has room again, then fills it in", async () => {
    const app = plugin({ maxModes: 2 });
    await app.sync(tokensJson({ spacing: [8] }));
    const brand = onlyCollection(app.fake).addMode("Brand");
    const json = tokensJson({ colors: [{ key: "bg", hex: "#ffffff", dark: "#000000" }], spacing: [8] });
    expect(await app.sync(json)).toEqual([
      'Dark values weren\'t added: the collection "Designlane" has as many modes as this Figma plan allows.',
    ]);
    onlyCollection(app.fake).removeMode(brand);
    expect((await app.plan(json)).darkLeftOut).toBe(true);
    expect(await app.apply()).toEqual([
      "Dark mode added. Pick tokens.json again to fill in the dark values.",
    ]);
    expect((await app.plan(json)).update).toEqual(["color/bg"]);
    expect(await app.apply()).toEqual([]);
    expect(variableNamed(app.fake, "color/bg").valuesByMode[modeNamed(app.fake, "Dark")]).toEqual(
      rgb("#000000"),
    );
  });

  it("reads a variable pointing at another in its own collection in the same mode", async () => {
    const app = plugin();
    const json = tokensJson({
      colors: [
        { key: "ink", hex: "#111111", dark: "#eeeeee" },
        { key: "black", hex: "#000000", dark: "#eeeeee" },
      ],
    });
    await app.sync(json);
    const black = variableNamed(app.fake, "color/black");
    variableNamed(app.fake, "color/ink").setValueForMode(modeNamed(app.fake, "Dark"), {
      type: "VARIABLE_ALIAS",
      id: black.id,
    });
    expect((await app.plan(json)).unchanged).toBe(2);
  });

  it("reads a variable pointing into another collection in that collection's default mode", async () => {
    const app = plugin();
    const json = tokensJson({ colors: [{ key: "ink", hex: "#111111" }] });
    await app.sync(json);
    const palette = app.fake.api.variables.createVariableCollection("Palette");
    const black = app.fake.api.variables.createVariable("black", palette, "COLOR");
    black.setValueForMode(palette.defaultModeId, rgb("#111111"));
    variableNamed(app.fake, "color/ink").setValueForMode(modeNamed(app.fake, "Light"), {
      type: "VARIABLE_ALIAS",
      id: black.id,
    });
    expect((await app.plan(json)).unchanged).toBe(1);
  });

  it("plans an update, not new variables, for variables that point at each other", async () => {
    const app = plugin();
    const json = tokensJson({
      colors: [
        { key: "ink", hex: "#111111" },
        { key: "black", hex: "#000000" },
      ],
    });
    await app.sync(json);
    const ink = variableNamed(app.fake, "color/ink");
    const black = variableNamed(app.fake, "color/black");
    const light = modeNamed(app.fake, "Light");
    ink.setValueForMode(light, { type: "VARIABLE_ALIAS", id: black.id });
    black.setValueForMode(light, { type: "VARIABLE_ALIAS", id: ink.id });
    const plan = await app.plan(json);
    expect([[...plan.update].sort(), plan.create]).toEqual([["color/black", "color/ink"], []]);
  });

  it("stops with a clear message when its Light mode was deleted and the collection has no room to add it back", async () => {
    const app = plugin({ maxModes: 2 });
    const json = tokensJson({ colors: [{ key: "bg", hex: "#ffffff", dark: "#000000" }] });
    await app.sync(json);
    const collection = onlyCollection(app.fake);
    collection.removeMode(modeNamed(app.fake, "Light"));
    collection.addMode("Brand");
    await app.plan(json);
    await app.session({ type: "apply", id: 2 });
    expect(app.last()).toEqual({
      type: "error",
      message:
        "The sync stopped partway. Pick tokens.json again to see what is left. (The Designlane collection's Light mode was deleted, and this Figma plan can't add it back. Delete a mode from the collection, then sync again.)",
    });
  });

  it("rewrites a variable pointing at a deleted one rather than adding a new one", async () => {
    const app = plugin();
    const json = tokensJson({ colors: [{ key: "ink", hex: "#111111" }] });
    await app.sync(json);
    const ink = variableNamed(app.fake, "color/ink");
    const light = modeNamed(app.fake, "Light");
    ink.setValueForMode(light, { type: "VARIABLE_ALIAS", id: "VariableID:gone" });
    const plan = await app.plan(json);
    expect([plan.update, plan.create]).toEqual([["color/ink"], []]);
    await app.apply();
    expect(ink.valuesByMode[light]).toEqual(rgb("#111111"));
  });

  it("notes variables deleted between planning and applying, and carries on", async () => {
    const app = plugin();
    await app.sync(tokensJson({ colors: [{ key: "ink", hex: "#111111" }], spacing: [8, 16] }));
    await app.plan(tokensJson({ colors: [{ key: "ink", hex: "#222222" }], spacing: [16] }));
    for (const name of ["color/ink", "spacing/8"])
      app.fake.variables.delete(variableNamed(app.fake, name).id);
    expect(await app.apply()).toEqual([
      "color/ink was left out: it was deleted after the plan was made.",
      "spacing/8 was left out: it was deleted after the plan was made.",
    ]);
  });
});
