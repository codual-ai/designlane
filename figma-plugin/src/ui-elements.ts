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

/** A labelled checkbox or radio button holding `value`. */
export function choice(type: "checkbox" | "radio", text: string, value: string): HTMLLabelElement {
  const label = element("label");
  const input = element("input");
  input.type = type;
  input.value = value;
  label.append(input, ` ${text}`);
  return label;
}

/** A list row with a labelled checkbox, ticked from the start when `checked`. */
export function tickable(text: string, value: string, checked: boolean): HTMLLIElement {
  const row = element("li");
  const label = choice("checkbox", text, value);
  const box = label.querySelector("input");
  if (box) box.checked = checked;
  row.append(label);
  return row;
}

export const ticked = (list: HTMLElement) =>
  Array.from(list.querySelectorAll<HTMLInputElement>("input[type=checkbox]"))
    .filter((box) => box.checked)
    .map((box) => box.value);

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
