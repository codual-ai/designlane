import { afterEach, describe, expect, it, vi } from "vitest";
import { plugin } from "../helpers/figma-plugin.js";
import { tokensJson } from "../helpers/tokens-json.js";

const repo = { repo: "octo/app", branch: "main", path: "designmap/tokens.json" };
const connection = { ...repo, token: "github_pat_secret" };

/** GitHub as the plugin's `fetch` sees it: answering every request with `status`, and `body` when it's found. */
function github(status: number, body = "", headers: Record<string, string> = {}) {
  const fetch = vi.fn(async (_url: string, _init?: FetchOptions) => ({
    ok: status === 200,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headersObject: headers,
    text: async () => body,
  }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** The requests for a file's contents, apart from the listing of open pull requests each check makes too. */
const contentsReads = (fetch: ReturnType<typeof github>) =>
  fetch.mock.calls.filter(([url]) => url.includes("/contents/"));

const lastError = (app: ReturnType<typeof plugin>) => {
  const message = app.last();
  return message?.type === "error" ? message.message : `no error: ${JSON.stringify(message)}`;
};

describe("syncing from a GitHub repo", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("connects, reading tokens.json with the token, and plans from it", async () => {
    const app = plugin();
    const fetch = github(200, tokensJson({ spacing: [8] }));
    await app.session({ type: "connect", id: 1, ...connection });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/octo/app/contents/designmap/tokens.json?ref=main",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer github_pat_secret" }),
      }),
    );
    expect(app.sent.map((message) => message.type)).toEqual(["connection", "plan"]);
    expect(app.sent[0]).toEqual({ type: "connection", repo });
  });

  it("never sends the token to the window", async () => {
    const app = plugin();
    github(200, tokensJson({ spacing: [8] }));
    await app.session({ type: "connect", id: 1, ...connection });
    await app.session({ type: "ready", id: 2 });
    expect(JSON.stringify(app.sent)).not.toContain("github_pat_secret");
  });

  it("remembers the connection, and plans from the repo each time the window opens", async () => {
    const app = plugin();
    github(200, tokensJson({ spacing: [8] }));
    await app.session({ type: "connect", id: 1, ...connection });
    await app.session({ type: "apply", id: 1 });
    github(200, tokensJson({ spacing: [8, 16] }));
    await app.session({ type: "ready", id: 2 });
    expect(app.sent.slice(-2)).toMatchObject([
      { type: "connection", repo },
      { type: "plan", id: 2, summary: { create: ["spacing/16"] } },
    ]);
  });

  it("keeps each Figma file's own connection, so an iPhone file and an Android file read their own tokens", async () => {
    const app = plugin();
    const fetch = github(200, tokensJson({ spacing: [8] }));
    const ios = { ...connection, path: "designmap/tokens.ios.json" };
    await app.session({ type: "connect", id: 1, ...ios });
    const iosFile = app.fake.root.getPluginData("connection");
    app.fake.root.setPluginData("connection", ""); // another file, on the same computer
    await app.session({ type: "connect", id: 2, ...connection, path: "designmap/tokens.android.json" });
    app.fake.root.setPluginData("connection", iosFile);
    await app.session({ type: "ready", id: 3 });
    expect(app.sent[app.sent.length - 2]).toEqual({ type: "connection", repo: { ...repo, path: ios.path } });
    expect(String(contentsReads(fetch).pop()?.[0])).toContain("tokens.ios.json");
    expect(JSON.stringify([...app.fake.stored.values()])).not.toContain("tokens.ios.json");
  });

  it("keeps the file's repo where only Designmap can read it, not in data other plugins share", async () => {
    const app = plugin();
    github(200, tokensJson({ spacing: [8] }));
    await app.session({ type: "connect", id: 1, ...connection });
    expect(JSON.parse(app.fake.root.getPluginData("connection"))).toEqual(repo);
    expect(app.fake.root.getSharedPluginData("designmap", "connection")).toBe("");
  });

  it("still reads a token saved before connections were kept per file, in a file that was synced", async () => {
    const app = plugin();
    github(200, tokensJson({ spacing: [8] }));
    await app.fake.api.clientStorage.setAsync("connection", connection);
    app.fake.root.setPluginData("connection", JSON.stringify(repo));
    await app.session({ type: "ready", id: 1 });
    expect(app.sent.map((m) => m.type)).toEqual(["connection", "plan"]);

    const before = plugin();
    github(200, tokensJson({ spacing: [8] }));
    await before.fake.api.clientStorage.setAsync("connection", connection);
    await before.session({ type: "ready", id: 1 });
    expect(before.last()).toEqual({ type: "connection", repo: null });
    await before.session({ type: "plan", id: 2, json: tokensJson({ spacing: [8] }) });
    await before.session({ type: "apply", id: 2 });
    await before.session({ type: "ready", id: 3 });
    expect(before.sent.map((m) => m.type).slice(-2)).toEqual(["connection", "plan"]);
    expect(JSON.parse(before.fake.root.getPluginData("connection"))).toEqual(repo);
  });

  it("says no repo is connected when the window opens before one is", async () => {
    const app = plugin();
    const fetch = github(200);
    await app.session({ type: "ready", id: 1 });
    expect([app.sent, fetch.mock.calls.length]).toEqual([[{ type: "connection", repo: null }], 0]);
  });

  it("checks the repo again when asked", async () => {
    const app = plugin();
    github(200, tokensJson({ spacing: [8] }));
    await app.session({ type: "connect", id: 1, ...connection });
    github(200, tokensJson({ spacing: [8, 24] }));
    await app.session({ type: "fetch", id: 2 });
    expect(app.last()).toMatchObject({
      type: "plan",
      id: 2,
      summary: { create: ["spacing/8", "spacing/24"] },
    });
  });

  it("forgets this file's connection when disconnected, keeping the token for another file of the same repo", async () => {
    const app = plugin();
    github(200, tokensJson({ spacing: [8] }));
    await app.session({ type: "connect", id: 1, ...connection, path: "designmap/tokens.ios.json" });
    const iosFile = app.fake.root.getPluginData("connection");
    app.fake.root.setPluginData("connection", "");
    await app.session({ type: "connect", id: 2, ...connection });
    await app.session({ type: "disconnect" });
    await app.session({ type: "ready", id: 3 });
    expect(app.last()).toEqual({ type: "connection", repo: null });
    app.fake.root.setPluginData("connection", iosFile);
    await app.session({ type: "ready", id: 4 });
    expect(app.sent.map((m) => m.type).slice(-2)).toEqual(["connection", "plan"]);
  });

  it("asks only for a token on a computer without one for the repo the file syncs from", async () => {
    const app = plugin();
    const fetch = github(200, tokensJson({ spacing: [8] }));
    const android = { ...repo, path: "designmap/tokens.android.json" };
    app.fake.root.setPluginData("connection", JSON.stringify(android));
    await app.session({ type: "ready", id: 1 });
    expect([app.last(), fetch.mock.calls.length]).toEqual([
      { type: "connection", repo: null, saved: android },
      0,
    ]);
  });

  it("keeps no connection that couldn't read tokens.json", async () => {
    const app = plugin();
    github(401);
    await app.session({ type: "connect", id: 1, ...connection });
    expect(app.fake.stored.size).toBe(0);
  });

  it("puts GitHub's refusals in words a designer can act on", async () => {
    const app = plugin();
    const attempt = async (status: number, headers?: Record<string, string>) => {
      github(status, "", headers);
      await app.session({ type: "connect", id: 1, ...connection });
      return lastError(app);
    };
    expect(await attempt(401)).toBe(
      "GitHub didn't accept the token: it may be mistyped or expired. Check it, or make a new one, then connect again.",
    );
    expect(await attempt(403)).toBe(
      "The token can't read octo/app. Give it read access to this repo's contents.",
    );
    expect(await attempt(403, { "x-ratelimit-remaining": "0" })).toBe(
      "GitHub is limiting requests for now. Try again in a few minutes.",
    );
    expect(await attempt(404)).toMatch(/^Couldn't find designmap\/tokens\.json on main in octo\/app\./);
    expect(await attempt(404)).toContain(
      "designmap/tokens.ios.json and designmap/tokens.android.json instead",
    );
  });

  it("says when GitHub can't be reached, or the repo name isn't one", async () => {
    const app = plugin();
    vi.stubGlobal("fetch", async () => Promise.reject(new TypeError("Failed to fetch")));
    await app.session({ type: "connect", id: 1, ...connection });
    expect(lastError(app)).toBe("Couldn't reach GitHub. Check your internet connection, then try again.");
    await app.session({ type: "connect", id: 2, ...connection, repo: "https://github.com/octo/app" });
    expect(lastError(app)).toBe(
      '"https://github.com/octo/app" isn\'t a repo name. Write it as owner/name, for example octocat/my-app.',
    );
  });

  it("asks GitHub for the raw file, with the branch and path encoded", async () => {
    const app = plugin();
    const fetch = github(200, tokensJson({ spacing: [8] }));
    await app.session({
      type: "connect",
      id: 1,
      ...connection,
      branch: "feature/new look",
      path: "my app/tokens.json",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/octo/app/contents/my%20app/tokens.json?ref=feature%2Fnew%20look",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/vnd.github.raw+json" }),
      }),
    );
  });

  it("says what GitHub answered when it fails some other way", async () => {
    const app = plugin();
    github(500);
    await app.session({ type: "connect", id: 1, ...connection });
    expect(lastError(app)).toBe("GitHub answered 500 Error. Try again in a moment.");
  });

  it("refuses a path that isn't a file's path in the repo", async () => {
    const app = plugin();
    github(200);
    await app.session({ type: "connect", id: 1, ...connection, path: "/designmap/tokens.json" });
    expect(lastError(app)).toBe(
      "\"/designmap/tokens.json\" isn't a file's path in the repo. Write it like designmap/tokens.json.",
    );
  });

  it("says when the repo's tokens.json isn't valid JSON", async () => {
    const app = plugin();
    github(200, "not json");
    await app.session({ type: "connect", id: 1, ...connection });
    expect(lastError(app)).toBe(
      "The repo's tokens.json isn't valid JSON. Let CI write it again, then press Check again.",
    );
  });

  it("still shows the connection when opening can't read the repo", async () => {
    const app = plugin();
    github(200, tokensJson({ spacing: [8] }));
    await app.session({ type: "connect", id: 1, ...connection });
    github(401);
    await app.session({ type: "ready", id: 2 });
    expect(app.sent.slice(-2).map((message) => message.type)).toEqual(["connection", "error"]);
  });

  it("asks for a repo before checking one", async () => {
    const app = plugin();
    await app.session({ type: "fetch", id: 1 });
    expect(lastError(app)).toBe("Connect a repo first.");
  });

  it("tells a designer syncing from the repo to check it again when a sync stops partway", async () => {
    const app = plugin();
    github(200, tokensJson({ styles: [{ key: "body", size: 17, weight: 400 }] }));
    await app.session({ type: "connect", id: 1, ...connection });
    app.fake.api.createTextStyle = () => {
      throw new Error("Figma is unavailable");
    };
    await app.session({ type: "apply", id: 1 });
    expect(lastError(app)).toBe(
      "The sync stopped partway. Press Check again to see what is left. (Figma is unavailable)",
    );
  });

  it("refuses a path that steps outside the repo's files", async () => {
    const app = plugin();
    const fetch = github(200);
    await app.session({ type: "connect", id: 1, ...connection, path: "../secrets/tokens.json" });
    expect([lastError(app), fetch.mock.calls.length]).toEqual([
      "\"../secrets/tokens.json\" isn't a file's path in the repo. Write it like designmap/tokens.json.",
      0,
    ]);
  });

  it("reads GitHub's rate limit whatever case its header comes in", async () => {
    const app = plugin();
    github(403, "", { "X-RateLimit-Remaining": "0" });
    await app.session({ type: "connect", id: 1, ...connection });
    expect(lastError(app)).toBe("GitHub is limiting requests for now. Try again in a few minutes.");
  });

  it("says which setting to fix before asking GitHub, and keeps none of them", async () => {
    const app = plugin();
    const fetch = github(200);
    const attempt = async (change: Partial<typeof connection>) => {
      await app.session({ type: "connect", id: 1, ...connection, ...change });
      return lastError(app);
    };
    expect(await attempt({ repo: "octo/.." })).toBe(
      '"octo/.." isn\'t a repo name. Write it as owner/name, for example octocat/my-app.',
    );
    expect(await attempt({ branch: "" })).toBe("Enter the branch to read, for example main.");
    expect(await attempt({ token: "" })).toBe("Paste a GitHub token that can read this repo.");
    expect([fetch.mock.calls.length, app.fake.stored.size]).toEqual([0, 0]);
  });

  it("tells a designer syncing from the repo to check it again to fill in a Dark mode it added", async () => {
    const app = plugin({ maxModes: 2 });
    const json = tokensJson({ colors: [{ key: "bg", hex: "#ffffff", dark: "#000000" }], spacing: [8] });
    github(200, tokensJson({ spacing: [8] }));
    await app.session({ type: "connect", id: 1, ...connection });
    await app.session({ type: "apply", id: 1 });
    const [collection] = app.fake.collections.values();
    const brand = collection?.addMode("Brand") ?? "";
    github(200, json);
    await app.session({ type: "fetch", id: 2 });
    await app.session({ type: "apply", id: 2 });
    collection?.removeMode(brand);
    await app.session({ type: "fetch", id: 3 });
    await app.session({ type: "apply", id: 3 });
    expect(app.last()).toEqual({
      type: "applied",
      notes: ["Dark mode added. Press Check again to fill in the dark values."],
    });
  });

  it("always asks GitHub for the latest tokens.json, never a copy it kept", async () => {
    const app = plugin();
    const fetch = github(200, tokensJson({ spacing: [8] }));
    await app.session({ type: "connect", id: 1, ...connection });
    await app.session({ type: "fetch", id: 2 });
    expect(contentsReads(fetch)).toHaveLength(2);
    expect(fetch.mock.calls.every(([, init]) => init?.cache === "no-store")).toBe(true);
  });
});
