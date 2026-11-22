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
import { bracketTree, locator } from "../frameworks/source-text.js";
import { structs } from "../frameworks/swift-source.js";
import type { SwiftSource } from "../frameworks/swiftui-sources.js";
import { groupBy } from "../scan/counting.js";
import type { FrameworkScan, ScreenRef } from "../scan/types.js";
import { type Code, nearestViews, viewsOf } from "./files-for.js";
import { CodeElements, unbalanced } from "./layout-code.js";
import { JsxElements } from "./layout-jsx.js";
import { type Building, type Element, layoutTree } from "./layout-tree.js";
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
}

export function layoutIndex({ scan, sources, edited, packages }: LayoutInput): LayoutIndex {
  const reader = readerOf(sources);
  const files = new Map<string, Code>(codeFiles(sources).map((f) => [f.rel, f]));
  const views = viewsOf({ scan, edited }, files);
  const byName = groupBy(views, (v) => v.name);
  const byFile = groupBy(views, (v) => v.file);
  const nearest = (name: string, rel: string) => firstId(nearestViews(byName.get(name) ?? [], rel, files));
  const modules =
    sources.framework === "react-native" ? new Modules(sources.files, new Set(packages)) : undefined;
  const imported = modules && importedView(modules, byFile);
  return {
    views: new Map(views.map((v) => [v.id, v])),
    layoutOf: (view) =>
      layoutOfView(sources, reader, view, {
        viewNamed: (name) => {
          const found = imported?.view(name, view.file);
          return found === undefined ? nearest(name, view.file) : (found ?? undefined);
        },
        builtIn: (name) => imported?.builtIn(name, view.file),
      }),
  };
}

const firstId = (views: ScreenRef[]) => views.map((v) => v.id).sort()[0];

/** How many files an import is followed through, re-exports and `export *` included. */
const MAX_MODULES = 50;

/** For a JSX tag imported into `rel`, the id of the app's view the import names, followed through files that
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
    view(tag: string, rel: string): string | null | undefined {
      const found = bindingOf(tag, rel);
      if (!found) return undefined;
      if (found.targets.length === 0) return null;
      const seen = new Set<string>();
      return firstId(found.targets.flatMap((target) => exported(target, found.binding.name, tag, seen)));
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

function layoutOfView(
  sources: FrameworkSources,
  reader: ComponentReader,
  view: ScreenRef,
  names: Pick<Building, "viewNamed" | "builtIn">,
): LayoutNode | undefined {
  const declaration = reader.declaration(view);
  if (!declaration) return undefined;
  const span = (text: string) => locator(view.file, text);
  const building = (spanOf: Building["span"]): Building => ({
    framework: sources.framework,
    span: spanOf,
    ...names,
  });
  const screen = { ref: view.id, start: declaration.start, end: declaration.end };
  if (sources.framework === "react-native") {
    const source = sources.files.find((f) => f.rel === view.file);
    const elements = source && new JsxElements(source).ofComponent(declaration.start, declaration.end);
    return elements && layoutTree(building(span(source.text)), screen, elements);
  }
  if (sources.framework === "swiftui") {
    const source = sources.files.find((f) => f.rel === view.file);
    const elements = source && swiftElements(source, declaration);
    return elements && layoutTree(building(span(source.text)), screen, elements);
  }
  const source = sources.files.find((f) => f.rel === view.file);
  const elements = source && composeElements(source, declaration);
  return (
    elements &&
    layoutTree(
      building((start, end) => spanIn(source, start, end)),
      screen,
      elements,
    )
  );
}

const structsOf = perSource((source: SwiftSource) => structs(source.code));
const treeOfSwift = perSource((source: SwiftSource) => bracketTree(source.code));

/** What a SwiftUI view's `body` writes, with the view properties of its struct and the file's extensions of it. */
function swiftElements(source: SwiftSource, declaration: Declaration): Element[] | undefined {
  const { code } = source;
  const struct = structsOf(source).find((s) => s.start === declaration.start);
  if (!struct) return undefined;
  const tree = treeOfSwift(source);
  const blocks: [number, number][] = [[struct.open, struct.close]];
  for (const m of code.matchAll(new RegExp(`\\bextension\\s+${struct.name}\\b[^{}]{0,500}\\{`, "g"))) {
    const open = (m.index ?? 0) + m[0].length - 1;
    if (tree.enclosing[m.index ?? 0] !== -1) continue;
    const close = tree.closeOf.get(open);
    // An extension left open may hold a view property the body places: the layout can't be read whole.
    if (close === undefined) return undefined;
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
  const body = views.get("body");
  if (!body || blocks.some(([open, close]) => unbalanced({ code, tree }, open, close))) return undefined;
  views.delete("body");
  const reading = new CodeElements({ language: "swift", code, tree, views });
  const elements = reading.between(body[0] + 1, body[1]);
  return reading.cut ? undefined : elements;
}

/** What a composable function's body writes: its block, or its `= expression`. */
function composeElements(source: KotlinSource, declaration: Declaration): Element[] | undefined {
  const { code } = source;
  const tree = treeOf(source);
  const open = code.indexOf("(", declaration.start);
  const close = open === -1 || open > declaration.end ? undefined : tree.closeOf.get(open);
  const body = close === undefined ? undefined : bodyAfter(source, close + 1);
  if (!body) return undefined;
  const [at, end] = body;
  if (unbalanced({ code, tree }, at, end + 1)) return undefined;
  const reading = new CodeElements({ language: "kotlin", code, tree });
  const elements = code[at] === "{" ? reading.between(at + 1, end) : reading.between(at + 1, end + 1);
  return reading.cut ? undefined : elements;
}
