/** The window's list of values a designer changed in Figma: each to tick for a code edit, already in an open pull
 * request, or changed in the code too, with the designer's choice of value. */

import type { FigmaChange } from "./messages.js";
import { choice, element, gitHubLink, tickable } from "./ui-elements.js";

const PROPERTY_WORDS: Record<FigmaChange["property"], string> = {
  light: "",
  dark: "dark",
  family: "font",
  size: "size",
  weight: "weight",
};
const KEEP_CODE = "code";
const USE_MINE = "mine";

const nameOf = ({ name, property }: FigmaChange) => {
  const word = PROPERTY_WORDS[property];
  return word ? `${name} ${word}` : name;
};

/** How a change reads: `color/brand #ff1a2e → #de2413`, `Text/body size 17 → 20`. */
export const changeText = (change: FigmaChange) => `${nameOf(change)} ${change.from} → ${change.to}`;

function inPullRequest(change: FigmaChange, url: string): HTMLLIElement {
  const row = element("li", `${changeText(change)}: `);
  const open = element("span", "Pull request open: ");
  open.append(gitHubLink(url));
  row.append(open);
  return row;
}

/** A change the code made too: its box can be ticked once the designer picks Use mine, and Keep the code's lets
 * Apply set it to the code's value. */
function conflict(change: FigmaChange): HTMLLIElement {
  const row = tickable(`${nameOf(change)} Code: ${change.from} · Yours: ${change.to}`, change.id, false);
  const box = row.querySelector("input");
  box?.setAttribute("disabled", "");
  const choices = element("fieldset");
  choices.append(
    element(
      "legend",
      `${nameOf(change)}: the code changed this too. Keep the code's, which Apply sets, or use yours in a pull request:`,
      "hint",
    ),
  );
  for (const [value, text] of [
    [KEEP_CODE, "Keep the code's"],
    [USE_MINE, "Use mine"],
  ] as const) {
    const label = choice("radio", text, value);
    const radio = label.querySelector("input");
    if (radio) {
      radio.name = `choice ${change.id}`;
      radio.dataset.change = change.id;
    }
    choices.append(label);
  }
  choices.addEventListener("change", (event) => {
    if (!box || !(event.target instanceof HTMLInputElement)) return;
    box.disabled = event.target.value !== USE_MINE;
    if (box.disabled) box.checked = false;
  });
  row.append(choices);
  return row;
}

/** A change only Figma has: its box ticks it for a code edit, unless the designer sets it back to the code's value,
 * which Apply then sets. */
function figmaOnly(change: FigmaChange): HTMLLIElement {
  const row = tickable(changeText(change), change.id, false);
  const box = row.querySelector("input");
  const setBack = choice("checkbox", "Set back to the code's value", KEEP_CODE);
  const toggle = setBack.querySelector("input");
  if (toggle) {
    toggle.dataset.change = change.id;
    toggle.setAttribute("aria-label", `Set back to the code's value: ${nameOf(change)}, ${change.from}`);
    toggle.addEventListener("change", () => {
      if (!box) return;
      box.disabled = toggle.checked;
      if (box.disabled) box.checked = false;
    });
  }
  row.append(setBack);
  return row;
}

/** The list of `changes`; the ids of those ticked for a code edit; and the ids of those whose code value the designer
 * chose, which Apply sets. */
export function figmaChangeList(changes: readonly FigmaChange[]) {
  const list = element("ul");
  for (const change of changes) {
    if (change.pullRequest) list.append(inPullRequest(change, change.pullRequest));
    else if (change.inCodeToo) list.append(conflict(change));
    else list.append(figmaOnly(change));
  }
  const checked = (selector: string) =>
    Array.from(list.querySelectorAll<HTMLInputElement>(selector)).filter((input) => input.checked);
  const toEdit = () => checked("input[type=checkbox]:not([data-change])").map((box) => box.value);
  const keepCode = () =>
    checked(`input[data-change][value=${KEEP_CODE}]`).flatMap((input) =>
      input.dataset.change ? [input.dataset.change] : [],
    );
  return { list, toEdit, keepCode };
}
