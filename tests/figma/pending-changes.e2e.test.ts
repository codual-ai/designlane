import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recolor, rgb, styleNamed } from "../helpers/figma-plugin.js";
import {
  BRANCH,
  brandChanged,
  brandLightIn,
  COLLECTION,
  changedOn,
  closeServers,
  connectedShop,
  copyOf,
  designmap,
  filesIn,
  pushScanned,
  withSpanReplaced,
} from "../helpers/scanned-shop.js";
import { READ_TOKEN, WRITE_TOKEN } from "../helpers/shop-repo.js";

describe("a designer's changes while the code changes too, end to end, against GitHub's API on a local server", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await closeServers();
  });

  it("opens a pull request for a value the code changed too, from the code's value, once the designer uses theirs", async () => {
    const shop = await connectedShop();
    await pushScanned(shop, (app) => designmap("edit", "Brand", "light", "#1565c0", "--dir", app));
    recolor(shop.fake, "color/Brand", "Light", "#de2413", COLLECTION);
    const changes = await shop.check();
    expect(changes).toMatchObject([{ token: "Brand", from: "#1565c0", to: "#de2413", inCodeToo: true }]);
    const [edit] = await shop.planEdits(changes);
    if (!edit?.ok) throw new Error(`expected an edit, got ${JSON.stringify(edit)}`);
    const from = shop.server.requests.length;
    expect(await shop.openPullRequest(changes, WRITE_TOKEN)).toMatchObject({ type: "pullRequest" });

    const editedByCli = await copyOf(shop.app, shop.server.filesOn(BRANCH));
    await designmap("edit", "Brand", "light", "#de2413", "--dir", editedByCli);
    const expected = await readFile(path.join(editedByCli, edit.file), "utf8");
    const onMain = shop.server.filesOn(BRANCH).get(edit.file) ?? "";
    expect(onMain).not.toBe((await filesIn(shop.app)).get(edit.file));
    expect(withSpanReplaced(onMain, edit)).toBe(expected);
    expect(shop.writesSince(from)[0]?.body).toEqual({ content: expected, encoding: "utf-8" });
    expect(shop.server.pulls[0]?.body).toContain("`color/Brand`: `#1565c0` → `#de2413`");
  });

  it("shows a change already in an open pull request with its link, read with the read-only token", async () => {
    const { shop, changes } = await brandChanged();
    const opened = await shop.openPullRequest(changes, WRITE_TOKEN);
    if (opened.type !== "pullRequest")
      throw new Error(`expected a pull request, got ${JSON.stringify(opened)}`);
    expect(await shop.check()).toEqual(changes.map((change) => ({ ...change, pullRequest: opened.url })));
    const listings = shop.server.requests.filter((request) => request.path.startsWith("pulls?"));
    expect(listings.length).toBeGreaterThan(0);
    expect(new Set(listings.map((request) => request.token))).toEqual(new Set([READ_TOKEN]));
    expect(await shop.planEdits(changes)).toEqual([]);
  });

  it("keeps a pending change in Figma through Apply, applies the code's others, and drops it once merged", async () => {
    const { shop, changes } = await brandChanged();
    const opened = await shop.openPullRequest(changes, WRITE_TOKEN);
    if (opened.type !== "pullRequest")
      throw new Error(`expected a pull request, got ${JSON.stringify(opened)}`);
    await pushScanned(shop, (app) => designmap("edit", "display", "size", "36", "--dir", app));
    expect(await shop.plan()).toMatchObject({
      update: ["Text/display"],
      figmaChanges: [{ token: "Brand", pullRequest: opened.url }],
    });
    expect(await shop.apply()).toMatchObject({
      type: "applied",
      notes: ["Kept as you changed it in Figma, until the code has it: color/Brand."],
    });
    expect([brandLightIn(shop), styleNamed(shop.fake, "Text/display").fontSize]).toEqual([
      rgb("#de2413"),
      36,
    ]);

    const [pull] = shop.server.pulls;
    if (!pull) throw new Error("no pull request");
    const merged = changedOn(shop, pull.head);
    await pushScanned(shop, async (app) => {
      for (const [file, text] of merged) await writeFile(path.join(app, file), text);
    });
    pull.state = "closed";
    expect(await shop.check()).toEqual([]);
    expect(await shop.apply()).toMatchObject({ type: "applied", notes: [] });
    expect(await shop.check()).toEqual([]);
    expect(brandLightIn(shop)).toEqual(rgb("#de2413"));
  });
  it("sets a designer's change back to the code's value when they choose that, and opens no pull request", async () => {
    const shop = await connectedShop();
    const inCode = brandLightIn(shop);
    recolor(shop.fake, "color/Brand", "Light", "#de2413", COLLECTION);
    const changes = await shop.check();
    expect(changes).toMatchObject([{ token: "Brand", to: "#de2413", inCodeToo: false }]);
    const from = shop.server.requests.length;
    expect(await shop.apply(changes.map((change) => change.id))).toMatchObject({
      type: "applied",
      notes: [],
    });
    expect(brandLightIn(shop)).toEqual(inCode);
    expect(await shop.check()).toEqual([]);
    expect(shop.writesSince(from)).toEqual([]);
  });
});
