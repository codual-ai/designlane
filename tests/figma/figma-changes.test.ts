import { afterEach, describe, expect, it, vi } from "vitest";
import type { FigmaChange } from "../../figma-plugin/src/messages.js";
import { rgb, variableNamed } from "../helpers/figma-plugin.js";
import { SHOP, shopTokens, syncedShop, THEME, TOKENS_PATH } from "../helpers/shop-repo.js";

const brief = (changes: FigmaChange[]) =>
  changes.map(
    ({ name, token, property, from, to, inCodeToo }) =>
      `${name} (${token}) ${property} ${from} → ${to}${inCodeToo ? ", in the code too" : ""}`,
  );

/** The Shop's code with `brand`'s light value changed, as a push to the repo has it: written as long, so at the same
 * place. */
function rebranded(hex: string) {
  const files = { [THEME]: (SHOP[THEME] ?? "").replace("#FF1A2E", hex.toUpperCase()) };
  const tokens = shopTokens({ brandLight: hex });
  return { ...files, [TOKENS_PATH]: JSON.stringify(tokens) };
}

describe("what a designer changed in Figma", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("finds nothing in a file just synced", async () => {
    const shop = await syncedShop();
    expect(await shop.check()).toEqual([]);
  });

  it("lists a colour's light and dark values changed in Figma", async () => {
    const shop = await syncedShop();
    shop.recolor("color/brand", "Light", "#de2413");
    shop.recolor("color/brand", "Dark", "#00aa55");
    expect(brief(await shop.check())).toEqual([
      "color/brand (brand) light #ff1a2e → #de2413",
      "color/brand (brand) dark #ff5566 → #00aa55",
    ]);
  });

  it("lists a theme's colour with its theme's name, keyed as tokens.json keys the theme", async () => {
    const shop = await syncedShop();
    shop.recolor("color/brand", "Light", "#aa0000", "Desert (Designmap)");
    expect(brief(await shop.check())).toEqual(["Desert: color/brand (desert/brand) light #df915e → #aa0000"]);
  });

  it("lists a text style's size and weight changed in Figma", async () => {
    const shop = await syncedShop();
    await shop.restyle("Text/body", { size: 20, style: "Semibold" });
    expect(brief(await shop.check())).toEqual([
      "Text/body (body) size 17 → 20",
      "Text/body (body) weight 400 → 600",
    ]);
  });

  it("doesn't take a change pushed to the code, which Figma hasn't applied yet, for one made in Figma", async () => {
    const shop = await syncedShop();
    shop.github.push(rebranded("#0055ff"));
    expect(await shop.check()).toEqual([]);
    expect(shop.last()).toMatchObject({ type: "plan", summary: { update: ["color/brand"] } });
  });

  it("says when the code changed a value too, since the two last agreed", async () => {
    const shop = await syncedShop();
    shop.github.push(rebranded("#0055ff"));
    shop.recolor("color/brand", "Light", "#de2413");
    expect(brief(await shop.check())).toEqual([
      "color/brand (brand) light #0055ff → #de2413, in the code too",
    ]);
  });

  it("counts no rename a designer made, only values, under the name the designer gave", async () => {
    const shop = await syncedShop();
    variableNamed(shop.app.fake, "color/brand").name = "Brand/Primary";
    expect(await shop.check()).toEqual([]);
    shop.recolor("Brand/Primary", "Light", "#de2413");
    expect(brief(await shop.check())).toEqual(["Brand/Primary (brand) light #ff1a2e → #de2413"]);
  });

  it("drops a change once Figma has the code's value again, by Apply or by hand", async () => {
    const shop = await syncedShop();
    shop.recolor("color/brand", "Light", "#de2413");
    shop.recolor("color/ink", "Light", "#000000");
    expect(await shop.check()).toHaveLength(2);
    shop.recolor("color/ink", "Light", "#112233");
    expect(brief(await shop.check())).toEqual(["color/brand (brand) light #ff1a2e → #de2413"]);
    await shop.app.session({ type: "apply", id: shop.plan() });
    expect(await shop.check()).toEqual([]);
  });

  it("guesses nothing in a file synced before it recorded what the two agree on, and starts from then", async () => {
    const shop = await syncedShop();
    for (const variable of shop.app.fake.variables.values())
      variable.setSharedPluginData("designmap", "agreed", "");
    shop.github.push(rebranded("#0055ff"));
    expect(await shop.check()).toEqual([]);
    shop.recolor("color/ink", "Light", "#000000");
    expect(brief(await shop.check())).toEqual(["color/ink (ink) light #112233 → #000000"]);
  });

  it("leaves out a variable a designer made", async () => {
    const shop = await syncedShop();
    const brand = variableNamed(shop.app.fake, "color/brand");
    brand.setSharedPluginData("designmap", "identity", "");
    shop.recolor("color/brand", "Light", "#de2413");
    expect(await shop.check()).toEqual([]);
  });

  it("lists a text style's font changed in Figma, and a colour's opacity", async () => {
    const shop = await syncedShop();
    await shop.restyle("Text/body", { family: "Inter", style: "Regular" });
    const brand = variableNamed(shop.app.fake, "color/brand");
    const [light] = Object.keys(brand.valuesByMode);
    if (light) brand.valuesByMode[light] = { ...rgb("#ff1a2e"), a: 0.5 };
    expect(brief(await shop.check())).toEqual([
      "color/brand (brand) light #ff1a2e → #ff1a2e80",
      "Text/body (body) family SF Pro → Inter",
    ]);
  });

  it("isn't a change once Figma and the code were both changed to the same value", async () => {
    const shop = await syncedShop();
    shop.github.push(rebranded("#de2413"));
    shop.recolor("color/brand", "Light", "#de2413");
    expect(await shop.check()).toEqual([]);
  });

  it("tells a change made right after an Apply from the code's, without a check between", async () => {
    const shop = await syncedShop();
    shop.github.push(rebranded("#0055ff"));
    await shop.check();
    await shop.app.session({ type: "apply", id: shop.plan() });
    shop.recolor("color/brand", "Light", "#de2413");
    expect(brief(await shop.check())).toEqual(["color/brand (brand) light #0055ff → #de2413"]);
  });

  it("leaves alone a copy a designer made of a synced variable, as a sync does", async () => {
    const shop = await syncedShop();
    const brand = variableNamed(shop.app.fake, "color/brand");
    const collection = shop.app.fake.collections.get(brand.variableCollectionId);
    if (!collection) throw new Error("no collection");
    const copy = shop.app.fake.api.variables.createVariable("color/brand copy", collection, "COLOR");
    for (const key of ["identity", "agreed"]) {
      copy.setSharedPluginData("designmap", key, brand.getSharedPluginData("designmap", key));
    }
    for (const mode of collection.modes) copy.valuesByMode[mode.modeId] = rgb("#000000");
    expect(await shop.check()).toEqual([]);
  });

  it("lists a Dark value changed alone in a colour whose Light and Dark were alike", async () => {
    const shop = await syncedShop();
    shop.recolor("color/ink", "Dark", "#112233");
    shop.github.push({ [TOKENS_PATH]: shop.json.replace('"hex": "#eeeeee"', '"hex": "#112233"') });
    expect(await shop.check()).toEqual([]);
    shop.recolor("color/ink", "Dark", "#445566");
    expect(brief(await shop.check())).toEqual(["color/ink (ink) dark #112233 → #445566"]);
  });
});
