import { describe, expect, it } from "vitest";
import { plugin, rgb } from "../helpers/figma-plugin.js";
import { tokensJson } from "../helpers/tokens-json.js";

type Fake = ReturnType<typeof plugin>["fake"];

/** The collection named `name`, with its variables by name and its modes by name. */
function collectionNamed(fake: Fake, name: string) {
  const collection = [...fake.collections.values()].find((c) => c.name === name);
  if (!collection) throw new Error(`no collection ${name}`);
  const variables = collection.variableIds.flatMap((id) => fake.variables.get(id) ?? []);
  const mode = (modeName: string) => collection.modes.find((m) => m.name === modeName)?.modeId ?? "";
  return { collection, variables, mode };
}

const desert = (tint: string, dark = "#433744") => ({
  name: "Desert",
  colors: [{ key: "tint", hex: tint, dark }],
});
const themed = (...themes: { name: string; colors: { key: string; hex: string; dark?: string }[] }[]) =>
  tokensJson({ app: "ice", colors: [{ key: "tint", hex: "#111111", dark: "#222222" }], themes });

describe("syncing an app's other themes", () => {
  it("makes a collection for each other theme, with Light and Dark modes and the default theme's names", async () => {
    const app = plugin();
    await app.sync(themed(desert("#df915e")));
    expect([...app.fake.collections.values()].map((c) => c.name)).toEqual([
      "Ice (Designlane)",
      "Ice · Desert (Designlane)",
    ]);
    const { collection, variables, mode } = collectionNamed(app.fake, "Ice · Desert (Designlane)");
    expect(collection.modes.map((m) => m.name)).toEqual(["Light", "Dark"]);
    const [tint] = variables;
    expect([variables.length, tint?.name, tint?.codeSyntax]).toEqual([
      1,
      "color/tint",
      { iOS: "Theme.tint" },
    ]);
    expect([tint?.valuesByMode[mode("Light")], tint?.valuesByMode[mode("Dark")]]).toEqual([
      rgb("#df915e"),
      rgb("#433744"),
    ]);
  });

  it("names each theme's changes with its theme, and updates only that theme's variable", async () => {
    const app = plugin();
    await app.sync(themed(desert("#df915e")));
    expect((await app.plan(themed(desert("#df915e")))).applicable).toBe(false);
    const plan = await app.plan(themed(desert("#ffffff")));
    expect([plan.update, plan.unchanged]).toEqual([["Desert: color/tint"], 1]);
    await app.apply();
    const { variables, mode } = collectionNamed(app.fake, "Ice · Desert (Designlane)");
    expect(variables[0]?.valuesByMode[mode("Light")]).toEqual(rgb("#ffffff"));
    const main = collectionNamed(app.fake, "Ice (Designlane)");
    expect(main.variables[0]?.valuesByMode[main.mode("Light")]).toEqual(rgb("#111111"));
  });

  it("finds a theme's collection by its mark after a designer renames it, and deprecates a theme the code dropped", async () => {
    const app = plugin();
    await app.sync(themed(desert("#df915e")));
    const { collection, variables } = collectionNamed(app.fake, "Ice · Desert (Designlane)");
    collection.name = "Sand";
    expect((await app.plan(themed(desert("#df915e")))).applicable).toBe(false);
    expect((await app.plan(themed())).deprecate).toEqual(["Desert: color/tint"]);
    await app.apply();
    expect([app.fake.collections.size, variables[0]?.hiddenFromPublishing]).toEqual([2, true]);
  });

  it("names a theme's rename with its theme on both sides", async () => {
    const app = plugin();
    await app.sync(themed(desert("#df915e")));
    const renamed = { name: "Desert", colors: [{ key: "hue", hex: "#df915e", dark: "#433744" }] };
    expect((await app.plan(themed(renamed))).rename).toEqual([
      { from: "Desert: color/tint", to: "Desert: Theme.hue" },
    ]);
  });

  it("leaves every theme's dark values out on a Figma plan with one mode, naming each full collection", async () => {
    const app = plugin({ maxModes: 1 });
    // The default theme has no dark values, so only the themes' collections find there's no room for them.
    const ocean = { name: "Ocean", colors: [{ key: "tint", hex: "#0000ff", dark: "#000080" }] };
    const json = tokensJson({
      colors: [{ key: "tint", hex: "#111111" }],
      themes: [desert("#df915e"), ocean],
    });
    expect(await app.sync(json)).toEqual([
      'Dark values weren\'t added: the collection "Desert (Designlane)" has as many modes as this Figma plan allows.',
      'Dark values weren\'t added: the collection "Ocean (Designlane)" has as many modes as this Figma plan allows.',
    ]);
    const again = await app.plan(json);
    expect([again.update, again.unchanged, again.darkLeftOut]).toEqual([[], 3, true]);
  });

  it("leaves dark values out only of the collection with no room for them, keeping the others'", async () => {
    const app = plugin({ maxModes: 2 });
    const ocean = { name: "Ocean", colors: [{ key: "tint", hex: "#0000ff", dark: "#000080" }] };
    await app.sync(themed(desert("#df915e"), ocean));
    const { collection } = collectionNamed(app.fake, "Ice · Desert (Designlane)");
    collection.removeMode(collectionNamed(app.fake, "Ice · Desert (Designlane)").mode("Dark"));
    collection.addMode("Brand");
    await app.sync(themed(desert("#df915e"), ocean));
    const again = await app.plan(themed(desert("#df915e"), ocean));
    expect([again.update, again.darkLeftOut]).toEqual([[], true]);
    const oceanTint = collectionNamed(app.fake, "Ice · Ocean (Designlane)");
    expect(oceanTint.variables[0]?.valuesByMode[oceanTint.mode("Dark")]).toEqual(rgb("#000080"));
  });

  it("makes no collection for the default theme when only a theme's Dark mode is tried again", async () => {
    const app = plugin({ maxModes: 1 });
    const json = tokensJson({ app: "ice", themes: [desert("#df915e")] });
    await app.sync(json);
    expect((await app.plan(json)).darkLeftOut).toBe(true);
    await app.apply();
    expect([...app.fake.collections.values()].map((c) => c.name)).toEqual(["Ice · Desert (Designlane)"]);
  });

  it("tries the Dark mode again only in the collection that couldn't take it", async () => {
    const app = plugin({ maxModes: 2 });
    const plain = { name: "Ocean", colors: [{ key: "tint", hex: "#0000ff" }] };
    const json = tokensJson({ app: "ice", colors: [{ key: "tint", hex: "#111111" }], themes: [plain] });
    await app.sync(json);
    const withDesert = tokensJson({
      app: "ice",
      colors: [{ key: "tint", hex: "#111111" }],
      themes: [plain, desert("#df915e")],
    });
    await app.sync(withDesert);
    const desertCollection = collectionNamed(app.fake, "Ice · Desert (Designlane)").collection;
    desertCollection.removeMode(collectionNamed(app.fake, "Ice · Desert (Designlane)").mode("Dark"));
    desertCollection.addMode("Brand");
    await app.sync(withDesert);
    expect((await app.plan(withDesert)).darkLeftOut).toBe(true);
    await app.apply();
    const modes = (name: string) => collectionNamed(app.fake, name).collection.modes.map((m) => m.name);
    expect([modes("Ice (Designlane)"), modes("Ice · Ocean (Designlane)")]).toEqual([["Light"], ["Light"]]);
  });
});
