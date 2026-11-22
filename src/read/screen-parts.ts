/** A screen's main parts, as a person picks one to change: the top of its layout, each with a name to show. */

import type { LayoutKind, LayoutNode, ScreenPart, StringUse } from "./schema.js";

/** What a view's parts are named from, in its own file. */
export interface PartNames {
  /** The file's text. */
  text: string;
  /** The file's text with its comments and strings blanked, at the same offsets. */
  code: string;
  /** The text the file shows people, in the order it's written. */
  strings: StringUse[];
  /** The name of the app's view with this id. */
  viewName: (ref: string) => string | undefined;
  /** The view property or function, other than a body, whose code starts at `offset`. */
  memberAt: (offset: number) => string | undefined;
}

/** The most words a comment naming a part has. */
const MAX_COMMENT_WORDS = 4;

/** The longest a label is, its "…" included. */
const MAX_LABEL = 24;

/** Kinds that only hold the screen's content, so the parts are inside one that holds it alone. */
const STEPPED_THROUGH = new Set<LayoutKind>([
  "stack-v",
  "stack-h",
  "stack-z",
  "grid",
  "list",
  "lazy-list",
  "lazy-grid",
  "scroll",
  "tabs",
  "nav",
  "form",
  "section",
  "other",
]);

/** Kinds that show something, whatever they hold. */
const LEAVES = new Set<LayoutKind>(["text", "button", "image", "input", "other"]);

/** Kinds titled by the first text written in them: `Section("Plans")`, `TopAppBar(title = { Text("Settings") })`. */
const TITLED = new Set<LayoutKind>(["section", "toolbar"]);

const KIND_LABELS: Record<LayoutKind, string> = {
  "stack-v": "Stack",
  "stack-h": "Row",
  "stack-z": "Layers",
  grid: "Grid",
  list: "List",
  "lazy-list": "List",
  "lazy-grid": "Grid",
  scroll: "Scroll",
  tabs: "Tabs",
  nav: "Navigation",
  form: "Form",
  section: "Section",
  toolbar: "Toolbar",
  repeat: "Items",
  conditional: "Conditional",
  "view-ref": "View",
  text: "Text",
  button: "Button",
  image: "Image",
  input: "Input",
  spacer: "Spacer",
  other: "Element",
};

/** What `screenParts` reads of the app: a view's layout, undefined when it can't be read whole, and what its parts are
 * named from. */
export interface PartReading {
  layoutOf: (view: string) => LayoutNode | undefined;
  namesOf: (view: string) => PartNames;
}

/** How many placed views are followed in from the screen to find its parts. */
const MAX_FOLLOWED = 8;
/** How many placed views deep a part is looked into for anything it shows; past that, it's taken to show something. */
const MAX_LOOKED_INTO = 32;

/** The parts of the view `view`: stepping in from it through what holds only one thing (a container, what's written
 * in a container of the app's, the one view it places, the biggest branch of a decision) to the first node that holds
 * two or more, those nodes. None when no node does; undefined when a layout on the way can't be read. Spacers are
 * space between parts, not parts. */
export function screenParts(view: string, read: PartReading): ScreenPart[] | undefined {
  const found = readParts(view, read);
  return "parts" in found ? found.parts : undefined;
}

/** What `screenParts` finds, as it finds it: the parts, which of them are labelled by their kind alone, and the views
 * placed on the way to them; or the view on the way whose layout couldn't be read. */
export type PartsReading =
  | { parts: ScreenPart[]; unnamed: ScreenPart[]; views: string[] }
  | { unread: string; views: string[] };

export function readParts(view: string, read: PartReading): PartsReading {
  const visible = new Visibility(read.layoutOf);
  let node = read.layoutOf(view);
  const followed: string[] = [];
  while (node) {
    const shown = node.children.filter((c) => visible.shows(c));
    if (shown.length >= 2) return { ...labelled(shown, view, read.namesOf(view)), views: followed };
    let only = shown[0];
    // A decision over the whole screen (loading, or its content) shows its biggest branch most.
    while (only?.kind === "conditional") only = biggest(only.children.filter((c) => visible.shows(c)));
    if (!only) return none(followed);
    // A container of the app's holding what the screen writes inside it (`AppScaffold { … }`): what's written there.
    if (only.kind === "view-ref" && only.children.length > 0) {
      node = only;
      continue;
    }
    if (only.kind === "view-ref" && only.ref !== undefined) {
      // Views placing each other end here too.
      if (followed.length >= MAX_FOLLOWED) return none(followed);
      view = only.ref;
      followed.push(view);
      node = read.layoutOf(view);
      continue;
    }
    if (!STEPPED_THROUGH.has(only.kind)) return none(followed);
    node = only;
  }
  return { unread: view, views: followed.filter((v) => v !== view) };
}

/** No parts, each time a new answer, so a caller changing one changes no other. */
const none = (views: string[]): PartsReading => ({ parts: [], unnamed: [], views });

/**
 * Whether a node shows anything: an element does; a spacer doesn't; anything else does when something it holds does,
 * or, for a view of the app, when its own layout does (`TrackScreenViewEvent()`, `EventsEffect { … }` show nothing).
 * A layout that can't be read might show anything. A view placed inside itself adds nothing there, so while a view is
 * being looked into, it's taken to show nothing; an answer that took that is kept only once the view is known.
 */
