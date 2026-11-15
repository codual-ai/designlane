import { afterEach, describe, expect, it, vi } from "vitest";
import { keptChanges } from "../../figma-plugin/src/kept-in-figma.js";
import type { FigmaChange } from "../../figma-plugin/src/messages.js";
import { modeNamed, plugin, recolor, rgb, styleNamed, variableNamed } from "../helpers/figma-plugin.js";
import { syncedShop, WRITE_TOKEN } from "../helpers/shop-repo.js";
import { tokensJson } from "../helpers/tokens-json.js";

const brand: FigmaChange = {
  id: "V:1 light",
  name: "color/brand",
  token: "brand",
  property: "light",
  from: "#ff1a2e",
  to: "#de2413",
  inCodeToo: false,
};

describe("setting a change made in Figma back to the code's value", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps every change Apply isn't told to set back, and one already in a pull request whatever it's told", () => {
    const conflict = { ...brand, id: "V:2 light", inCodeToo: true };
    const inPullRequest = { ...brand, id: "V:3 light", pullRequest: "https://github.com/octo/app/pull/1" };
    const changes = [brand, conflict, inPullRequest];
    expect(keptChanges(changes, [])).toEqual(changes);
    expect(
      keptChanges(
        changes,
        changes.map((change) => change.id),
      ),
    ).toEqual([inPullRequest]);
  });

  it("sets a change only Figma has back to the code's value on Apply, which drops it from the list", async () => {
    const shop = await syncedShop();
    shop.recolor("color/brand", "Light", "#de2413");
    await shop.restyle("Text/body", { size: 20 });
    const changes = await shop.check();
    const brandChange = changes.find((change) => change.name === "color/brand");
    expect(brandChange).toMatchObject({ from: "#ff1a2e", to: "#de2413", inCodeToo: false });
    expect(await shop.apply([brandChange?.id ?? ""])).toEqual({
      type: "applied",
      notes: ["Kept as you changed it in Figma, until the code has it: Text/body's font size."],
    });
    const { fake } = shop.app;
    expect(variableNamed(fake, "color/brand").valuesByMode[modeNamed(fake, "Light")]).toEqual(rgb("#ff1a2e"));
    expect(styleNamed(shop.app.fake, "Text/body").fontSize).toBe(20);
    expect((await shop.check()).map((change) => change.name)).toEqual(["Text/body"]);
  });

  it("leaves a change already in an open pull request as Figma has it, even when told to set it back", async () => {
    const shop = await syncedShop();
    shop.recolor("color/brand", "Light", "#de2413");
    const ids = (await shop.check()).map((change) => change.id);
    await shop.planEdits(ids);
    await shop.openPullRequest(ids, WRITE_TOKEN);
    expect(await shop.check()).toMatchObject([{ pullRequest: "https://github.com/octo/app/pull/1" }]);
    await shop.apply(ids);
    expect(await shop.check()).toMatchObject([{ to: "#de2413" }]);
    const { fake } = shop.app;
    expect(variableNamed(fake, "color/brand").valuesByMode[modeNamed(fake, "Light")]).toEqual(rgb("#de2413"));
  });

  it("sets a change back from a picked tokens.json, which no pull request could ever settle", async () => {
    const app = plugin();
    const json = tokensJson({ colors: [{ key: "bg", hex: "#ffffff", dark: "#000000" }] });
    await app.sync(json);
    recolor(app.fake, "color/bg", "Light", "#ff0000");
    const [change] = (await app.plan(json)).figmaChanges;
    expect(change).toMatchObject({ from: "#ffffff", to: "#ff0000", inCodeToo: false });
    expect((await app.plan(json)).applicable).toBe(true);
    expect(await app.apply([change?.id ?? ""])).toEqual([]);
    const bg = variableNamed(app.fake, "color/bg").valuesByMode;
    expect([bg[modeNamed(app.fake, "Light")], bg[modeNamed(app.fake, "Dark")]]).toEqual([
      rgb("#ffffff"),
      rgb("#000000"),
    ]);
    expect((await app.plan(json)).figmaChanges).toEqual([]);
  });
});
