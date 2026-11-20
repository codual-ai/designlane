/** The files that explain a screen: where it's declared, the views it places, what holds its state, the files its
 * code imports, and where the tokens it uses are declared. */

import ts from "typescript";
import { nearness, readerOf } from "../catalog/components.js";
import type { ComponentReader, Placement } from "../catalog/reader.js";
import type { FrameworkSources } from "../catalog/sources.js";
import { jsCodeOnly } from "../frameworks/js-code.js";
import type { JsSource } from "../frameworks/js-sources.js";
import { Modules } from "../frameworks/rn-modules.js";
import { structs } from "../frameworks/swift-source.js";
import { groupBy } from "../scan/counting.js";
import type { DesignTokens, FrameworkScan, ScreenRef, ValueLocation } from "../scan/types.js";
import type { FileTokens, ScreenFile } from "./schema.js";
import { type Reading, tokensIn } from "./tokens-in.js";

/** A type declared in Swift or Kotlin, in blanked code. */
const TYPE_DECLARATION = /\b(?:class|struct|actor|object|interface|enum)\s+([A-Z]\w{0,100})/g;
/** Names of types that hold a screen's state, by their last word after one of their own (`CartState`, not the
 * framework's `State` that `@State` names). */
const STATE_HOLDER = /\w(?:ViewModel|Model|Store|Presenter|State)$/;
const IDENTIFIER = /[A-Za-z_]\w{0,200}/g;

/** What `filesFor` reads for one framework, built on its first call. */
export interface FilesForInput {
  scan: FrameworkScan;
  tokens: DesignTokens;
  reading: Reading;
  sources: FrameworkSources;
  /** The packages the project's package.json files depend on, which an import names rather than its own files. */
  packages: ReadonlySet<string>;
  /** Files changed since the app was scanned, whose views the scan doesn't list. */
  edited: ReadonlySet<string>;
}

interface Code {
  text: string;
  /** With comments and strings blanked, at the same offsets. */
  code: string;
}

/** What `filesFor` works out once per framework of a view, on its first call, and shares between its screens. */
interface ScreenIndex {
  reader: ComponentReader;
  files: Map<string, Code>;
  /** Every placement of one of the framework's views, by file. */
  placements: Map<string, Placement[]>;
  views: Map<string, ScreenRef[]>;
  /** Each state holder's name, with the files declaring it. */
  holders: Map<string, Set<string>>;
  /** The files declaring each token, by how the code refers to it. */
  filesByToken: Map<string, Set<string>>;
  modules: Modules | undefined;
  reading: Reading;
  /** Each file's token uses, read once. */
  uses: Map<string, FileTokens>;
}