class Visibility {
  private readonly known = new Map<string, boolean>();
  /** The views being looked into, each with how deep it is. */
  private readonly open = new Map<string, number>();

  constructor(private readonly layoutOf: PartReading["layoutOf"]) {}

  shows(node: LayoutNode): boolean {
    return !this.nothingIn(node).nothing;
  }

  /** Whether `node` shows nothing, and the shallowest view being looked into whose answer it took (-1 when it took
   * the limit's): an answer that took none is final. */
  private nothingIn(node: LayoutNode): { nothing: boolean; took: number } {
    if (node.kind === "spacer") return { nothing: true, took: Number.POSITIVE_INFINITY };
    if (LEAVES.has(node.kind) && node.children.length === 0)
      return { nothing: false, took: Number.POSITIVE_INFINITY };
    const inside = this.allNothing(node.children);
    if (!inside.nothing || node.kind !== "view-ref" || node.ref === undefined) return inside;
    const own = this.viewShowsNothing(node.ref);
    return { nothing: own.nothing, took: Math.min(inside.took, own.took) };
  }

  private allNothing(nodes: LayoutNode[]): { nothing: boolean; took: number } {
    let took = Number.POSITIVE_INFINITY;
    for (const n of nodes) {
      const one = this.nothingIn(n);
      if (!one.nothing) return one;
      took = Math.min(took, one.took);
    }
    return { nothing: true, took };
  }

  private viewShowsNothing(ref: string): { nothing: boolean; took: number } {
    const known = this.known.get(ref);
    if (known !== undefined) return { nothing: known, took: Number.POSITIVE_INFINITY };
    const depth = this.open.get(ref);
    if (depth !== undefined) return { nothing: true, took: depth };
    // Past the limit it's taken to show something, an answer kept for no view: it's only how far this one looked.
    if (this.open.size >= MAX_LOOKED_INTO) return { nothing: false, took: -1 };
    const at = this.open.size;
    this.open.set(ref, at);
    const layout = this.layoutOf(ref);
    const found = layout
      ? this.allNothing(layout.children)
      : { nothing: false, took: Number.POSITIVE_INFINITY };
    this.open.delete(ref);
    // Taking only this view, or ones deeper, to show nothing, the answer is this view's own.
    if (found.took >= at) {
      this.known.set(ref, found.nothing);
      return { nothing: found.nothing, took: Number.POSITIVE_INFINITY };
    }
    return found;
  }
}

/** The node holding the most nodes, the first of those that tie. A view placed there holds a whole view, so it's
 * more than an element: `FeedList()` over `ProgressView()`. */
function biggest(nodes: LayoutNode[]): LayoutNode | undefined {
  const size = (n: LayoutNode): number =>
    n.children.reduce((total, c) => total + size(c), n.kind === "view-ref" ? 2 : 1);
  let best: LayoutNode | undefined;
  for (const n of nodes) if (!best || size(n) > size(best)) best = n;
  return best;
}

/** The parts `nodes` are, each labelled by the first of: a section's or toolbar's title, the placed view's name, the
 * view property it's written in, a comment on the line above, what a decision's biggest branch or a loop's item is
 * named, the first text it shows, its kind. */
function labelled(
  nodes: LayoutNode[],
  view: string,
  names: PartNames,
): { parts: ScreenPart[]; unnamed: ScreenPart[] } {
  const taken = new Set<string>();
  const next = new Map<string, number>();
  const unnamed: ScreenPart[] = [];
  const parts = nodes.map((node) => {
    const name = nameOf(node, names);
    const label = unique(name ?? KIND_LABELS[node.kind], taken, next);
    const part = {
      id: node.id,
      view,
      label,
      span: node.span,
      ...(node.ref !== undefined && { ref: node.ref }),
    };
    if (name === undefined) unnamed.push(part);
    return part;
  });
  return { parts, unnamed };
}

function nameOf(node: LayoutNode, names: PartNames): string | undefined {
  const placed = node.ref === undefined ? undefined : names.viewName(node.ref);
  const inner = node.kind === "conditional" || node.kind === "repeat" ? biggest(node.children) : undefined;
  return (
    (TITLED.has(node.kind) ? firstText(node, names) : undefined) ??
    (placed === undefined ? undefined : wordsOf(placed)) ??
    wordsOf(names.memberAt(node.span.start) ?? "") ??
    commentAbove(names.text, node.span.start) ??
    (inner && nameOf(inner, names)) ??
    firstText(node, names)
  );
}

/** The first text written inside the node that shows any; for a SwiftUI section with a `header:` after its content,
 * the header's. */
function firstText(node: LayoutNode, names: PartNames): string | undefined {
  const { start, end } = node.span;
  const header = node.kind === "section" ? headerAt(names, start, end) : undefined;
  const { strings } = names;
  for (let i = firstAtOrAfter(strings, header ?? start); i < strings.length; i++) {
    const s = strings[i];
    if (!s || s.span.start >= end) break;
    const words = s.span.end <= end && s.text !== null ? wordsShown(s.text) : undefined;
    if (words) return words;
  }
  return undefined;
}

