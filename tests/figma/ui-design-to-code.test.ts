// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FigmaChange, PlanSummary } from "../../figma-plugin/src/messages.js";
import { brandChange as brand } from "../helpers/figma-change.js";
import { openWindow, summary } from "../helpers/plugin-window.js";

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
async function withChanges(changes: FigmaChange[], connected = true, more: Partial<PlanSummary> = {}) {
  const ui = await openWindow();
  if (connected)
    ui.receive({
      type: "connection",
      repo: { repo: "octo/app", branch: "main", path: "designlane/tokens.json" },
    });
  ui.receive({ type: "plan", id: 1, summary: { ...summary, ...more, figmaChanges: changes } });
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
    expect(text).toContain(
      "Apply keeps these as you changed them until their pull request is merged, or until you set one back to the code's value.",
    );
    expect(text).not.toContain("Couldn't check GitHub");
  });

  it("plans edits for the changes ticked, only once one is", async () => {
    const ui = await withChanges([brand, body]);
    expect(ui.button("Plan code edits").disabled).toBe(true);
    ui.tick("Text/body");
    ui.button("Plan code edits").click();
    expect(ui.sent.at(-1)).toEqual({ type: "planEdits", id: 1, changes: ["S:2 size"] });
    expect(ui.result.textContent).toContain("Reading the code from octo/app…");
  });

  it("shows both values of a change the code made too, to tick once the designer picks Use mine", async () => {
    const ui = await withChanges([ink, brand]);
    expect(ui.result.textContent).toContain("color/ink dark Code: #ff1a2e · Yours: #de2413");
    expect(ui.box("color/ink").disabled).toBe(true);
    ui.box("Use mine").click();
    expect(ui.box("color/ink").disabled).toBe(false);
    ui.tick("color/ink");
    ui.button("Plan code edits").click();
    expect(ui.sent.at(-1)).toEqual({ type: "planEdits", id: 1, changes: [ink.id] });
    expect(ui.result.querySelector("legend")?.textContent).toMatch(
      /^color\/ink dark: the code changed this too/,
    );
    ui.receive({
      type: "edits",
      id: 1,
      edits: [{ ok: true, change: ink.id, file: "a.ts", line: 1, before: "a", after: "b" }],
    });
    expect(ui.button("Open pull request").disabled).toBe(false);
    ui.box("Keep the code's").click();
    expect([ui.box("color/ink").disabled, ui.box("color/ink").checked]).toEqual([true, false]);
    expect(ui.button("Plan code edits").disabled).toBe(true);
    expect(ui.result.textContent).not.toContain("Code edits");
    expect([...ui.result.querySelectorAll("button")].map((b) => b.textContent)).not.toContain(
      "Open pull request",
    );
  });

  it("tells Apply which changes made in the code too the designer keeps the code's value for", async () => {
    const sky = { ...ink, id: "V:4 light", name: "color/sky", property: "light" as const };
    const ui = await withChanges([ink, sky]);
    const radios = [...ui.result.querySelectorAll<HTMLInputElement>("input[type=radio]")];
    expect(radios.map((radio) => radio.closest("label")?.textContent?.trim())).toEqual([
      "Keep the code's",
      "Use mine",
      "Keep the code's",
      "Use mine",
    ]);
    radios[0]?.click();
    radios[3]?.click();
    ui.apply.click();
    expect(ui.sent.at(-1)).toEqual({ type: "apply", id: 1, keepCode: [ink.id] });
  });

  it("sets a change only Figma has back to the code's value on Apply, once the designer chooses that", async () => {
    const ui = await withChanges([brand, body]);
    const setBack = ui.box("Set back to the code's value");
    expect(setBack.getAttribute("aria-label")).toBe("Set back to the code's value: color/brand, #ff1a2e");
    ui.tick("color/brand");
    ui.receive({
      type: "edits",
      id: 1,
      edits: [{ ok: true, change: brand.id, file: "a.ts", line: 1, before: "a", after: "b" }],
    });
    setBack.click();
    expect([ui.box("color/brand").disabled, ui.box("color/brand").checked]).toEqual([true, false]);
    expect(ui.button("Plan code edits").disabled).toBe(true);
    expect(ui.result.textContent).not.toContain("Code edits");
    ui.apply.click();
    expect(ui.sent.at(-1)).toEqual({ type: "apply", id: 1, keepCode: [brand.id] });
  });

  it("offers setting a change back from a picked file, which has no pull request to wait for", async () => {
    const ui = await withChanges([brand], false);
    ui.box("Set back to the code's value").click();
    ui.box("Set back to the code's value").click();
    expect(ui.box("color/brand").disabled).toBe(false);
    ui.box("Set back to the code's value").click();
    ui.apply.click();
    expect(ui.sent.at(-1)).toEqual({ type: "apply", id: 1, keepCode: [brand.id] });
  });

  it("shows a change already in an open pull request with its link, and nothing to tick", async () => {
    const url = "https://github.com/octo/app/pull/3";
    const ui = await withChanges([{ ...brand, pullRequest: url }]);
    expect(ui.result.textContent).toContain(`color/brand #ff1a2e → #de2413: Pull request open: ${url}`);
    expect(ui.result.querySelector("a")?.getAttribute("href")).toBe(url);
    expect(ui.result.querySelectorAll("input")).toHaveLength(0);
  });

  it("says quietly when GitHub couldn't list the open pull requests, and still offers the changes", async () => {
    const ui = await withChanges([brand], true, { pullRequestsUnlisted: true });
    expect(ui.result.textContent).toContain(
      "Couldn't check GitHub for open pull requests, so one of these may be in one already.",
    );
    expect(ui.box("color/brand").disabled).toBe(false);
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
    expect(ui.result.querySelectorAll("input[type=checkbox]:not([data-change])")).toHaveLength(3);
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
