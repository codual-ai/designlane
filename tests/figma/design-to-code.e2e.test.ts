import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recolor, restyle } from "../helpers/figma-plugin.js";
import {
  BRANCH,
  brandChanged,
  COLLECTION,
  type ConnectedShop,
  closeServers,
  connectedShop,
  copyOf,
  designmap,
  filesIn,
  REPO,
  withSpanReplaced,
} from "../helpers/scanned-shop.js";
import { READ_TOKEN, TOKENS_PATH, WRITE_TOKEN } from "../helpers/shop-repo.js";

const NOW = new Date("2026-11-14T10:00:00Z");
const BRANCH_NAME = /^designmap\/figma-2026-11-14-[0-9a-f]{7}$/;
const ONE_VALUE = "Design changes from Figma: 1 value";
const OPENING = ["POST git/blobs", "POST git/trees", "POST git/commits", "POST git/refs", "POST pulls"];
const BRANCH_IN_PATH = /figma-\S+/;

interface Case {
  title: string;
  /** What the designer does in Figma. */
  change: (shop: ConnectedShop) => void | Promise<void>;
  token: string;
  property: string;
  from: string;
  to: string;
  label: string;
  /** Where tokens.json holds the value, and what it is once designmap reads the edited code. */
  inTokens: string[];
  expected: unknown;
}

const CASES: Case[] = [
  {
    title: "a colour's light value",
    change: (shop) => recolor(shop.fake, "color/Brand", "Light", "#de2413", COLLECTION),
    token: "Brand",
    property: "light",
    from: "#ff1a2e",
    to: "#de2413",
    label: "color/Brand",
    inTokens: ["color", "Brand", "$value", "hex"],
    expected: "#de2413",
  },
  {
    title: "a colour's dark value",
    change: (shop) => recolor(shop.fake, "color/Brand", "Dark", "#200a0c", COLLECTION),
    token: "Brand",
    property: "dark",
    from: "#ff5566",
    to: "#200a0c",
    label: "color/Brand's dark colour",
    inTokens: ["color", "Brand", "$extensions", "designmap", "modes", "dark", "hex"],
    expected: "#200a0c",
  },
  {
    title: "a text style's size",
    change: (shop) => restyle(shop.fake, "Text/display", { size: 40 }),
    token: "display",
    property: "size",
    from: "34",
    to: "40",
    label: "Text/display's font size",
    inTokens: ["typography", "display", "fontSize", "$value", "value"],
    expected: 40,
  },
];

/** The value at `keys` in parsed JSON, or undefined where there's none. */
const valueAt = (json: unknown, keys: string[]): unknown =>
  keys.reduce<unknown>(
    (value, key) =>
      value !== null && typeof value === "object"
        ? Object.entries(value).find(([k]) => k === key)?.[1]
        : undefined,
    json,
  );

const routes = (shop: ConnectedShop, from?: number) =>
  shop.writesSince(from).map(({ method, path }) => `${method} ${path.replace(BRANCH_IN_PATH, "figma-…")}`);

