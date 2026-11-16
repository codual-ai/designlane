import { afterEach, describe, expect, it, vi } from "vitest";
import { repoApi } from "../../figma-plugin/src/github.js";
import { markerOf, openPullRequests, withPullRequests } from "../../figma-plugin/src/open-pull-requests.js";
import { fakeGitHub } from "../helpers/fake-github.js";
import { brandChange as brand } from "../helpers/figma-change.js";
import { plugin } from "../helpers/figma-plugin.js";
import { connection, contentsReads, lastError } from "../helpers/github-fetch.js";
import { beforeRename } from "../helpers/old-names.js";
import { READ_TOKEN, syncedShop, THEME, TOKENS_PATH, WRITE_TOKEN } from "../helpers/shop-repo.js";
import { tokensJson } from "../helpers/tokens-json.js";

/** GitHub with the files at `paths`, finding no others. */
function githubWith(paths: string[]) {
  const fetch = vi.fn(async (url: string, _init?: FetchOptions) => {
    const found = paths.some((path) => url.includes(`/contents/${path}?`));
    return {
      ok: found,
      status: found ? 200 : 404,
      statusText: found ? "OK" : "Not Found",
      headersObject: {},
      text: async () => (found ? beforeRename(tokensJson({ spacing: [8] })) : ""),
    };
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("a repo set up before the rename to Designlane", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("connects to designmap/tokens.json when there's no designlane/ one, and keeps reading it there", async () => {
    const app = plugin();
    const fetch = githubWith(["apps/shop/designmap/tokens.json"]);
    await app.session({ type: "connect", id: 1, ...connection, path: "apps/shop/designlane/tokens.json" });
    expect(app.last()).toMatchObject({ type: "plan" });
    expect(JSON.parse(app.fake.root.getPluginData("connection")).path).toBe(
      "apps/shop/designmap/tokens.json",
    );
    await app.session({ type: "ready", id: 2 });
    expect(String(contentsReads(fetch).pop()?.[0])).toContain("/contents/apps/shop/designmap/tokens.json?");
  });

  it("says the path asked for is missing when neither folder has it, and looks in no other folder", async () => {
    const app = plugin();
    const fetch = githubWith([]);
    await app.session({ type: "connect", id: 1, ...connection });
    expect(lastError(app)).toMatch(/^Couldn't find designlane\/tokens\.json on main/);
    await app.session({ type: "connect", id: 2, ...connection, path: "tokens/tokens.json" });
    expect(contentsReads(fetch)).toHaveLength(3);
  });

  it("opens a pull request from an app whose tokens file is in designmap/", async () => {
    const shop = await syncedShop({ root: "apps/shop" });
    const files = shop.github.filesOn("main");
    const json = files[`apps/shop/${TOKENS_PATH}`] ?? "";
    delete files[`apps/shop/${TOKENS_PATH}`];
    const github = fakeGitHub({ files: { ...files, "apps/shop/designmap/tokens.json": beforeRename(json) } });
    await shop.app.session({ type: "connect", id: 90, ...connection, path: `apps/shop/${TOKENS_PATH}` });
    shop.recolor("color/brand", "Light", "#de2413");
    const changes = (await shop.check()).map((change) => change.id);
    await shop.planEdits(changes);
    await shop.openPullRequest(changes, WRITE_TOKEN);
    const tree = github.requests.find((request) => request.path === "git/trees");
    expect(tree?.body).toMatchObject({ tree: [{ path: `apps/shop/${THEME}` }] });
    expect(await shop.check()).toMatchObject([{ pullRequest: "https://github.com/octo/app/pull/1" }]);
  });

  it("knows its pull requests opened before the rename, by their branch and their marker", async () => {
    const github = fakeGitHub({ files: {} });
    const dark = { ...brand, property: "dark" as const, to: "#000000" };
    const oldMarker = (change: typeof brand) =>
      markerOf(TOKENS_PATH, [change]).replace("designlane-figma-changes", "designmap-figma-changes");
    github.pulls.push(
      { title: "t", head: "designmap/figma-1", base: "main", body: markerOf(TOKENS_PATH, [brand]) },
      { title: "t", head: "designlane/figma-2", base: "main", body: oldMarker(dark) },
    );
    const open = await openPullRequests(repoApi("octo/app", READ_TOKEN), "main", TOKENS_PATH);
    expect(withPullRequests([brand, dark], open)).toMatchObject([
      { pullRequest: "https://github.com/octo/app/pull/1" },
      { pullRequest: "https://github.com/octo/app/pull/2" },
    ]);
  });
});
