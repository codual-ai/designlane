/** The window's small building blocks, made from text only, so no name or value can be read as markup. */

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") {
  const made = document.createElement(tag);
  made.textContent = text;
  made.className = className;
  return made;
}

export function button(text: string, onPress: () => void): HTMLButtonElement {
  const made = element("button", text);
  made.type = "button";
  made.addEventListener("click", onPress);
  return made;
}

/** A labelled checkbox or radio button holding `value`, and the input in it. */
export function choice(type: "checkbox" | "radio", text: string, value: string) {
  const label = element("label");
  const input = element("input");
  input.type = type;
  input.value = value;
  label.append(input, ` ${text}`);
  return { label, input };
}

/** A list row with a labelled checkbox, ticked from the start when `checked`, and the checkbox. */
export function tickable(text: string, value: string, checked: boolean) {
  const row = element("li");
  const { label, input: box } = choice("checkbox", text, value);
  box.checked = checked;
  row.append(label);
  return { row, box };
}

/** The inputs in `root` that `selector` picks and are checked. */
export const checkedIn = (root: HTMLElement, selector: string) =>
  Array.from(root.querySelectorAll<HTMLInputElement>(selector)).filter((input) => input.checked);

/** The values of the ticked checkboxes in `list`. */
export const ticked = (list: HTMLElement) => checkedIn(list, "input[type=checkbox]").map((box) => box.value);

const GITHUB_PAGE = "https://github.com/";

/** A link opened outside the plugin, or the plain address for one that isn't a GitHub page. */
export function gitHubLink(href: string, text = href): HTMLAnchorElement | string {
  if (!href.startsWith(GITHUB_PAGE)) return href;
  const made = element("a", text);
  made.href = href;
  made.target = "_blank";
  made.rel = "noopener noreferrer";
  return made;
}
