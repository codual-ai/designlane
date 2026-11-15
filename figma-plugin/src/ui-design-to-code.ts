/** The window's design-to-code part: the values a designer changed in Figma, the code edits planned for those ticked,
 * and the pull request opened with them. Built from text only, so no name or value can be read as markup. */

import type { FigmaChange, PlannedEdit, ToPlugin, ToWindow } from "./messages.js";

type DesignToCodeMessage = Extract<
  ToWindow,
  { type: "edits" | "writeTokenNeeded" | "pullRequest" | "designToCodeError" }
>;

const DESIGN_TO_CODE: ReadonlySet<ToWindow["type"]> = new Set([
  "edits",
  "writeTokenNeeded",
  "pullRequest",
  "designToCodeError",
]);
const GITHUB_PAGE = "https://github.com/";
const NEW_TOKEN_PAGE = "https://github.com/settings/personal-access-tokens/new";
const PROPERTY_WORDS: Record<FigmaChange["property"], string> = {
  light: "",
  dark: "dark",
  family: "font",
  size: "size",
  weight: "weight",
};

export const isDesignToCode = (message: ToWindow): message is DesignToCodeMessage =>
  DESIGN_TO_CODE.has(message.type);

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") {
  const made = document.createElement(tag);
  made.textContent = text;
  made.className = className;
  return made;
}

function button(text: string, onPress: () => void): HTMLButtonElement {
  const made = element("button", text);
  made.type = "button";
  made.addEventListener("click", onPress);
  return made;
}

/** A list row with a labelled checkbox, ticked from the start when `checked`. */
function tickable(text: string, value: string, checked: boolean): HTMLLIElement {
  const row = element("li");
  const label = element("label");
  const box = element("input");
  box.type = "checkbox";
  box.value = value;
  box.checked = checked;
  label.append(box, ` ${text}`);
  row.append(label);
  return row;
}

const ticked = (list: HTMLElement) =>
  Array.from(list.querySelectorAll<HTMLInputElement>("input[type=checkbox]"))
    .filter((box) => box.checked)
    .map((box) => box.value);

/** How a change reads: `color/brand #ff1a2e → #de2413`, `Text/body size 17 → 20`. */
function changeText({ name, property, from, to }: FigmaChange): string {
  const word = PROPERTY_WORDS[property];
  return `${name}${word ? ` ${word}` : ""} ${from} → ${to}`;
}

function tokenPage(repo: string): string {
  const [owner = ""] = repo.split("/");
  const fields = {
    name: `Designmap pull requests for ${repo}`,
    description: "Lets the Designmap Figma plugin open pull requests with design changes.",
    target_name: owner,
    contents: "write",
    pull_requests: "write",
  };
  return `${NEW_TOKEN_PAGE}?${new URLSearchParams(fields).toString()}`;
}

function link(href: string, text: string): HTMLAnchorElement {
  const made = element("a", text);
  made.href = href;
  made.target = "_blank";
  made.rel = "noopener noreferrer";
  return made;
}

