/** The window's design-to-code part: the values a designer changed in Figma, the code edits planned for those ticked,
 * and the pull request opened with them. Built from text only, so no name or value can be read as markup. */

import type { PlannedEdit, PlanSummary, ToPlugin, ToWindow } from "./messages.js";
import { button, element, gitHubLink, tickable, ticked } from "./ui-elements.js";
import { changeText, figmaChangeList } from "./ui-figma-changes.js";

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
const NEW_TOKEN_PAGE = "https://github.com/settings/personal-access-tokens/new";
const KEPT = "Apply keeps these as you changed them until their pull request is merged.";
const UNLISTED =
  "Couldn't check GitHub for open pull requests, so one of these may be in one already. To check, give the read-only token read access to pull requests.";

export const isDesignToCode = (message: ToWindow): message is DesignToCodeMessage =>
  DESIGN_TO_CODE.has(message.type);

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

/** The section for the plan `id`, listing its changes made in Figma; `repo` is the connected repo, if any. */
export function designToCode(
  id: number,
  { figmaChanges: changes, pullRequestsUnlisted }: Pick<PlanSummary, "figmaChanges" | "pullRequestsUnlisted">,
  repo: string | undefined,
  send: (message: ToPlugin) => void,
) {
  const { list, keepCode } = figmaChangeList(changes);
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
    tokenArea.replaceChildren(
      explanation,
      gitHubLink(tokenPage(needed), "Make the token on GitHub"),
      label,
      save,
    );
    if (reason) say(reason, "error");
    else note.replaceChildren();
    input.focus();
  }

  function showPullRequest(url: string): void {
    const opened = element("p", "Pull request opened: ");
    opened.append(gitHubLink(url));
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
    element("p", KEPT, "hint"),
    ...(repo && pullRequestsUnlisted ? [element("p", UNLISTED, "hint")] : []),
    list,
    repo ? planButton : element("p", "Connect the app's repo to open these as a pull request.", "hint"),
    editsArea,
    tokenArea,
    note,
  );
  return {
    section,
    keepCode,
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
