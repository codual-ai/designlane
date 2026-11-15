import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeGitHub } from "../helpers/fake-github.js";
import { SHOP, syncedShop, THEME, WRITE_TOKEN } from "../helpers/shop-repo.js";

const NOW = new Date("2026-11-14T10:00:00Z");

/** The Shop with its brand colour and body size changed in Figma, and their edits planned. */
async function plannedShop(options?: Parameters<typeof syncedShop>[0]) {
  const shop = await syncedShop(options);
  shop.recolor("color/brand", "Light", "#de2413");
  shop.recolor("color/ink", "Dark", "#000000");
  await shop.restyle("Text/body", { size: 20 });
  const changes = (await shop.check()).map((change) => change.id);
  await shop.planEdits(changes);
  return { ...shop, changes };
}

const writes = (shop: { github: ReturnType<typeof fakeGitHub> }) =>
  shop.github.requests.filter((request) => request.method !== "GET");

const errorOf = (message: unknown) =>
  message && typeof message === "object" && "message" in message ? message.message : JSON.stringify(message);

describe("opening a pull request with the code edits", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("asks for a token that can write the first time, and writes nothing until it has one", async () => {
    const shop = await plannedShop();
    expect(await shop.openPullRequest(shop.changes)).toEqual({
      type: "writeTokenNeeded",
      id: shop.plan(),
      repo: "octo/app",
    });
    expect(writes(shop)).toEqual([]);
  });

  it("commits exactly the planned edits on a new branch from the planned commit, and opens the pull request", async () => {
    const shop = await plannedShop();
    const head = shop.github.refs.get("main");
    const opened = await shop.openPullRequest(shop.changes, WRITE_TOKEN);
    expect(opened).toEqual({
      type: "pullRequest",
      id: shop.plan(),
      url: "https://github.com/octo/app/pull/1",
    });
    const branch = [...shop.github.refs.keys()].find((name) => name !== "main") ?? "";
    expect(branch).toMatch(/^designmap\/figma-2026-11-14-[0-9a-f]{7}$/);
    const expected = (SHOP[THEME] ?? "")
      .replace("#FF1A2E", "#DE2413")
      .replace("fontSize: 17", "fontSize: 20");
    expect(shop.github.filesOn(branch)[THEME]).toBe(expected);
    const { [THEME]: _, ...rest } = shop.github.filesOn(branch);
    const { [THEME]: __, ...restBefore } = shop.github.filesOn("main");
    expect(rest).toEqual(restBefore);
    const commit = shop.github.commits.get(shop.github.refs.get(branch) ?? "");
    expect([commit?.parents, commit?.message]).toEqual([[head], "Design changes from Figma: 2 values"]);
    expect(writes(shop).map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST git/blobs",
      "POST git/trees",
      "POST git/commits",
      "POST git/refs",
      "POST pulls",
    ]);
    expect(shop.github.pulls).toEqual([
      {
        title: "Design changes from Figma: 2 values",
        head: branch,
        base: "main",
        body: [
          "Changed in Figma by a designer, and written into the code by Designmap from Figma, each value the way the code already writes it:",
          "",
          "- `color/brand`: `#ff1a2e` → `#de2413`, in `src/theme.ts:1`",
          "- `Text/body's font size`: `17` → `20`, in `src/theme.ts:4`",
          "",
          "The app's tokens.json catches up the next time designmap runs.",
          "",
          '<!-- designmap-figma-changes [{"token":"brand","property":"light","value":"#de2413"},{"token":"body","property":"size","value":"20"}] -->',
        ].join("\n"),
      },
    ]);
  });

  it("uses the token that can write only for writing, keeps it for next time, and sends tokens to GitHub only", async () => {
    const shop = await plannedShop();
    await shop.openPullRequest(shop.changes, ` ${WRITE_TOKEN} `);
    expect(new Set(writes(shop).map((request) => request.token))).toEqual(new Set([WRITE_TOKEN]));
    expect(await shop.app.fake.api.clientStorage.getAsync("writeToken:octo/app")).toBe(WRITE_TOKEN);
    expect(shop.github.fetch.mock.calls.every(([url]) => url.startsWith("https://api.github.com/"))).toBe(
      true,
    );
    expect(JSON.stringify(shop.app.sent)).not.toContain("github_pat");
    await shop.planEdits(shop.changes);
    expect(await shop.openPullRequest(shop.changes)).toMatchObject({
      type: "pullRequest",
      url: "https://github.com/octo/app/pull/2",
    });
  });

  it("opens only the edits ticked, and refuses when none that can be made is", async () => {
    const shop = await plannedShop();
    const [brand, inkDark] = shop.changes;
    expect(errorOf(await shop.openPullRequest(inkDark ? [inkDark] : [], WRITE_TOKEN))).toBe(
      "Tick at least one edit to open a pull request.",
    );
    await shop.openPullRequest(brand ? [brand] : [], WRITE_TOKEN);
    expect(shop.github.pulls).toMatchObject([{ title: "Design changes from Figma: 1 value" }]);
  });

  it("keeps each file's Git mode and puts an app's files under its folder", async () => {
    const shop = await syncedShop({ root: "apps/shop" });
    const github = fakeGitHub({
      files: Object.fromEntries(Object.entries(shop.github.filesOn("main"))),
      modes: { [`apps/shop/${THEME}`]: "100755" },
    });
    shop.recolor("color/brand", "Light", "#de2413");
    const changes = (await shop.check()).map((change) => change.id);
    await shop.planEdits(changes);
    await shop.openPullRequest(changes, WRITE_TOKEN);
    const tree = github.requests.find((request) => request.path === "git/trees");
    expect(tree?.body).toMatchObject({
      tree: [{ path: `apps/shop/${THEME}`, mode: "100755", type: "blob" }],
    });
  });

  it("asks for another token when GitHub won't let this one write, forgetting it, and makes no branch", async () => {
    const shop = await plannedShop();
    shop.github.refuse("POST", "git/blobs", 403);
    expect(await shop.openPullRequest(shop.changes, WRITE_TOKEN)).toEqual({
      type: "writeTokenNeeded",
      id: shop.plan(),
      repo: "octo/app",
      reason:
        "The token can't open pull requests on octo/app. Give it access to this repo with Contents and Pull requests, both Read and write.",
    });
    expect(await shop.app.fake.api.clientStorage.getAsync("writeToken:octo/app")).toBeUndefined();
    expect([...shop.github.refs.keys()]).toEqual(["main"]);
    shop.github.accept();
    shop.github.refuse("POST", "git/blobs", 404);
    expect(await shop.openPullRequest(shop.changes, WRITE_TOKEN)).toMatchObject({ type: "writeTokenNeeded" });
    shop.github.accept();
    shop.github.refuse("POST", "git/blobs", 401);
    expect(await shop.openPullRequest(shop.changes, WRITE_TOKEN)).toMatchObject({
      type: "writeTokenNeeded",
      reason:
        "GitHub didn't accept the token: it may be mistyped or expired. Make a new one and paste it here.",
    });
  });

  it("deletes the branch it made when GitHub won't open the pull request", async () => {
    const shop = await plannedShop();
    shop.github.refuse("POST", "pulls", 403);
    expect(await shop.openPullRequest(shop.changes, WRITE_TOKEN)).toMatchObject({ type: "writeTokenNeeded" });
    expect([...shop.github.refs.keys()]).toEqual(["main"]);
    shop.github.accept();
    shop.github.refuse("POST", "pulls", 500);
    shop.github.refuse("DELETE", "git/refs/", 500);
    const left = errorOf(await shop.openPullRequest(shop.changes, WRITE_TOKEN));
    expect(left).toMatch(
      /^GitHub answered 500 Error\. Try again in a moment\. The branch designmap\/figma-\S+ is left on GitHub: delete it there\.$/,
    );
  });

  it("says plainly when GitHub limits requests, the branch is there already, or GitHub can't be reached", async () => {
    const shop = await plannedShop();
    shop.github.refuse("POST", "git/blobs", 403, { "x-ratelimit-remaining": "0" });
    expect(errorOf(await shop.openPullRequest(shop.changes, WRITE_TOKEN))).toBe(
      "GitHub is limiting requests for now. Try again in a few minutes.",
    );
    expect(await shop.app.fake.api.clientStorage.getAsync("writeToken:octo/app")).toBe(WRITE_TOKEN);
    shop.github.accept();
    shop.github.refuse("POST", "git/refs", 422);
    expect(errorOf(await shop.openPullRequest(shop.changes))).toMatch(/it's there already/);
    shop.github.accept();
    shop.github.refuse("POST", "git/refs", 409);
    expect(errorOf(await shop.openPullRequest(shop.changes))).toMatch(
      /^Couldn't make the branch designmap\/figma-2026-11-14-[0-9a-f]{7} on octo\/app: it's there already\. Press Open pull request again\.$/,
    );
    shop.github.accept();
    shop.github.disconnect();
    expect(errorOf(await shop.openPullRequest(shop.changes))).toBe(
      "Couldn't reach GitHub. Check your internet connection, then try again.",
    );
  });

  it("asks for a token when the one pasted is empty, and opens no pull request for a plan no longer shown", async () => {
    const shop = await plannedShop();
    expect(errorOf(await shop.openPullRequest(shop.changes, "  "))).toBe(
      "Paste a GitHub token that can open pull requests on this repo.",
    );
    await shop.app.session({
      type: "openPullRequest",
      id: shop.plan() + 1,
      changes: shop.changes,
      token: WRITE_TOKEN,
    });
    expect(errorOf(shop.last())).toBe("The plan changed. Look it over, then tick the changes again.");
    expect(writes(shop)).toEqual([]);
  });

  it("forgets planned edits once a new plan replaces them", async () => {
    const shop = await plannedShop();
    await shop.check();
    await shop.app.session({
      type: "openPullRequest",
      id: shop.plan(),
      changes: shop.changes,
      token: WRITE_TOKEN,
    });
    expect(errorOf(shop.last())).toBe("The plan changed. Look it over, then tick the changes again.");
  });

  it("opens one pull request from a set of planned edits, never a second with the same edits", async () => {
    const shop = await plannedShop();
    await shop.openPullRequest(shop.changes, WRITE_TOKEN);
    expect(errorOf(await shop.openPullRequest(shop.changes))).toBe(
      "The plan changed. Look it over, then tick the changes again.",
    );
    expect(shop.github.pulls).toHaveLength(1);
  });

  it("shows no link GitHub gives that isn't one of its own pages, keeping the branch it may be open from", async () => {
    const shop = await plannedShop();
    const github = fakeGitHub({ files: shop.github.filesOn("main"), pullUrl: "https://example.com" });
    expect(errorOf(await shop.openPullRequest(shop.changes, WRITE_TOKEN))).toMatch(
      /^GitHub answered in a way Designmap doesn't expect\. Try again in a moment\. The branch designmap\/figma-\S+ is on GitHub: look there for its pull request first\.$/,
    );
    expect(github.refs.size).toBe(2);
  });

  it("keeps a backtick in a designer's name from breaking the pull request's text", async () => {
    const shop = await syncedShop();
    const [brand] = [...shop.app.fake.variables.values()];
    if (brand) brand.name = "color/`brand`";
    shop.recolor("color/`brand`", "Light", "#de2413");
    const changes = (await shop.check()).map((change) => change.id);
    await shop.planEdits(changes);
    await shop.openPullRequest(changes, WRITE_TOKEN);
    expect(shop.github.pulls).toMatchObject([
      { body: expect.stringContaining("- `color/'brand'`: `#ff1a2e` → `#de2413`") },
    ]);
  });
});