/** The section for the plan `id`, listing `changes`; `repo` is the connected repo, if any. */
export function designToCode(
  id: number,
  changes: readonly FigmaChange[],
  repo: string | undefined,
  send: (message: ToPlugin) => void,
) {
  const list = element("ul");
  for (const change of changes) {
    const row = tickable(changeText(change), change.id, false);
    if (change.inCodeToo) {
      row.querySelector("input")?.setAttribute("disabled", "");
      row.append(element("p", "The code changed this too, so it can't be opened as an edit.", "note"));
    }
    list.append(row);
  }
  /** The planned edits, the token form, and a line saying what's under way, what failed or what was opened. */
  const editsArea = element("div");
  const tokenArea = element("div");
  const note = element("div");
  note.setAttribute("role", "status");
  const say = (text: string, className = "") => note.replaceChildren(element("p", text, className));

  const planButton = button("Plan code edits", () => {
    planButton.disabled = true;
    editsArea.replaceChildren();
    tokenArea.replaceChildren();
    say(`Reading the code from ${repo}…`);
    send({ type: "planEdits", id, changes: ticked(list) });
  });
  const refreshPlanButton = () => {
    planButton.disabled = ticked(list).length === 0;
  };
  list.addEventListener("change", refreshPlanButton);
  refreshPlanButton();

  let edits = element("ul");
  let openButton: HTMLButtonElement | undefined;
  const refreshOpenButton = () => {
    if (openButton) openButton.disabled = ticked(edits).length === 0;
  };
  const pullRequest = (token?: string) => {
    if (openButton) openButton.disabled = true;
    tokenArea.replaceChildren();
    say(`Opening a pull request on ${repo}…`);
    send({ type: "openPullRequest", id, changes: ticked(edits), ...(token === undefined ? {} : { token }) });
  };

  function showEdits(planned: PlannedEdit[]): void {
    const byId = new Map(changes.map((change) => [change.id, change]));
    edits = element("ul");
    for (const edit of planned) {
      const change = byId.get(edit.change);
      const name = change ? changeText(change) : edit.change;
      edits.append(
        edit.ok
          ? tickable(`${name}: ${edit.file}:${edit.line} ${edit.before} → ${edit.after}`, edit.change, true)
          : element("li", `${name}: can't be edited. ${edit.reason}`),
      );
    }
    openButton = button("Open pull request", () => pullRequest());
    openButton.className = "primary";
    edits.addEventListener("change", refreshOpenButton);
    refreshOpenButton();
    editsArea.replaceChildren(element("h2", "Code edits"), edits, openButton);
    note.replaceChildren();
    refreshPlanButton();
  }

  function askForToken({ repo: needed, reason }: Extract<ToWindow, { type: "writeTokenNeeded" }>): void {
    const label = element("label", "GitHub token that can open pull requests");
    const input = element("input");
    input.type = "password";
    input.autocomplete = "off";
    label.append(input);
    const save = button("Save token and open pull request", () => {
      const token = input.value.trim();
      input.value = "";
      pullRequest(token);
    });
    save.className = "primary";
    const explanation = element(
      "p",
      `Opening a pull request needs a token that can write to ${needed}: a fine-grained token for this repo only, with Contents and Pull requests both set to Read and write. The read-only token you connected with stays for syncing. This one also stays on this computer, and is only sent to GitHub.`,
      "hint",
    );
    tokenArea.replaceChildren(explanation, link(tokenPage(needed), "Make the token on GitHub"), label, save);
    if (reason) say(reason, "error");
    else note.replaceChildren();
    input.focus();
  }

  function showPullRequest(url: string): void {
    const opened = element("p", "Pull request opened: ");
    opened.append(url.startsWith(GITHUB_PAGE) ? link(url, url) : url);
    note.replaceChildren(opened);
    openButton?.remove();
    openButton = undefined;
    refreshPlanButton();
  }

  function showError(message: string): void {
    const error = element("p", message, "error");
    error.setAttribute("role", "alert");
    note.replaceChildren(error);
    refreshOpenButton();
    refreshPlanButton();
  }

  const section = element("section");
  section.append(
    element("h2", `Changed in Figma, not in code (${changes.length})`),
    element(
      "p",
      "Apply sets these back to the code's values. To keep them, open a pull request with the code edits.",
      "hint",
    ),
    list,
    repo ? planButton : element("p", "Connect the app's repo to open these as a pull request.", "hint"),
    editsArea,
    tokenArea,
    note,
  );
  return {
    section,
    /** Shows a message from the Figma side, when it's for this section's plan. */
    receive(message: DesignToCodeMessage): void {
      if (message.id !== id) return;
      if (message.type === "edits") showEdits(message.edits);
      else if (message.type === "writeTokenNeeded") askForToken(message);
      else if (message.type === "pullRequest") showPullRequest(message.url);
      else showError(message.message);
    },
  };
}
