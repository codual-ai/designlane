import { afterEach, describe, expect, it, vi } from "vitest";
import type { FigmaChange } from "../../figma-plugin/src/messages.js";
import { fakeGitHub } from "../helpers/fake-github.js";
import {
  designToCodeError,
  SHOP,
  type SyncedShop,
  shopTokens,
  syncedShop,
  THEME,
  TOKENS_PATH,
} from "../helpers/shop-repo.js";

const ids = (changes: FigmaChange[]) => changes.map((change) => change.id);

describe("planning the code edits for changes made in Figma", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("plans each ticked change's edit where tokens.json says it's written, or says why it can't", async () => {
    const shop = await syncedShop();
    shop.recolor("color/brand", "Light", "#de2413");
    shop.recolor("color/ink", "Dark", "#000000");
    await shop.restyle("Text/body", { size: 20, style: "Semibold" });
    const changes = await shop.check();
    const planned = await shop.planEdits(ids(changes));
    expect(planned).toEqual({
      type: "edits",
      id: shop.plan(),
      edits: [
        { ok: true, change: changes[0]?.id, file: THEME, line: 1, before: "#FF1A2E", after: "#DE2413" },
        {
          ok: false,
          change: changes[1]?.id,
          reason:
            "tokens.json doesn't say where ink's dark colour is written: the code may work it out from another value. Change it in the code.",
        },
        { ok: true, change: changes[2]?.id, file: THEME, line: 4, before: "17", after: "20" },
        { ok: true, change: changes[3]?.id, file: THEME, line: 4, before: "400", after: "600" },
      ],
    });
  });

  it("plans only the changes ticked", async () => {
    const shop = await syncedShop();
    shop.recolor("color/brand", "Light", "#de2413");
    shop.recolor("color/brand", "Dark", "#00aa55");
    const [, dark] = await shop.check();
    const planned = await shop.planEdits(dark ? [dark.id] : []);
    expect(planned).toMatchObject({
      type: "edits",
      edits: [{ change: dark?.id, before: "#FF5566", after: "#00AA55" }],
    });
  });

  it("plans a theme's colour change in that theme's code", async () => {
    const shop = await syncedShop();
    shop.recolor("color/brand", "Light", "#aa0000", "Desert (Designlane)");
    const planned = await shop.planEdits(ids(await shop.check()));
    expect(planned).toMatchObject({ edits: [{ ok: true, line: 3, before: "#DF915E", after: "#AA0000" }] });
  });

  it("reads tokens.json and each file of code once, from the branch's head commit, with the read-only token", async () => {
    const shop = await syncedShop();
    shop.recolor("color/brand", "Light", "#de2413");
    shop.recolor("color/brand", "Dark", "#00aa55");
    const changes = await shop.check();
    const before = shop.github.requests.length;
    await shop.planEdits(ids(changes));
    const made = shop.github.requests.slice(before);
    expect(made.map(({ method, path }) => `${method} ${path.replace(/[0-9a-f]{40}/, "<sha>")}`)).toEqual([
      "GET git/ref/heads/main",
      "GET git/commits/<sha>",
      "GET git/trees/<sha>",
      "GET git/trees/<sha>",
      "GET git/blobs/<sha>",
      "GET git/trees/<sha>",
      "GET git/blobs/<sha>",
    ]);
    expect(new Set(made.map((request) => request.token))).toEqual(new Set(["github_pat_read"]));
  });

  it("finds the code beside tokens.json for an app in a folder of its repo", async () => {
    const shop = await syncedShop({ root: "apps/shop" });
    shop.recolor("color/brand", "Light", "#de2413");
    expect(await shop.planEdits(ids(await shop.check()))).toMatchObject({
      edits: [{ ok: true, file: THEME, before: "#FF1A2E" }],
    });
  });

  it("asks for a check again when the branch's tokens.json changed since the plan", async () => {
    const shop = await syncedShop();
    shop.recolor("color/brand", "Light", "#de2413");
    const changes = await shop.check();
    shop.github.push({ [TOKENS_PATH]: JSON.stringify(shopTokens(), null, 1) });
    expect(designToCodeError(await shop.planEdits(ids(changes)))).toBe(
      "main changed since you checked it. Press Check again, then tick the changes.",
    );
  });

  it("says why a file it can't read can't be edited: too large, or not UTF-8 text", async () => {
    const large = { [THEME]: `${SHOP[THEME]}\n// ${"x".repeat(600 * 1024)}` };
    const shop = await syncedShop({ files: large });
    shop.recolor("color/brand", "Light", "#de2413");
    expect(await shop.planEdits(ids(await shop.check()))).toMatchObject({
      edits: [
        {
          ok: false,
          reason: "Designlane can't read src/theme.ts: it's over 512 KB, more than it reads as source.",
        },
      ],
    });
    const garbled = await syncedShop({ files: { [THEME]: `${SHOP[THEME]}\n// �` } });
    garbled.recolor("color/brand", "Light", "#de2413");
    expect(await garbled.planEdits(ids(await garbled.check()))).toMatchObject({
      edits: [{ ok: false, reason: "Designlane can't read src/theme.ts: it isn't plain UTF-8 text." }],
    });
  });

  it("plans a change the code made too from the code's value now, once the designer uses theirs", async () => {
    const shop = await syncedShop();
    const tokens = shopTokens({ brandLight: "#0055ff" });
    shop.github.push({
      [THEME]: (SHOP[THEME] ?? "").replace("#FF1A2E", "#0055FF"),
      [TOKENS_PATH]: JSON.stringify(tokens),
    });
    shop.recolor("color/brand", "Light", "#de2413");
    const changes = await shop.check();
    expect(changes).toMatchObject([{ from: "#0055ff", to: "#de2413", inCodeToo: true }]);
    expect(await shop.planEdits(ids(changes))).toMatchObject({
      edits: [{ ok: true, file: THEME, line: 1, before: "#0055FF", after: "#DE2413" }],
    });
  });

  it("says plainly when GitHub can't be reached, the branch is gone, or the plan isn't the one on screen", async () => {
    const shop = await syncedShop();
    shop.recolor("color/brand", "Light", "#de2413");
    const changes = ids(await shop.check());
    shop.github.refuse("GET", "git/ref/heads/main", 404);
    expect(designToCodeError(await shop.planEdits(changes))).toBe(
      "Couldn't find the branch main in octo/app. Check it still exists, then press Check again.",
    );
    shop.github.accept();
    shop.github.refuse("GET", "git/trees/", 403, { "x-ratelimit-remaining": "0" });
    expect(designToCodeError(await shop.planEdits(changes))).toBe(
      "GitHub is limiting requests for now. Try again in a few minutes.",
    );
    shop.github.accept();
    shop.github.refuse("GET", "git/trees/", 429);
    expect(designToCodeError(await shop.planEdits(changes))).toBe(
      "GitHub is limiting requests for now. Try again in a few minutes.",
    );
    shop.github.disconnect();
    expect(designToCodeError(await shop.planEdits(changes))).toBe(
      "Couldn't reach GitHub. Check your internet connection, then try again.",
    );
    await shop.app.session({ type: "planEdits", id: shop.plan() + 1, changes });
    expect(designToCodeError(shop.last())).toBe(
      "The plan changed. Look it over, then tick the changes again.",
    );
  });

  it("needs a connected repo, not a picked tokens.json, and the tokens file where designlane writes it", async () => {
    const shop = await syncedShop();
    await shop.app.session({ type: "plan", id: 50, json: shop.json });
    await shop.app.session({ type: "planEdits", id: 50, changes: [] });
    expect(designToCodeError(shop.last())).toBe(
      "Connect this file to the app's repo to open a pull request. A picked tokens.json can't open one.",
    );
    const elsewhere = await syncedShop();
    await elsewhere.app.session({ type: "disconnect" });
    elsewhere.github.push({ "tokens.json": elsewhere.json });
    await elsewhere.app.session({
      type: "connect",
      id: 60,
      repo: "octo/app",
      branch: "main",
      path: "tokens.json",
      token: "t",
    });
    await elsewhere.app.session({ type: "planEdits", id: 60, changes: [] });
    expect(designToCodeError(elsewhere.last())).toBe(
      "Opening a pull request needs the tokens file in the app's designlane/ folder, where designlane writes it.",
    );
  });

  it("sends nothing for a repo kept on the file whose name would step elsewhere in GitHub's API", async () => {
    const shop = await syncedShop();
    shop.recolor("color/brand", "Light", "#de2413");
    const changes = ids(await shop.check());
    const source = { repo: "octo/../../user", branch: "main", path: TOKENS_PATH };
    shop.app.fake.root.setPluginData("connection", JSON.stringify(source));
    await shop.app.fake.api.clientStorage.setAsync("token:octo/../../user", "github_pat_read");
    const before = shop.github.requests.length;
    expect(designToCodeError(await shop.planEdits(changes))).toBe(
      '"octo/../../user" isn\'t a repo name. Connect the repo again.',
    );
    expect(shop.github.requests.length).toBe(before);
  });

  it("refuses to edit a file Git doesn't hold as plain text: a link, one GitHub lists only part of, one outside the repo", async () => {
    const reasonFor = async (
      options: Omit<Parameters<typeof fakeGitHub>[0], "files">,
      files = (shop: SyncedShop) => shop.github.filesOn("main"),
    ) => {
      const shop = await syncedShop();
      shop.recolor("color/brand", "Light", "#de2413");
      const changes = ids(await shop.check());
      fakeGitHub({ files: files(shop), ...options });
      const planned = await shop.planEdits(changes);
      const [edit] = planned?.type === "edits" ? planned.edits : [];
      return edit?.ok === false ? edit.reason : JSON.stringify(planned);
    };
    expect(await reasonFor({ modes: { [THEME]: "120000" } })).toBe(
      "Designlane can't read src/theme.ts: it isn't a plain file.",
    );
    const withoutTheme = (shop: SyncedShop) => {
      const { [THEME]: _, ...rest } = shop.github.filesOn("main");
      return rest;
    };
    expect(await reasonFor({ truncated: true }, withoutTheme)).toBe(
      "Designlane can't read src/theme.ts: GitHub listed only part of its folder.",
    );
  });

  it("refuses a file with a byte order mark, which reading drops and would move every offset after it", async () => {
    const shop = await syncedShop({ files: { [THEME]: `\uFEFF${SHOP[THEME]}` } });
    shop.recolor("color/brand", "Light", "#de2413");
    expect(await shop.planEdits(ids(await shop.check()))).toMatchObject({
      edits: [{ ok: false, reason: "Designlane can't read src/theme.ts: it isn't plain UTF-8 text." }],
    });
  });

  it("never reads a file outside the repo that tokens.json names", async () => {
    const shop = await syncedShop();
    const json = shop.json.replace('"file": "src/theme.ts"', '"file": "../theme.ts"');
    shop.github.push({ [TOKENS_PATH]: json });
    shop.recolor("color/brand", "Light", "#de2413");
    expect(await shop.planEdits(ids(await shop.check()))).toMatchObject({
      edits: [{ ok: false, reason: "Designlane can't read ../theme.ts: its path steps outside the repo." }],
    });
  });
});
