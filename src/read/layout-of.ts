/** A screen's layout: the containers, decisions, loops, placed views and elements its code writes, as a tree. */

import { readerOf } from "../catalog/components.js";
import { type ComponentReader, type Declaration, perSource } from "../catalog/reader.js";
import { codeFiles, type FrameworkSources } from "../catalog/sources.js";
import { bodyAfter } from "../frameworks/compose-functions.js";
import type { JsSource } from "../frameworks/js-sources.js";
import type { KotlinSource } from "../frameworks/kotlin-sources.js";
import { spanIn, treeOf } from "../frameworks/kotlin-sources.js";
import { Modules } from "../frameworks/rn-modules.js";
import { fileComponentName } from "../frameworks/rn-views.js";
import { type BracketTree, bracketTree, locator } from "../frameworks/source-text.js";
import { structs } from "../frameworks/swift-source.js";
import type { SwiftSource } from "../frameworks/swiftui-sources.js";
import { groupBy } from "../scan/counting.js";
import type { FrameworkScan, ScreenRef } from "../scan/types.js";
import { type Code, nearestViews, viewsOf } from "./files-for.js";
import { CodeElements, unbalancedAt } from "./layout-code.js";
import { JsxElements, parseErrorAfter } from "./layout-jsx.js";
import { type Building, type Element, layoutTree } from "./layout-tree.js";
import { type Issue, isUnread, ReadingNotes, type Unread } from "./reading-notes.js";
import type { LayoutNode } from "./schema.js";

/** What `layoutOf` reads for one framework of a view. */
export interface LayoutInput {
  scan: FrameworkScan;
  sources: FrameworkSources;
  /** Files changed since the app was scanned, whose views the scan doesn't list. */
  edited: ReadonlySet<string>;
  /** The packages the project depends on, which a React Native import names rather than its own files. */
  packages: ReadonlySet<string>;
}

