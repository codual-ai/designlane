import { afterEach, describe, expect, it, vi } from "vitest";
import { repoApi } from "../../figma-plugin/src/github.js";
import { withFigmaValues } from "../../figma-plugin/src/kept-in-figma.js";
import type { FigmaChange } from "../../figma-plugin/src/messages.js";
import { markerOf, openPullRequests, withPullRequests } from "../../figma-plugin/src/open-pull-requests.js";
import { fakeGitHub } from "../helpers/fake-github.js";
import { rgb, styleNamed } from "../helpers/figma-plugin.js";
import {
  READ_TOKEN,
  SHOP,
  shopTokens,
  syncedShop,
  THEME,
  TOKENS_PATH,
  WRITE_TOKEN,
} from "../helpers/shop-repo.js";

type Shop = Awaited<ReturnType<typeof syncedShop>>;

const brief = (changes: FigmaChange[]) =>
  changes.map(({ name, property, from, to }) => `${name} ${property} ${from} → ${to}`);

/** The value a colour variable of the default theme holds in Figma, in its Light or Dark mode. */
function valueIn(shop: Shop, name: string, mode: "Light" | "Dark") {
  const { fake } = shop.app;
  const collection = [...fake.collections.values()].find((c) => c.name === "Designmap");
  const modeId = collection?.modes.find((m) => m.name === mode)?.modeId ?? "";
  const variable = collection?.variableIds
    .map((id) => fake.variables.get(id))
    .find((candidate) => candidate?.name === name);
  return variable?.valuesByMode[modeId];
}

/** The Shop's code with `brand`'s light value changed, as a push to the repo has it. */
const rebranded = (hex: string) => ({
  [THEME]: (SHOP[THEME] ?? "").replace("#FF1A2E", hex.toUpperCase()),
  [TOKENS_PATH]: JSON.stringify(shopTokens({ brandLight: hex })),
});

const summaryOf = (shop: Shop) => {
  const message = shop.last();
  if (message?.type !== "plan") throw new Error(`expected a plan, got ${JSON.stringify(message)}`);
  return message.summary;
};

const brand: FigmaChange = {
  id: "V:1 light",
  name: "color/brand",
  token: "brand",
  property: "light",
  from: "#ff1a2e",
  to: "#de2413",
  inCodeToo: false,
};

describe("Apply and the values a designer changed in Figma", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("leaves a value changed in Figma as it is, applies the code's other changes, and says so", async () => {
    const shop = await syncedShop();
    shop.recolor("color/brand", "Light", "#de2413");
    shop.github.push({ [TOKENS_PATH]: shop.json.replace('"hex": "#112233"', '"hex": "#223344"') });
    await shop.check();
    expect(summaryOf(shop).update).toEqual(["color/ink"]);
    expect(await shop.apply()).toEqual({
      type: "applied",
      notes: ["Kept as you changed it in Figma, until the code has it: color/brand."],
    });
    expect([valueIn(shop, "color/brand", "Light"), valueIn(shop, "color/ink", "Light")]).toEqual([
      rgb("#de2413"),
      rgb("#223344"),
    ]);
    expect(brief(await shop.check())).toEqual(["color/brand light #ff1a2e → #de2413"]);
  });

  it("keeps only the value changed in Figma, taking the code's change to the colour's other value", async () => {
    const shop = await syncedShop();
    shop.recolor("color/brand", "Dark", "#00aa55");
    shop.github.push({ [TOKENS_PATH]: JSON.stringify(shopTokens({ brandLight: "#0055ff" })) });
    await shop.check();
    await shop.apply();
    expect([valueIn(shop, "color/brand", "Light"), valueIn(shop, "color/brand", "Dark")]).toEqual([
      rgb("#0055ff"),
      rgb("#00aa55"),
    ]);
    expect(brief(await shop.check())).toEqual(["color/brand dark #ff5566 → #00aa55"]);
  });

  it("keeps a text style's size changed in Figma, and applies the code's new weight", async () => {
    const shop = await syncedShop();
    await shop.restyle("Text/body", { size: 20 });
    const tokens = JSON.parse(shop.json);
    tokens.typography.body.fontWeight.$value = 600;
    shop.github.push({ [TOKENS_PATH]: JSON.stringify(tokens) });
    await shop.check();
    await shop.apply();
    const body = styleNamed(shop.app.fake, "Text/body");
    expect([body.fontSize, body.fontName.style]).toEqual([20, "Semibold"]);
    expect(brief(await shop.check())).toEqual(["Text/body size 17 → 20"]);
  });

  it("keeps a colour's Dark value when only its Light one is kept, in a colour alike in both modes in the code", () => {
    const light = (hex: string) => ({ hex, alpha: 1 });
    const tokens = {
      colors: [{ identity: "color:ink", key: "ink", light: light("#112233") }],
      textStyles: [],
      spacing: [],
      radii: [],
      complete: true,
    };
    const value = { light: light("#000000"), dark: light("#112233") };
    const file = {
      variables: [{ id: "V:1", name: "color/ink", identity: "color:ink", value, deprecated: false }],
      textStyles: [],
    };
    const kept = [{ ...brand, id: "V:1 light", token: "ink" }];
    expect(withFigmaValues(tokens, file, kept).colors).toEqual([
      { identity: "color:ink", key: "ink", ...value },
    ]);
    expect(withFigmaValues(tokens, file, []).colors).toEqual(tokens.colors);
  });

  it("sets a value the code changed too to the code's only once the designer keeps the code's", async () => {
    const shop = await syncedShop();
    shop.github.push(rebranded("#0055ff"));
    shop.recolor("color/brand", "Light", "#de2413");
    const [conflict] = await shop.check();
    expect(conflict).toMatchObject({ from: "#0055ff", to: "#de2413", inCodeToo: true });
    expect(summaryOf(shop)).toMatchObject({ update: [], applicable: true });
    await shop.apply();
    expect(valueIn(shop, "color/brand", "Light")).toEqual(rgb("#de2413"));
    expect(await shop.check()).toEqual([conflict]);
    expect(await shop.apply([conflict?.id ?? ""])).toEqual({ type: "applied", notes: [] });
    expect(valueIn(shop, "color/brand", "Light")).toEqual(rgb("#0055ff"));
    expect(await shop.check()).toEqual([]);
  });

  it("forgets the change once the code has the designer's value, and Apply doesn't bring it back", async () => {
    const shop = await syncedShop();
    shop.recolor("color/brand", "Light", "#de2413");
    shop.github.push(rebranded("#de2413"));
    expect(await shop.check()).toEqual([]);
    await shop.apply();
    expect(await shop.check()).toEqual([]);
    expect(valueIn(shop, "color/brand", "Light")).toEqual(rgb("#de2413"));
  });
});