/** Where `header:` is written in the section from `start` to `end`, outside its brackets, its strings and its
 * comments. */
function headerAt({ code }: PartNames, start: number, end: number): number | undefined {
  let depth = 0;
  for (let i = start; i < end; i++) {
    const c = code[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (
      depth === 0 &&
      c === "h" &&
      /^header\s*:/.test(code.slice(i, i + 20)) &&
      !/\w/.test(code[i - 1] ?? "")
    )
      return i;
  }
  return undefined;
}

/** The index of the first of `strings`, in the order they're written, that starts at or after `offset`. */
function firstAtOrAfter(strings: StringUse[], offset: number): number {
  let low = 0;
  let high = strings.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((strings[mid]?.span.start ?? 0) < offset) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** A string's words as a label, without the code written in it (`\\(count) items`, `${count} items`, `$count items`);
 * none for one that's only code, or a translation key written in place of its text (`settings.title`). */
function wordsShown(text: string): string | undefined {
  const words = withoutCode(text).replace(/\s+/g, " ").trim();
  if (!/\p{L}/u.test(words) || /^[\w-]+(?:[._][\w-]+)+$/.test(words)) return undefined;
  return words;
}

/** `text` without the expressions written in it: Swift's `\\(…)`, JavaScript's and Kotlin's `${…}`, Kotlin's `$name`. */
function withoutCode(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const open = text.startsWith("\\(", i) ? i + 1 : text.startsWith("${", i) ? i + 1 : -1;
    if (open !== -1) {
      let depth = 0;
      let j = open;
      for (; j < text.length; j++) {
        if (text[j] === "(" || text[j] === "{") depth++;
        else if ((text[j] === ")" || text[j] === "}") && --depth === 0) break;
      }
      i = j;
      continue;
    }
    const name = /^\$[A-Za-z_]\w*/.exec(text.slice(i))?.[0];
    if (name) {
      i += name.length - 1;
      continue;
    }
    out += text[i];
  }
  return out;
}

/** A comment's words on the line just above `offset`'s: `// Plans`, `/* Plans *\/`, `{/* Plans *\/}`, `// MARK: - Plans`. */
function commentAbove(text: string, offset: number): string | undefined {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  // On the first line, the code before `offset` is the part's own: no comment's.
  if (lineStart === 0 || text.slice(lineStart, offset).trim()) return undefined;
  const above = text.slice(text.lastIndexOf("\n", lineStart - 2) + 1, lineStart - 1).trim();
  const words =
    /^\/\/+\s*(.*)$/.exec(above)?.[1] ?? /^\{?\/\*+\s*(.*?)\s*\*+\/\}?$/.exec(above)?.[1] ?? undefined;
  const cleaned = words?.replace(/^MARK:\s*-?\s*/, "").trim();
  // A name is a few words; a longer comment says something else, as do notes to the code's authors, code left
  // commented out (`Text("Old")`), and directives to tools (`swiftlint:disable:next`, `@ts-ignore`).
  if (
    !cleaned ||
    cleaned.split(/\s+/).length > MAX_COMMENT_WORDS ||
    /^(?:TODO|FIXME|NOTE)\b/i.test(cleaned) ||
    /[(){}[\]=;<>]|^[@.#]|^[\w-]+:\S/.test(cleaned)
  )
    return undefined;
  return cleaned;
}

/** An identifier's words, as a label: `plansSection` → "Plans section", `HeaderView` → "Header", `URLField` → "URL field".
 * A view's `View` or `Screen` suffix names what it is, not which. */
export function wordsOf(name: string): string | undefined {
  const words = name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? [];
  const last = words.at(-1);
  if (words.length > 1 && (last === "View" || last === "Screen")) words.pop();
  if (words.length === 0) return undefined;
  return words
    .map((w, i) => {
      if (w.length > 1 && w === w.toUpperCase()) return w;
      return i === 0 ? w[0]?.toUpperCase() + w.slice(1) : w.toLowerCase();
    })
    .join(" ");
}

/** `label`, or as much of it as fits in `room` before a "…", cut between words when one doesn't take up most of it. */
function capped(label: string, room = MAX_LABEL): string {
  if (label.length <= room) return label;
  const fits = label.slice(0, room - 1);
  const space = label[room - 1] === " " ? fits.length : fits.lastIndexOf(" ");
  const cut = space >= room / 2 ? fits.slice(0, space) : fits;
  return `${cut.replace(/[\s,;:.-]+$/, "")}…`;
}

/** `label`, capped, or, when another part has that, numbered after it within the cap: "Card", "Card 2". `next` keeps
 * each label's next number, so many parts of one label take as long as one. */
function unique(label: string, taken: Set<string>, next: Map<string, number>): string {
  const own = capped(label);
  let out = own;
  let n = next.get(own) ?? 2;
  for (; taken.has(out); n++) out = `${capped(label, MAX_LABEL - ` ${n}`.length)} ${n}`;
  next.set(own, n);
  taken.add(out);
  return out;
}