/** A composable function, in blanked Kotlin. */
const COMPOSABLE = /@Composable\s+(?:(?:private|internal|public)\s+)*fun\s+([A-Z]\w{0,100})\s*\(/g;
/** A component as a function or a constant holding one, in blanked JavaScript. */
const COMPONENT =
  /\bfunction\s+([A-Z]\w{0,100})\s*\(|\b(?:const|let)\s+([A-Z]\w{0,100})\s*(?::[^=\n]{0,100})?=\s*(?:\(|function\b|(?:React\.)?memo\b|forwardRef\b)/g;

/** The views `rel` declares, by name and offset, for a file the scan didn't read as it is. */
function declaredViews(framework: FilesForInput["scan"]["framework"], { code }: Code): [string, number][] {
  if (framework === "swiftui")
    return structs(code)
      .filter((s) => s.conformances.includes("View"))
      .map((s) => [s.name, s.start]);
  const pattern = framework === "compose" ? COMPOSABLE : COMPONENT;
  return [...code.matchAll(pattern)].map((m) => [m[1] ?? m[2] ?? "", m.index]);
}

/** The scan's views, with those declared in the files edited since in place of the scan's own for those files. */
function viewsOf(framework: FilesForInput, files: Map<string, Code>): ScreenRef[] {
  const { scan, edited } = framework;
  const added = [...edited].flatMap((rel): ScreenRef[] => {
    const file = files.get(rel);
    if (!file) return [];
    return declaredViews(scan.framework, file).map(([name, at]) => {
      const line = file.text.slice(0, at).split("\n").length;
      return {
        id: `${scan.framework}:${rel}#${name}`,
        framework: scan.framework,
        name,
        file: rel,
        line,
        kind: "component",
        score: 0,
      };
    });
  });
  return [...scan.screens.filter((s) => !edited.has(s.file)), ...added];
}

const codeOf = (sources: FrameworkSources): Map<string, Code> =>
  sources.framework === "react-native"
    ? new Map(sources.files.map((f) => [f.rel, { text: f.text, code: jsCodeOnly(f.file) }]))
    : new Map<string, Code>(sources.files.map((f) => [f.rel, { text: f.text, code: f.code }]));

function holdersIn(files: Map<string, Code>, views: Map<string, ScreenRef[]>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [rel, { code }] of files)
    for (const m of code.matchAll(TYPE_DECLARATION)) {
      const name = m[1] ?? "";
      if (STATE_HOLDER.test(name) && !views.has(name)) out.set(name, (out.get(name) ?? new Set()).add(rel));
    }
  return out;
}

/** The files a value is written in, and those of each name on the way to it (`bodyLarge = Base.copy()`). */
const filesOf = (...locations: (ValueLocation | undefined)[]) =>
  locations.flatMap((location) =>
    location ? [location.file, ...(location.via ?? []).map((name) => name.file)] : [],
  );

/** Each token's files by its reference: a theme's color shares its default's reference, so it adds its own files. */
function filesByToken(tokens: DesignTokens): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (reference: string | undefined, files: string[]) => {
    if (!reference) return;
    const declaring = out.get(reference) ?? new Set<string>();
    for (const file of files) declaring.add(file);
    out.set(reference, declaring);
  };
  for (const color of [...tokens.colors, ...(tokens.themes ?? []).flatMap((t) => t.colors)])
    add(color.reference, [color.source, ...filesOf(color.locations?.light, color.locations?.dark)]);
  for (const { reference, locations } of tokens.typeStyles)
    add(reference, filesOf(locations?.fontFamily, locations?.fontSize, locations?.fontWeight));
  return out;
}

function indexScreens(framework: FilesForInput): ScreenIndex {
  const reader = readerOf(framework.sources);
  const files = codeOf(framework.sources);
  const views = groupBy(viewsOf(framework, files), (s) => s.name);
  return {
    reader,
    files,
    placements: groupBy(reader.placements(new Set(views.keys())), (p) => p.rel),
    views,
    holders: holdersIn(files, views),
    filesByToken: filesByToken(framework.tokens),
    modules:
      framework.sources.framework === "react-native"
        ? new Modules(framework.sources.files, new Set(framework.packages))
        : undefined,
    reading: framework.reading,
    uses: new Map(),
  };
}

interface Reached {
  view: ScreenRef;
  /** Where its declaration is in its file, when it could be found. */
  range: { start: number; end: number } | undefined;
}

/** The views a placement may mean: those of its name declared nearest it, all of them when equally near; none whose
 * file the view deleted. */
function placedViews(index: ScreenIndex, placement: Placement): ScreenRef[] {
  const named = (index.views.get(placement.name) ?? []).filter((view) => index.files.has(view.file));
  const near = named.map((view) => nearness(view.file, placement.rel));
  const most = Math.max(...near);
  return named.filter((_, i) => near[i] === most);
}

/** `view` and every view placed in its code, at any depth, each once, in the order they're reached. */
function viewsReached(index: ScreenIndex, view: ScreenRef): Reached[] {
  const reached = (v: ScreenRef): Reached => ({ view: v, range: index.reader.declaration(v) });
  const seen = new Set([view.id]);
  const out = [reached(view)];
  for (let i = 0; i < out.length; i++) {
    const { view: current, range } = out[i] as Reached;
    if (!range) continue;
    const placed = (index.placements.get(current.file) ?? []).filter(
      (p) => p.at >= range.start && p.at < range.end,
    );
    for (const child of placed.flatMap((p) => placedViews(index, p)))
      if (!seen.has(child.id)) {
        seen.add(child.id);
        out.push(reached(child));
      }
  }
  return out;
}

/** The part of its file each view's declaration covers, as written and blanked. */
function declarations(
  index: ScreenIndex,
  reached: Reached[],
): (Code & { rel: string; start: number; end: number })[] {
  return reached.flatMap(({ view, range }) => {
    const file = index.files.get(view.file);
    return file && range ? [{ ...file, rel: view.file, ...range }] : [];
  });
}

function stateFiles(index: ScreenIndex, reached: Reached[]): string[] {
  const named = new Set(
    declarations(index, reached).flatMap((own) => own.code.slice(own.start, own.end).match(IDENTIFIER) ?? []),
  );
  return [...named].flatMap((name) => [...(index.holders.get(name) ?? [])]);
}

function importsOf(modules: Modules, source: JsSource): string[] {
  return source.file.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
    return modules.resolve(statement.moduleSpecifier.text, source).map((f) => f.rel);
  });
}

function importedFiles(index: ScreenIndex, reached: Reached[]): string[] {
  const { modules } = index;
  if (!modules) return [];
  const sources = new Map(modules.sources.map((s) => [s.rel, s]));
  return [...new Set(reached.map(({ view }) => view.file))].flatMap((rel) => {
    const source = sources.get(rel);
    return source ? importsOf(modules, source) : [];
  });
}

/** The files declaring the colors and text styles the views' own code uses. */
function tokenFilesUsed(index: ScreenIndex, reached: Reached[]): string[] {
  return declarations(index, reached).flatMap(({ rel, text, start, end }) => {
    const uses = index.uses.get(rel) ?? tokensIn(index.reading, rel, text);
    index.uses.set(rel, uses);
    return [...uses.colors, ...uses.typeStyles]
      .filter((use) => use.span.start >= start && use.span.end <= end)
      .flatMap((use) => [...(index.filesByToken.get(use.token?.reference ?? "") ?? [])]);
  });
}

/** `filesFor` for one view of an app. */
export function makeFilesFor(input: () => FilesForInput) {
  let index: ScreenIndex | undefined;
  return (view: ScreenRef): ScreenFile[] => {
    index ??= indexScreens(input());
    const reached = viewsReached(index, view);
    const out = new Map<string, ScreenFile["why"]>([[view.file, "declaration"]]);
    const add = (files: string[], why: ScreenFile["why"]) => {
      for (const file of files) if (!out.has(file)) out.set(file, why);
    };
    add(
      reached.slice(1).map((s) => s.view.file),
      "child-view",
    );
    if (view.framework !== "react-native") add(stateFiles(index, reached), "state");
    add(tokenFilesUsed(index, reached), "tokens");
    add(importedFiles(index, reached), "import");
    return [...out].map(([file, why]) => ({ file, why }));
  };
}