/** A SwiftUI view property or function (`var header: some View {`, `func row(_ item: Item) -> some View {`). */
const SWIFT_VIEW_MEMBER =
  /\b(?:var\s+(\w+)\s*:\s*some\s+View|func\s+(\w+)\s*(?:<[^<>{}]{0,200}>)?\s*\([^{}]{0,500}?\)\s*->\s*some\s+View)\s*\{/g;

/** What `layoutOf` works out once per framework of a view, on its first call. */
export interface LayoutIndex {
  /** Every view of the framework, by id, the scan's and those declared in files changed since. */
  views: ReadonlyMap<string, ScreenRef>;
  layoutOf(view: ScreenRef): LayoutNode | undefined;
  /** The layout of `view` with what may be wrong in it, or why it couldn't be read whole. */
  read(view: ScreenRef): LayoutReading;
  /** The view property or function, other than a body, whose code starts at `offset` in the file `rel`: `header` for
   * the first thing `var header: some View { … }` writes. */
  memberAt(rel: string, offset: number): string | undefined;
  /** The file `rel`'s code with its comments and strings blanked, at the same offsets. */
  code(rel: string): string | undefined;
}

export function layoutIndex({ scan, sources, edited, packages }: LayoutInput): LayoutIndex {
  const reader = readerOf(sources);
  const files = new Map<string, Code>(codeFiles(sources).map((f) => [f.rel, f]));
  const views = viewsOf({ scan, edited }, files);
  const byName = groupBy(views, (v) => v.name);
  const byFile = groupBy(views, (v) => v.file);
  const modules =
    sources.framework === "react-native" ? new Modules(sources.files, new Set(packages)) : undefined;
  const imported = modules && importedView(modules, byFile);
  const overloads = sources.framework === "compose" ? new Overloads(sources.files, reader) : undefined;
  const read = (view: ScreenRef): LayoutReading => {
    const notes = new ReadingNotes();
    return layoutOfView(sources, reader, view, notes, {
      viewNamed: (name, at) => {
        const found = imported?.view(name, view.file);
        if (found === null) return undefined;
        const near = found ?? nearestViews(byName.get(name) ?? [], view.file, files);
        const placed = near.length > 1 && overloads ? overloads.called(near, view, name, at) : near;
        if (placed.length > 1)
          notes.issue({ kind: "ambiguous-view", start: at.start, end: at.end, detail: name });
        return firstId(placed);
      },
      builtIn: (name) => imported?.builtIn(name, view.file),
    });
  };
  return {
    views: new Map(views.map((v) => [v.id, v])),
    layoutOf: (view) => {
      const reading = read(view);
      return isUnread(reading) ? undefined : reading.layout;
    },
    read,
    memberAt: (rel, offset) => {
      if (sources.framework !== "swiftui") return undefined;
      const source = sources.files.find((f) => f.rel === rel);
      return source && swiftMembers(source).get(offset);
    },
    code: (rel) => files.get(rel)?.code,
  };
}

const firstId = (views: ScreenRef[]) => views.map((v) => v.id).sort()[0];

/** A composable function's parameter: its name, and whether it has a default, takes a function, or takes many. */
interface Parameter {
  name: string;
  optional: boolean;
  function: boolean;
  many: boolean;
}

/** A call's arguments in order, each with the name it's given by, if any, and whether it's a function written in place
 * (`{ … }`), a value written in place (`"Title"`, `3`), or else unknown; and whether a block follows the call. */
interface Call {
  args: { name?: string; kind: "function" | "value" | undefined }[];
  block: boolean;
}

/**
 * Which of a composable's overloads a call places, the way Kotlin picks one, from what the call and each overload
 * write, not their types: the call's named arguments are among the overload's parameters, its arguments fill the ones
 * with no default and no more, and a block after it is the overload's last function parameter. Of overloads that fit
 * as well, one other than the function the call is written in: one calling itself with the same arguments is rare,
 * and an overload calling another (`Dialog(message: String)` calling `Dialog(message: AnnotatedString)`) is common.
 */
class Overloads {
  private readonly parameters = new Map<string, Parameter[] | undefined>();
  private readonly byFile: Map<string, KotlinSource>;

  constructor(
    files: KotlinSource[],
    private readonly reader: ComponentReader,
  ) {
    this.byFile = new Map(files.map((f) => [f.rel, f]));
  }

  /** Those of `views`, all named `name`, that the call written from `at.start` in `caller` places. */
  called(
    views: ScreenRef[],
    caller: ScreenRef,
    name: string,
    at: { start: number; end: number },
  ): ScreenRef[] {
    const source = this.byFile.get(caller.file);
    const call = source && callAt(source, name, at.start, at.end);
    if (!call) return views;
    const fitting = views.filter((v) => {
      const parameters = this.parametersOf(v);
      return !parameters || fits(parameters, call);
    });
    const others = fitting.filter((v) => v.id !== caller.id);
    return others.length > 0 ? others : fitting.length > 0 ? fitting : views;
  }

  private parametersOf(view: ScreenRef): Parameter[] | undefined {
    if (!this.parameters.has(view.id)) {
      const source = this.byFile.get(view.file);
      const declaration = this.reader.declaration(view);
      this.parameters.set(view.id, source && declaration && parametersAt(source, view.name, declaration));
    }
    return this.parameters.get(view.id);
  }
}

/** An argument given by name: `title = "Plans"`, not `a == b`. */
const NAMED_ARGUMENT = /^(\w+)\s*=(?!=)/;
/** A value written in place, as code with its strings blanked has it: a string (all blank), a number, `true`. */
const VALUE = /^(?:$|-?\d|(?:true|false|null)\b)/;

/** The parameters of the function `name` declared in `source` from `declaration.start`, read from its code with its
 * comments and strings blanked, so neither changes what a parameter takes. */
function parametersAt(source: KotlinSource, name: string, declaration: Declaration): Parameter[] | undefined {
  const { code } = source;
  const head = new RegExp(`\\bfun\\s+(?:<[^{}]{0,200}?>\\s*)?(?:[\\w.]+\\.)?${name}\\s*\\(`, "g");
  head.lastIndex = declaration.start;
  const m = head.exec(code);
  if (!m || m.index > declaration.end) return undefined;
  const open = m.index + m[0].length - 1;
  const close = treeOf(source).closeOf.get(open);
  if (close === undefined) return undefined;
  return listed(code, open + 1, close).flatMap((item) => {
    const bare = item.replace(/@[\w.]+(?:\([^()]*\))?/g, "").trim();
    const p = /^((?:(?:vararg|crossinline|noinline)\s+)*)(\w+)\s*:([\s\S]*)$/.exec(bare);
    if (!p) return [];
    const [, modifiers = "", parameter = "", rest = ""] = p;
    // Its type is what's before its default: `label: String = "->"` takes a string.
    const equals = /=(?!=)/.exec(rest.replace(/->/g, "  "));
    const type = equals ? rest.slice(0, equals.index) : rest;
    return [
      {
        name: parameter,
        optional: equals !== null,
        function: type.includes("->"),
        many: modifiers.includes("vararg"),
      },
    ];
  });
}

/** The arguments of the call of `name` written from `start` to `end` in `source`, read from its code with its comments
 * and strings blanked. */
function callAt(source: KotlinSource, name: string, start: number, end: number): Call | undefined {
  const { code, text } = source;
  const at = code.indexOf(name, start);
  if (at === -1 || at >= end) return undefined;
  let k = at + name.length;
  while (/\s/.test(code[k] ?? "")) k++;
  if (code[k] === "<") k = code.indexOf(">", k) + 1;
  while (/\s/.test(code[k] ?? "")) k++;
  let items: string[] = [];
  if (code[k] === "(") {
    const close = treeOf(source).closeOf.get(k);
    if (close === undefined) return undefined;
    // A string blanks to nothing in the code, so an item is kept when the text has one there.
    items = listed(code, k + 1, close, text);
    k = close + 1;
    while (code[k] === " " || code[k] === "\t") k++;
  } else while (/\s/.test(code[k] ?? "")) k++;
  const args = items.map((a): Call["args"][number] => {
    const name = NAMED_ARGUMENT.exec(a)?.[1];
    if (name) return { name, kind: undefined };
    return { kind: a.startsWith("{") ? "function" : VALUE.test(a) ? "value" : undefined };
  });
  return { args, block: code[k] === "{" && k < end };
}

/** Whether the parameters `parameters` take the call's arguments: each once, by its name or by its place (Kotlin
 * lets one by place follow ones by name in theirs), a `vararg` taking those by place from its own on, a block the last
 * parameter's when that takes a function. */
function fits(parameters: Parameter[], call: Call): boolean {
  const many = parameters.findIndex((p) => p.many);
  const given = new Set<string>();
  for (const [i, arg] of call.args.entries()) {
    const parameter =
      arg.name !== undefined
        ? parameters.find((p) => p.name === arg.name)
        : parameters[many !== -1 && i > many ? many : i];
    if (!parameter) return false;
    // A function given where a value is taken, or a value where a function is: another overload's.
    if ((arg.kind === "function" && !parameter.function) || (arg.kind === "value" && parameter.function))
      return false;
    if (given.has(parameter.name) && !parameter.many) return false;
    given.add(parameter.name);
  }
  if (call.block) {
    const last = parameters.at(-1);
    if (!last?.function || given.has(last.name)) return false;
    given.add(last.name);
  }
  return parameters.every((p) => p.optional || p.many || given.has(p.name));
}

/** The comma-separated items of `code` from `from` to `to`, split outside their brackets: `<…>` is one when it's a
 * type's, opening on a type's name (`Map<String, Int>`, `emptyMap<String, Int>()`), not a comparison (`a < b`,
 * `count<limit`). An item that's only a blanked
 * string is kept when `text` shows one there, but not one that's only a comment. */
function listed(code: string, from: number, to: number, text?: string): string[] {
  const items: [number, number][] = [];
  let depth = 0;
  let generics = 0;
  let start = from;
  for (let i = from; i < to; i++) {
    const c = code[i] ?? "";
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "<" && /[A-Z*]/.test(code[i + 1] ?? "")) generics++;
    else if (c === ">" && generics > 0 && code[i - 1] !== "-") generics--;
    else if (c === "," && depth === 0 && generics === 0) {
      items.push([start, i]);
      start = i + 1;
    }
  }
  items.push([start, to]);
  const shown = (a: number, b: number) =>
    text
      ?.slice(a, b)
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")
      .trim();
  return items
    .filter(([a, b]) => code.slice(a, b).trim() || shown(a, b))
    .map(([a, b]) => code.slice(a, b).trim());
}

