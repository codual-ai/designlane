// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FigmaChange } from "../../figma-plugin/src/messages.js";
import { openWindow, summary } from "../helpers/plugin-window.js";

const brand: FigmaChange = {
  id: "V:1 light",
  name: "color/brand",
  token: "brand",
  property: "light",
  from: "#ff1a2e",
  to: "#de2413",
  inCodeToo: false,
};
const body: FigmaChange = {
  ...brand,
  id: "S:2 size",
  name: "Text/body",
  token: "body",
  property: "size",
  from: "17",
  to: "20",
};
const ink: FigmaChange = {
  ...brand,
  id: "V:3 dark",
  name: "color/ink",
  token: "ink",
  property: "dark",
  inCodeToo: true,
};

/** The window connected to octo/app, showing a plan whose Figma changes are `changes`. */
async function withChanges(changes: FigmaChange[], connected = true) {
  const ui = await openWindow();
  if (connected)
    ui.receive({
      type: "connection",
      repo: { repo: "octo/app", branch: "main", path: "designmap/tokens.json" },
    });
  ui.receive({ type: "plan", id: 1, summary: { ...summary, figmaChanges: changes } });
  const button = (name: string) => {
    const found = [...ui.result.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === name,
    );
    if (!found) throw new Error(`no button ${name}: ${ui.result.textContent}`);
    return found;
  };
  const box = (text: string) => {
    const label = [...ui.result.querySelectorAll("label")].find((candidate) =>
      candidate.textContent?.includes(text),
    );
    const input = label?.querySelector("input");
    if (!input) throw new Error(`no checkbox for ${text}`);
    return input;
  };
  const tick = (text: string) => box(text).click();
  return { ...ui, button, box, tick };
}

describe("the window's changes made in Figma", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("lists each change made in Figma, apart from the plan, with what Apply would do to it", async () => {
    const ui = await withChanges([brand, body]);
    const text = ui.result.textContent ?? "";
    expect(text).toContain("Changed in Figma, not in code (2)");
    expect(text).toContain("color/brand #ff1a2e → #de2413");
    expect(text).toContain("Text/body size 17 → 20");
    expect(text).toContain("Apply sets these back to the code's values.");
  });

  it("plans edits for the changes ticked, only once one is", async () => {
    const ui = await withChanges([brand, body]);
    expect(ui.button("Plan code edits").disabled).toBe(true);
    ui.tick("Text/body");
    ui.button("Plan code edits").click();
    expect(ui.sent.at(-1)).toEqual({ type: "planEdits", id: 1, changes: ["S:2 size"] });
    expect(ui.result.textContent).toContain("Reading the code from octo/app…");
  });

  it("can't tick a change the code made too, and says why", async () => {
    const ui = await withChanges([ink]);
    expect(ui.box("color/ink").disabled).toBe(true);
    expect(ui.result.textContent).toContain("The code changed this too, so it can't be opened as an edit.");
  });

  it("asks for a connected repo instead of offering edits from a picked file", async () => {
    const ui = await withChanges([brand], false);
    expect(ui.result.querySelectorAll("button")).toHaveLength(0);
    expect(ui.result.textContent).toContain("Connect the app's repo to open these as a pull request.");
  });

  it("shows each planned edit ticked and each refusal with its reason, and opens a pull request with those ticked", async () => {
    const ui = await withChanges([brand, body]);
    ui.receive({
      type: "edits",
      id: 1,
      edits: [
        { ok: true, change: brand.id, file: "src/theme.ts", line: 1, before: "#FF1A2E", after: "#DE2413" },
        { ok: false, change: body.id, reason: "tokens.json doesn't say where body's font size is written." },
      ],
    });
    const text = ui.result.textContent ?? "";
    expect(text).toContain("color/brand #ff1a2e → #de2413: src/theme.ts:1 #FF1A2E → #DE2413");
    expect(text).toContain(
      "Text/body size 17 → 20: can't be edited. tokens.json doesn't say where body's font size is written.",
    );
    expect(ui.box("src/theme.ts:1").checked).toBe(true);
    expect(ui.result.querySelectorAll("input[type=checkbox]")).toHaveLength(3);
    ui.button("Open pull request").click();
    expect(ui.sent.at(-1)).toEqual({ type: "openPullRequest", id: 1, changes: [brand.id] });
    expect(ui.button("Open pull request").disabled).toBe(true);
    expect(ui.result.textContent).toContain("Opening a pull request on octo/app…");
  });

  it("asks for a token that can write, linking to GitHub's form with those permissions, and sends it once", async () => {
    const ui = await withChanges([brand]);
    ui.receive({
      type: "edits",
      id: 1,
      edits: [{ ok: true, change: brand.id, file: "a.ts", line: 1, before: "a", after: "b" }],
    });
    ui.receive({
      type: "writeTokenNeeded",
      id: 1,
      repo: "octo/app",
      reason: "The token can't open pull requests on octo/app.",
    });
    expect(ui.result.textContent).toContain("Contents and Pull requests both set to Read and write");
    expect(ui.result.querySelector(".error")?.textContent).toBe(
      "The token can't open pull requests on octo/app.",
    );
    const link = ui.result.querySelector("a");
    const url = new URL(link?.href ?? "");
    expect([
      url.origin + url.pathname,
      url.searchParams.get("contents"),
      url.searchParams.get("pull_requests"),
    ]).toEqual(["https://github.com/settings/personal-access-tokens/new", "write", "write"]);
    const input = ui.result.querySelector<HTMLInputElement>("input[type=password]");
    if (!input) throw new Error("no token field");
    expect(input.closest("label")?.textContent).toBe("GitHub token that can open pull requests");
    input.value = " github_pat_write ";
    ui.button("Save token and open pull request").click();
    expect(ui.sent.at(-1)).toEqual({
      type: "openPullRequest",
      id: 1,
      changes: [brand.id],
      token: "github_pat_write",
    });
    expect(ui.result.querySelector("input[type=password]")).toBeNull();
  });

  it("links the pull request opened, and only a GitHub page", async () => {
    const ui = await withChanges([brand]);
    ui.receive({ type: "pullRequest", id: 1, url: "https://github.com/octo/app/pull/7" });
    expect(ui.result.querySelector("a")?.getAttribute("href")).toBe("https://github.com/octo/app/pull/7");
    expect(ui.result.textContent).toContain("Pull request opened: https://github.com/octo/app/pull/7");
    ui.receive({ type: "pullRequest", id: 1, url: "https://example.com/x" });
    expect(ui.result.querySelector("a")).toBeNull();
  });

  it("shows a failure beside the plan, and lets the designer try again", async () => {
    const ui = await withChanges([brand]);
    ui.tick("color/brand");
    ui.button("Plan code edits").click();
    ui.receive({ type: "designToCodeError", id: 1, message: "Couldn't reach GitHub." });
    const alert = ui.result.querySelector("[role=alert]");
    expect(alert?.textContent).toBe("Couldn't reach GitHub.");
    expect(ui.result.textContent).not.toContain("Reading the code");
    expect(ui.result.textContent).toContain("Changed in Figma, not in code (1)");
    expect(ui.button("Plan code edits").disabled).toBe(false);
  });

  it("ignores what comes for a plan no longer on screen", async () => {
    const ui = await withChanges([brand]);
    ui.receive({ type: "designToCodeError", id: 9, message: "stale" });
    expect(ui.result.textContent).not.toContain("stale");
  });
});
