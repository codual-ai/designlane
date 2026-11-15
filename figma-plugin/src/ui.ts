/** The plugin's window: connects a repo or reads a requested tokens.json, shows the plan in words, and asks the Figma
 * side to apply it. */

import { type PlanSummary, type RepoSource, type ToPlugin, toWindow } from "./messages.js";
import { designToCode, isDesignToCode } from "./ui-design-to-code.js";

/** The window's element with `id`, which ui.html must have, of the kind expected. */
function element<T extends HTMLElement>(id: string, kind: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof kind)) throw new Error(`ui.html has no ${kind.name} #${id}`);
  return found;
}

const connectForm = element("connect", HTMLElement);
const connected = element("connected", HTMLElement);
const connectedTo = element("connected-to", HTMLSpanElement);
const refresh = element("refresh", HTMLButtonElement);
const disconnect = element("disconnect", HTMLButtonElement);
const connectButton = element("connect-button", HTMLButtonElement);
const file = element("file", HTMLInputElement);
const result = element("result", HTMLDivElement);
const apply = element("apply", HTMLButtonElement);

const send = (message: ToPlugin) => parent.postMessage({ pluginMessage: message }, "*");

/** The latest plan asked for, and the plan on screen: only the latest is shown, and only the plan shown applied. */
let requested = 0;
let shown: number | undefined;
/** The repo connected, named in the window's status lines. */
let connectedRepo: string | undefined;
/** The design-to-code part of the plan on screen, if it found changes made in Figma. */
let changedInFigma: ReturnType<typeof designToCode> | undefined;

/** A heading and a list, built from text only so a token's name can never be read as markup. */
function section(title: string, items: readonly string[]): HTMLElement {
  const block = document.createElement("section");
  const heading = document.createElement("h2");
  heading.textContent = `${title} (${items.length})`;
  const list = document.createElement("ul");
  for (const item of items) {
    const row = document.createElement("li");
    row.textContent = item;
    list.append(row);
  }
  block.append(heading, list);
  return block;
}

function paragraph(text: string, className = ""): HTMLElement {
  const p = document.createElement("p");
  p.className = className;
  p.textContent = text;
  return p;
}

function showPlan(id: number, summary: PlanSummary): void {
  shown = id;
  changedInFigma =
    summary.figmaChanges.length > 0 ? designToCode(id, summary.figmaChanges, connectedRepo, send) : undefined;
  const blocks = [
    ["New", summary.create],
    ["Changed", summary.update],
    ["Back in the code", summary.restore],
    ["Renamed in the code", summary.rename.map(({ from, to }) => `${from} → ${to}`)],
    ["No longer in the code (marked deprecated, not deleted)", summary.deprecate],
    ["Left out: this file doesn't have their font", summary.missingFonts],
  ] as const;
  const notes = [
    [
      summary.darkLeftOut,
      "Dark values are left out: the Designmap collection couldn't take a Dark mode on this Figma plan. Apply tries again.",
    ],
    [summary.partial, "The scan couldn't read the whole app, so nothing is marked deprecated."],
    [summary.renamesSkipped, "Too much changed at once to spot renames, so renamed tokens show as new."],
  ] as const;
  result.replaceChildren(
    ...blocks.filter(([, items]) => items.length > 0).map(([title, items]) => section(title, items)),
    paragraph(`${summary.unchanged} unchanged.`),
    ...notes.filter(([shows]) => shows).map(([, text]) => paragraph(text, "note")),
    ...(changedInFigma ? [changedInFigma.section] : []),
  );
  apply.disabled = !summary.applicable;
}

/** Starts a new plan: what was on screen can no longer be applied. */
function nextPlan(status: string): number {
  shown = undefined;
  changedInFigma = undefined;
  apply.disabled = true;
  result.replaceChildren(paragraph(status));
  return ++requested;
}

const checking = (repo: string | undefined) => `Checking ${repo ?? "the repo"} for changes…`;

/** Shows the repo connected, or the form to connect one. Any typed token is cleared: it's never shown again. */
/** Shows the connected repo, or the form to connect one, filled with the repo the file syncs from when it's `saved`. */
function showConnection(source: RepoSource | null, saved?: RepoSource): void {
  connectedRepo = source?.repo;
  for (const [id, value] of Object.entries(saved ?? {})) element(id, HTMLInputElement).value = value;
  connectForm.hidden = source !== null;
  connected.hidden = source === null;
  connectedTo.textContent = source ? `Connected to ${source.repo} (${source.branch})` : "";
  element("token", HTMLInputElement).value = "";
  result.replaceChildren(...(source ? [paragraph(checking(source.repo))] : []));
}

const field = (id: string) => element(id, HTMLInputElement).value.trim();

connectButton.addEventListener("click", () => {
  const repo = field("repo");
  const id = nextPlan(`Connecting to ${repo}…`);
  send({ type: "connect", id, repo, branch: field("branch"), path: field("path"), token: field("token") });
});
refresh.addEventListener("click", () => {
  send({ type: "fetch", id: nextPlan(checking(connectedRepo)) });
});
disconnect.addEventListener("click", () => {
  nextPlan("Disconnecting…");
  send({ type: "disconnect" });
});

file.addEventListener("change", async () => {
  const chosen = file.files?.[0];
  if (!chosen) return;
  const id = nextPlan(`Reading ${chosen.name}…`);
  try {
    const json = await chosen.text();
    if (id === requested) send({ type: "plan", id, json });
  } catch {
    if (id === requested)
      result.replaceChildren(paragraph("That file couldn't be read. Pick it again.", "error"));
  } finally {
    // So picking the same file again, after it changed, plans it again.
    file.value = "";
  }
});
/** While an apply runs, nothing that would replace its result can be pressed. */
function setApplying(applying: boolean): void {
  for (const control of [file, refresh, disconnect, connectButton]) control.disabled = applying;
}

apply.addEventListener("click", () => {
  if (shown === undefined) return;
  apply.disabled = true;
  setApplying(true);
  send({ type: "apply", id: shown });
  shown = undefined;
});
element("close", HTMLButtonElement).addEventListener("click", () => send({ type: "close" }));

window.onmessage = (event: MessageEvent<unknown>) => {
  const data = event.data;
  const message = toWindow(
    typeof data === "object" && data !== null && "pluginMessage" in data ? data.pluginMessage : undefined,
  );
  if (!message) return;
  if (message.type === "connection") return showConnection(message.repo, message.saved);
  if (isDesignToCode(message)) return changedInFigma?.receive(message);
  if (message.type === "plan" && message.id !== requested) return;
  setApplying(false);
  if (message.type !== "plan") changedInFigma = undefined;
  if (message.type === "plan") showPlan(message.id, message.summary);
  else if (message.type === "applied") {
    const done = message.notes.length
      ? "Synced, with the notes below."
      : "Synced. Your variables and text styles now match the code.";
    result.replaceChildren(paragraph(done), ...message.notes.map((note) => paragraph(note, "note")));
  } else if (message.type === "error") {
    shown = undefined;
    apply.disabled = true;
    result.replaceChildren(paragraph(message.message, "error"));
  }
};

send({ type: "ready", id: nextPlan("Opening…") });