/** How many files an import is followed through, re-exports and `export *` included. */
const MAX_MODULES = 50;

/** For a JSX tag imported into `rel`, the app's views the import names, followed through files that
 * re-export it (`export { Card } from "./Card"`, `export * from "./Badge"`); null for one imported from a package
 * (`Button` from `react-native`), which is no view of the app's; undefined for a name not imported, or not found. */
function importedView(modules: Modules, byFile: Map<string, ScreenRef[]>) {
  const sources = new Map(modules.sources.map((s) => [s.rel, s]));
  /** The views `target` exports as `name`, declared in it or in a file it re-exports from. */
  const exported = (target: JsSource, name: string, tag: string, seen: Set<string>): ScreenRef[] => {
    if (seen.has(`${target.rel}#${name}`) || seen.size >= MAX_MODULES) return [];
    seen.add(`${target.rel}#${name}`);
    const own = byFile.get(target.rel) ?? [];
    const names = modules.namesOf(target);
    const entry = names.exports.get(name);
    if (entry && "from" in entry)
      return modules.resolve(entry.from, target).flatMap((f) => exported(f, entry.name, tag, seen));
    const local = entry?.local ?? name;
    // A default export is its own declaration's view; else the one its file names, else the tag's.
    const candidates = name === "default" ? [local, fileComponentName(target), tag] : [local];
    const declared =
      candidates.map((c) => own.filter((v) => v.name === c)).find((found) => found.length > 0) ?? [];
    if (declared.length > 0 || name === "default") return declared;
    return names.stars.flatMap((from) =>
      modules.resolve(from, target).flatMap((f) => exported(f, name, tag, seen)),
    );
  };
  const bindingOf = (tag: string, rel: string) => {
    const source = sources.get(rel);
    if (!source) return undefined;
    const imports = modules.namesOf(source).imports;
    const binding = imports.get(tag);
    if (binding && binding.name !== "*") return { binding, targets: modules.resolve(binding.from, source) };
    // A name of a module imported whole: `List.Item` for `import * as List from "./List"`.
    const [space, member, ...rest] = tag.split(".");
    const whole = space ? imports.get(space) : undefined;
    if (whole?.name !== "*" || !member || rest.length > 0) return undefined;
    return { binding: { from: whole.from, name: member }, targets: modules.resolve(whole.from, source) };
  };

  return {
    view(tag: string, rel: string): ScreenRef[] | null | undefined {
      const found = bindingOf(tag, rel);
      if (!found) return undefined;
      if (found.targets.length === 0) return null;
      const seen = new Set<string>();
      const views = found.targets.flatMap((target) => exported(target, found.binding.name, tag, seen));
      // A view exported along several ways (re-exported under two names) is still the one view.
      const each = [...new Map(views.map((v) => [v.id, v])).values()];
      return each.length > 0 ? each : undefined;
    },
    /** The name a package exports what `tag` imports by: `Text` for `import { Text as Label } from "react-native"`. */
    builtIn(tag: string, rel: string): string | undefined {
      const found = bindingOf(tag, rel);
      return found && found.targets.length === 0 && found.binding.name !== "default"
        ? found.binding.name
        : undefined;
    },
  };
}

