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
      "The code changed this too. Keep the code's, which Apply sets, or use yours in a pull request:",
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

/** The list of `changes`, and the ids of the changes made in the code too whose code value the designer chose. */
export function figmaChangeList(changes: readonly FigmaChange[]) {
  const list = element("ul");
  for (const change of changes) {
    if (change.pullRequest) list.append(inPullRequest(change, change.pullRequest));
    else if (change.inCodeToo) list.append(conflict(change));
    else list.append(tickable(changeText(change), change.id, false));
  }
  const keepCode = () =>
    Array.from(list.querySelectorAll<HTMLInputElement>(`input[type=radio][value=${KEEP_CODE}]`))
      .filter((radio) => radio.checked)
      .flatMap((radio) => (radio.dataset.change ? [radio.dataset.change] : []));
  return { list, keepCode };
}