describe("design to code, end to end, against GitHub's API on a local server", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await closeServers();
  });

  it.each(CASES)("opens a pull request for $title that designmap then reads back", async (testCase) => {
    const shop = await connectedShop();
    const { server } = shop;
    const head = server.refs.get(BRANCH) ?? "";
    await testCase.change(shop);
    const changes = await shop.check();
    expect(changes).toMatchObject([
      { token: testCase.token, property: testCase.property, from: testCase.from, to: testCase.to },
    ]);
    const [edit] = await shop.planEdits(changes);
    if (!edit?.ok) throw new Error(`expected an edit, got ${JSON.stringify(edit)}`);

    const from = server.requests.length;
    expect(await shop.openPullRequest(changes, WRITE_TOKEN)).toEqual({
      type: "pullRequest",
      id: expect.any(Number),
      url: `https://github.com/${REPO}/pull/1`,
    });
    const writes = shop.writesSince(from);
    expect(routes(shop, from)).toEqual(OPENING);
    expect(new Set(writes.map((request) => request.token))).toEqual(new Set([WRITE_TOKEN]));

    const original = (await filesIn(shop.app)).get(edit.file) ?? "";
    const editedByCli = await copyOf(shop.app);
    await designmap("edit", testCase.token, testCase.property, testCase.to, "--dir", editedByCli);
    const expected = await readFile(path.join(editedByCli, edit.file), "utf8");
    expect(expected).not.toBe(original);
    expect(withSpanReplaced(original, edit)).toBe(expected);
    expect(writes[0]?.body).toEqual({ content: expected, encoding: "utf-8" });

    const blobSha = execFileSync("git", ["hash-object", "--stdin"], {
      input: expected,
      encoding: "utf8",
    }).trim();
    expect(writes[1]?.body).toEqual({
      base_tree: server.git.commits.get(head)?.tree,
      tree: [{ path: edit.file, mode: "100644", type: "blob", sha: blobSha }],
    });
    expect(writes[2]?.body).toMatchObject({ parents: [head], message: ONE_VALUE });
    const [pull] = server.pulls;
    const branch = pull?.head ?? "";
    expect(branch).toMatch(BRANCH_NAME);
    expect(writes[3]?.body).toEqual({ ref: `refs/heads/${branch}`, sha: server.refs.get(branch) });
    expect(server.git.commits.get(server.refs.get(branch) ?? "")).toMatchObject({ parents: [head] });
    expect(pull).toMatchObject({ head: branch, base: BRANCH, title: ONE_VALUE });
    expect(pull?.body).toContain(
      `- \`${testCase.label}\`: \`${testCase.from}\` → \`${testCase.to}\`, in \`${edit.file}:${edit.line}\``,
    );

    const onMain = server.filesOn(BRANCH);
    const committed = new Map(
      [...server.filesOn(branch)].filter(([file, text]) => onMain.get(file) !== text),
    );
    expect([...committed.keys()]).toEqual([edit.file]);
    const merged = await copyOf(shop.app, committed);
    await designmap(merged);
    const tokensJson = await readFile(path.join(merged, TOKENS_PATH), "utf8");
    expect(valueAt(JSON.parse(tokensJson), testCase.inTokens)).toBe(testCase.expected);
    server.push(new Map([...committed, [TOKENS_PATH, tokensJson]]));
    expect(await shop.check()).toEqual([]);
  });

  it("shows why the edit engine refuses a change, and opens nothing", async () => {
    const shop = await connectedShop();
    await restyle(shop.fake, "Text/headline", { size: 20 });
    const changes = await shop.check();
    expect(changes).toMatchObject([{ token: "headline", property: "size", to: "20" }]);
    expect(await shop.planEdits(changes)).toEqual([
      {
        ok: false,
        change: changes[0]?.id,
        reason:
          "tokens.json doesn't say where headline's font size is written: the code may work it out from another value. Change it in the code.",
      },
    ]);
    expect(await shop.openPullRequest(changes, WRITE_TOKEN)).toMatchObject({
      type: "designToCodeError",
      message: "Tick at least one edit to open a pull request.",
    });
    expect(shop.writesSince()).toEqual([]);
  });

  it("asks for a token again when GitHub answers 401 or 403 to a write, and writes with the next one", async () => {
    const { shop, changes } = await brandChanged();
    expect(await shop.openPullRequest(changes, "github_pat_expired")).toEqual({
      type: "writeTokenNeeded",
      id: expect.any(Number),
      repo: REPO,
      reason:
        "GitHub didn't accept the token: it may be mistyped or expired. Make a new one and paste it here.",
    });
    expect(await shop.openPullRequest(changes)).toMatchObject({ type: "writeTokenNeeded", repo: REPO });
    expect(await shop.openPullRequest(changes, READ_TOKEN)).toMatchObject({
      type: "writeTokenNeeded",
      reason: `The token can't open pull requests on ${REPO}. Give it access to this repo with Contents and Pull requests, both Read and write.`,
    });
    expect([...shop.server.refs.keys()]).toEqual([BRANCH]);
    expect(await shop.openPullRequest(changes, WRITE_TOKEN)).toMatchObject({ type: "pullRequest" });
    expect(shop.server.pulls).toHaveLength(1);
  });

  it("says plainly when GitHub answers 422 because the branch is there already", async () => {
    const { shop, changes } = await brandChanged();
    expect(await shop.openPullRequest(changes, WRITE_TOKEN)).toMatchObject({ type: "pullRequest" });
    const branch = shop.server.pulls[0]?.head;
    // The same edits on the same commit within a second make the same commit, so its branch is there already.
    await shop.planEdits(changes);
    const from = shop.server.requests.length;
    expect(await shop.openPullRequest(changes)).toEqual({
      type: "designToCodeError",
      id: expect.any(Number),
      message: `Couldn't make the branch ${branch} on ${REPO}: it's there already. Press Open pull request again.`,
    });
    expect(routes(shop, from)).toEqual(OPENING.slice(0, -1));
    expect(shop.server.pulls).toHaveLength(1);
  });

  it("deletes the branch when GitHub won't open the pull request, saying what GitHub answered", async () => {
    const { shop, changes } = await brandChanged();
    shop.server.refuse("POST", "pulls", 422, "Validation Failed");
    expect(await shop.openPullRequest(changes, WRITE_TOKEN)).toMatchObject({
      type: "designToCodeError",
      message: "GitHub answered 422. Try again in a moment.",
    });
    expect(routes(shop)).toEqual([...OPENING, "DELETE git/refs/heads/designmap/figma-…"]);
    expect([...shop.server.refs.keys()]).toEqual([BRANCH]);
    expect(shop.server.pulls).toEqual([]);
  });
});