/** A view's layout read whole, with what may be wrong in it; or why it couldn't be. */
export type LayoutReading = { layout: LayoutNode; issues: Issue[] } | Unread;

function layoutOfView(
  sources: FrameworkSources,
  reader: ComponentReader,
  view: ScreenRef,
  notes: ReadingNotes,
  names: Pick<Building, "viewNamed" | "builtIn">,
): LayoutReading {
  const declaration = reader.declaration(view);
  const read = (at: Declaration, elements: Element[] | Unread, span: Building["span"]): LayoutReading => {
    if (isUnread(elements)) return elements;
    const screen = { ref: view.id, start: at.start, end: at.end };
    const layout = layoutTree({ framework: sources.framework, span, notes, ...names }, screen, elements);
    return { layout, issues: notes.kept() };
  };
  if (sources.framework === "react-native") {
    const source = sources.files.find((f) => f.rel === view.file);
    if (!source) return { reason: "no-declaration", at: 0 };
    if (!declaration) {
      const from = lineStart(source.text, view.line);
      const error = parseErrorAfter(source, from);
      return error === undefined
        ? { reason: "no-declaration", at: from }
        : { reason: "parse-error", at: error };
    }
    const elements = new JsxElements(source, notes).ofComponent(declaration.start, declaration.end);
    return read(declaration, elements, locator(view.file, source.text));
  }
  if (sources.framework === "swiftui") {
    const source = sources.files.find((f) => f.rel === view.file);
    if (!source) return { reason: "no-declaration", at: 0 };
    if (!declaration) return undeclared(source, treeOfSwift(source), view);
    return read(declaration, swiftElements(source, declaration, notes), locator(view.file, source.text));
  }
  const source = sources.files.find((f) => f.rel === view.file);
  if (!source) return { reason: "no-declaration", at: 0 };
  if (!declaration) return undeclared(source, treeOf(source), view);
  return read(declaration, composeElements(source, declaration, notes), (start, end) =>
    spanIn(source, start, end),
  );
}

/** Where line `line` (1-based) of `text` starts. */
function lineStart(text: string, line: number): number {
  let at = 0;
  for (let n = 1; n < line; n++) {
    const next = text.indexOf("\n", at);
    if (next === -1) return at;
    at = next + 1;
  }
  return at;
}