describe("pull requests already open for a designer's changes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows a change already in an open Designmap pull request with its link, and plans no edit for it", async () => {
    const shop = await syncedShop();
    shop.recolor("color/brand", "Light", "#de2413");
    const changes = (await shop.check()).map((change) => change.id);
    await shop.planEdits(changes);
    await shop.openPullRequest(changes, WRITE_TOKEN);
    expect(await shop.check()).toMatchObject([{ pullRequest: "https://github.com/octo/app/pull/1" }]);
    const listing = shop.github.requests.filter((request) => request.path.startsWith("pulls?"));
    expect(new Set(listing.map((request) => request.token))).toEqual(new Set([READ_TOKEN]));
    expect(await shop.planEdits(changes)).toMatchObject({ type: "edits", edits: [] });
  });

  it("offers a change again whose pull request has another value, is closed, isn't Designmap's or has no marker", async () => {
    const shop = await syncedShop();
    shop.recolor("color/brand", "Light", "#de2413");
    const marked = markerOf([brand]);
    const pull = {
      title: "Design changes",
      head: "designmap/figma-2026-11-14-abcdef0",
      base: "main",
      body: marked,
    };
    shop.github.pulls.push(
      { ...pull, body: markerOf([{ ...brand, to: "#000000" }]) },
      { ...pull, head: "feature/brand" },
      { ...pull, body: "Changed in Figma by a designer, before markers." },
      { ...pull, repo: "someone/app" },
      { ...pull, base: "release" },
      pull,
    );
    shop.github.closed.add(6);
    expect(await shop.check()).toEqual([expect.not.objectContaining({ pullRequest: expect.anything() })]);
    shop.github.pulls.push(pull);
    expect(await shop.check()).toMatchObject([{ pullRequest: "https://github.com/octo/app/pull/7" }]);
  });

  it("shows the changes as before, with a quiet note, when GitHub won't list pull requests", async () => {
    const shop = await syncedShop();
    shop.recolor("color/brand", "Light", "#de2413");
    expect(await shop.check()).toHaveLength(1);
    expect(summaryOf(shop).pullRequestsUnlisted).toBe(false);
    shop.github.refuse("GET", "pulls", 403);
    expect(brief(await shop.check())).toEqual(["color/brand light #ff1a2e → #de2413"]);
    expect(summaryOf(shop).pullRequestsUnlisted).toBe(true);
  });

  it("reads back a marker's values whatever they hold, the marker ending only where it ends", async () => {
    const github = fakeGitHub({ files: {} });
    const family = { ...brand, property: "family" as const, to: "Odd --> <b>Font</b>" };
    const marker = markerOf([family]);
    expect(marker.indexOf("-->")).toBe(marker.length - "-->".length);
    github.pulls.push({ title: "t", head: "designmap/figma-1", base: "main", body: `Before.\n\n${marker}` });
    const open = await openPullRequests(repoApi("octo/app", READ_TOKEN), "main");
    expect(withPullRequests([family], open)).toMatchObject([
      { pullRequest: "https://github.com/octo/app/pull/1" },
    ]);
  });
});
