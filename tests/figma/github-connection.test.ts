import { afterEach, describe, expect, it, vi } from "vitest";
import { plugin } from "../helpers/figma-plugin.js";
import { connection, contentsReads, github, repo } from "../helpers/github-fetch.js";
import { tokensJson } from "../helpers/tokens-json.js";

describe("connecting a GitHub repo", () => {
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
});