/** Why a SwiftUI or Compose view the scan found has no declaration where it was found: a bracket from there on left
 * open, or else it isn't declared there any more. */
function undeclared(source: { text: string; code: string }, tree: BracketTree, view: ScreenRef): Unread {
  const from = lineStart(source.text, view.line);
  const at = unbalancedAt({ code: source.code, tree }, from, source.code.length);
  return at === undefined ? { reason: "no-declaration", at: from } : { reason: "unbalanced", at };
}

const structsOf = perSource((source: SwiftSource) => structs(source.code));
const treeOfSwift = perSource((source: SwiftSource) => bracketTree(source.code));

/** Each SwiftUI view property and function of the file other than a body, by where the first thing it writes starts:
 * `header` at the `HStack` of `var header: some View { HStack { … } }`, or of `{ return HStack { … } }`. */
const swiftMembers = perSource((source: SwiftSource) => {
  const at = new Map<number, string>();
  for (const m of source.code.matchAll(SWIFT_VIEW_MEMBER)) {
    const name = m[1] ?? m[2];
    if (!name || name === "body") continue;
    const open = (m.index ?? 0) + m[0].length - 1;
    const first = /^\s*(?:return\s+)?/.exec(source.code.slice(open + 1, open + 200))?.[0].length ?? 0;
    at.set(open + 1 + first, name);
  }
  return at;
});

/** What a SwiftUI view's `body` writes, with the view properties of its struct and the file's extensions of it. */
function swiftElements(
  source: SwiftSource,
  declaration: Declaration,
  notes: ReadingNotes,
): Element[] | Unread {
  const { code } = source;
  const struct = structsOf(source).find((s) => s.start === declaration.start);
  if (!struct) return { reason: "no-declaration", at: declaration.start };
  const tree = treeOfSwift(source);
  const blocks: [number, number][] = [[struct.open, struct.close]];
  for (const m of code.matchAll(new RegExp(`\\bextension\\s+${struct.name}\\b[^{}]{0,500}\\{`, "g"))) {
    const open = (m.index ?? 0) + m[0].length - 1;
    if (tree.enclosing[m.index ?? 0] !== -1) continue;
    const close = tree.closeOf.get(open);
    // An extension left open may hold a view property the body places: the layout can't be read whole.
    if (close === undefined) return { reason: "open-extension", at: m.index ?? 0 };
    blocks.push([open, close]);
  }
  const views = new Map<string, [number, number]>();
  for (const [open, close] of blocks)
    for (const m of code.slice(open, close).matchAll(SWIFT_VIEW_MEMBER)) {
      const at = open + (m.index ?? 0);
      const brace = at + m[0].length - 1;
      const end = tree.closeOf.get(brace);
      const name = m[1] ?? m[2] ?? "";
      if (tree.enclosing[at] === open && end !== undefined && !views.has(name)) views.set(name, [brace, end]);
    }
  for (const [open, close] of blocks) {
    const at = unbalancedAt({ code, tree }, open, close);
    if (at !== undefined) return { reason: "unbalanced", at };
  }
  const body = views.get("body");
  if (!body) return { reason: "no-body", at: struct.start };
  views.delete("body");
  const reading = new CodeElements({ language: "swift", code, tree, views }, notes);
  const elements = reading.between(body[0] + 1, body[1]);
  return notes.stopped ?? elements;
}

/** What a composable function's body writes: its block, or its `= expression`. */
function composeElements(
  source: KotlinSource,
  declaration: Declaration,
  notes: ReadingNotes,
): Element[] | Unread {
  const { code } = source;
  const tree = treeOf(source);
  const open = code.indexOf("(", declaration.start);
  if (open === -1 || open > declaration.end) return { reason: "no-body", at: declaration.start };
  const close = tree.closeOf.get(open);
  if (close === undefined) return { reason: "unbalanced", at: open };
  const body = bodyAfter(source, close + 1);
  if (!body) return { reason: "no-body", at: declaration.start };
  const [at, end] = body;
  const unpaired = unbalancedAt({ code, tree }, at, end + 1);
  if (unpaired !== undefined) return { reason: "unbalanced", at: unpaired };
  const reading = new CodeElements({ language: "kotlin", code, tree }, notes);
  const elements = code[at] === "{" ? reading.between(at + 1, end) : reading.between(at + 1, end + 1);
  return notes.stopped ?? elements;
}
