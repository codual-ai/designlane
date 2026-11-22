/**
 * An app read once, for answering many questions about it without reading it again: `readApp` scans it and keeps
 * every file's text; `withChanges` gives a view of it with some files changed (copy-on-write, the app untouched),
 * reading only those files again; `update` changes the app itself, for a working tree being edited.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { FrameworkSources } from "../catalog/sources.js";
import { RESOURCE_FILE } from "../frameworks/android-resources.js";
import { isScript, type JsSource, jsSource } from "../frameworks/js-sources.js";
import { type KotlinSource, kotlinSource } from "../frameworks/kotlin-sources.js";
import type { FrameworkPlugin, ScanContext } from "../frameworks/plugin.js";
import { type Locator, locator } from "../frameworks/source-text.js";
import { opacityFirstIn } from "../frameworks/swiftui-colors.js";
import { type SwiftSource, swiftSource } from "../frameworks/swiftui-sources.js";
import { isColorset } from "../frameworks/xcode-colors.js";
import type { SourceFile } from "../scan/files.js";
import { createContext, frameworks as plugins, scanContext } from "../scan/index.js";
import { isTestPath } from "../scan/test-paths.js";
import type { DesignTokens, FrameworkId, FrameworkScan, ScanResult, ScreenRef } from "../scan/types.js";
import { changedTokens, tokenFiles } from "./changed-tokens.js";
import { makeFilesFor } from "./files-for.js";
import { layoutIssues, type Readings } from "./layout-issues.js";
import { type LayoutIndex, layoutIndex } from "./layout-of.js";
import type { FileTokens, LayoutIssues, LayoutNode, ScreenFile, ScreenPart, StringUse } from "./schema.js";
import { type PartReading, readParts, screenParts } from "./screen-parts.js";
import {
  decodeStrings,
  isStringsFile,
  type StringsFile,
  type StringTable,
  stringsFile,
  stringTable,
} from "./string-table.js";
import { stringsIn } from "./strings-in.js";
import { tokenIndex } from "./token-index.js";
import { type Reading, tokensIn } from "./tokens-in.js";

/** What every view of an app answers. */
export interface AppView {
  readonly root: string;
  /** The frameworks found, as the scan reads them; a view's changes don't add or drop screens. */
  readonly frameworks: readonly FrameworkScan[];
  /** What the scan left out: whether it stopped at its limit of files, and the folders it couldn't open. Nothing in
   * them is in any answer. */
  readonly skipped: { readonly truncated: boolean; readonly unreadable: readonly string[] };
  /** Every screen and component, best first within each framework; only `framework`'s when given. */
  screens(framework?: FrameworkId): ScreenRef[];
  /** The screen or component with this id, or undefined when there's none. */
  screen(id: string): ScreenRef | undefined;
  /** The values the file at `rel` (relative to the app's folder) uses, read from `text` when given, else from the
   * file as this view has it. Undefined for a file that isn't code of one of the app's frameworks. `text` is read
   * with the tokens as this view has them: to read a changed theme, make a view with it (`withChanges`). */
  tokensIn(rel: string, text?: string): FileTokens | undefined;
  /** The text the file at `rel` shows people, read from `text` when given, else from the file as this view has it, in
   * the order it's written: words written in the code, and translated strings it names by key, with their text from
   * the app's strings files as this view has them. Undefined for a file that isn't code of one of the app's
   * frameworks. */
  stringsIn(rel: string, text?: string): StringUse[] | undefined;
  /** The files that explain the screen or component `screen` (its id, or itself), each once, by the first reason it's
   * related, its own file first: the views it places at any depth, the types holding its state, the project's files
   * it imports, and where the tokens it uses are declared; a view declared in a file this view adds or changes is
   * followed too. `screen` is one the scan found, or one declared in a file this view adds or changes (a layout's ref):
   * throws for one this view doesn't have, or whose file it deletes. */
  filesFor(screen: string | ScreenRef): ScreenFile[];
  /** The layout of the screen or component `screen` (its id, or itself) as this view has its code: the screen,
   * holding its containers, decisions, loops, the views it places and the elements it shows, in the order written.
   * A placed view is a `view-ref` naming the view, whose own layout is `layoutOf` it. Undefined when its code can't be
   * read whole (left unfinished, or past the reader's limits), never a layout of part of it. `screen` is one the scan found, or one declared in a file this view adds or changes: throws
   * for one this view doesn't have, or whose file it deletes. */
  layoutOf(screen: string | ScreenRef): LayoutNode | undefined;
  /** The main parts of the screen or component `screen`, as a person picks one to change. Stepping in from the screen
   * through what holds only one thing (a navigation, a scroll, a stack, what it writes inside a container of the
   * app's, the one view it places, the biggest branch of an `if` over all of it), they're the nodes of the first one
   * that holds two or more, each with its id in the layout of `view` (the screen, or the view it's all placed in) and
   * a label to show. What only runs code or opens dialogs isn't a part. The label is the first of: a section's or
   * toolbar's title, the placed view's name (`HeaderView` → "Header"), the view property it's the first thing of
   * (`plansSection` → "Plans section"), a short comment on the line above, what an `if`'s biggest branch or a loop's
   * item is named, the first text it shows, its kind; at most 24 characters, numbered when another part has it
   * ("Card", "Card 2"). Empty when no node holds two or more; undefined when a layout on the way is. Throws as
   * `layoutOf` does. */
  screenParts(screen: string | ScreenRef): ScreenPart[] | undefined;
  /** Where Designlane falls short on the screen or component `screen`: why its layout, or that of a view its parts are
   * found in, couldn't be read whole (`unreadable`: the reason, the view, and where), and what may be wrong in one
   * that was (`issues`: an element no framework table names, a name several views have, a part named by its kind
   * alone, …), each where it's written. The reasons and kinds stay the same from release to release. Throws as
   * `layoutOf` does. */
  layoutIssues(screen: string | ScreenRef): LayoutIssues;
  /** A view of this one with `changes` made: each path's new text, or null for a file deleted. */
  withChanges(changes: Readonly<Record<string, string | null>>): Promise<AppView>;
}

export interface App extends AppView {
  /** Makes one change to the app itself (null for a file deleted), as a file watcher sees it. */
  update(rel: string, text: string | null): Promise<void>;
}

/** One framework as a view reads it. */
interface Framework {
  scan: FrameworkScan;
  plugin: FrameworkPlugin;
  tokens: DesignTokens;
  /** Every file holding one of its tokens' values. */
  files: ReadonlySet<string>;
  /** Swift files with a hex helper reading eight digits opacity first, which every reading of the tokens needs. */
  helpers: ReadonlySet<string>;
  reading: Reading;
}

/** Everything a view holds: the files' texts and each framework's reading; never changed once made. */
interface State {
  root: string;
  files: readonly SourceFile[];
  texts: ReadonlyMap<string, string>;
  frameworks: ReadonlyMap<FrameworkId, Framework>;
  scan: ScanResult;
  /** Each file parsed, by path, once something has needed it: shared with the views made from this one, which drop
   * the files they change. */
  parsed: Map<string, Parsed>;
  /** Files changed since the app was scanned. */
  edited: ReadonlySet<string>;
  /** The app's strings files, each read once it's needed, and their table: shared with the views made from this one
   * until one changes a strings file. */
  strings: Strings;
}

interface Strings {
  files: Map<string, StringsFile>;
  table?: StringTable;
}

type Parsed = SwiftSource | KotlinSource | JsSource;

const EXTENSIONS: Record<FrameworkId, (rel: string) => boolean> = {
  swiftui: (rel) => rel.endsWith(".swift"),
  compose: (rel) => rel.endsWith(".kt"),
  "react-native": isScript,
};
/** Files beside the code that declare tokens: asset catalog colours, Android resources, CSS themes. */
const TOKEN_RESOURCES: Record<FrameworkId, (rel: string) => boolean> = {
  swiftui: isColorset,
  compose: (rel) => RESOURCE_FILE.test(rel),
  "react-native": (rel) => rel.endsWith(".css"),
};

function frameworkOf(state: State, rel: string): Framework | undefined {
  for (const framework of state.frameworks.values())
    if (EXTENSIONS[framework.scan.framework](rel)) return framework;
  return undefined;
}

interface Parts {
  scan: FrameworkScan;
  plugin: FrameworkPlugin;
  tokens: DesignTokens;
  helpers: ReadonlySet<string>;
}

/** A framework's reading of `tokens`, keeping the keys `before` gave the tokens it still has. */
function framework({ scan, plugin, tokens, helpers }: Parts, before?: Framework): Framework {
  return {
    scan,
    plugin,
    tokens,
    helpers,
    files: tokenFiles(tokens),
    reading: {
      framework: scan.framework,
      index: tokenIndex(
        tokens,
        scan.framework,
        scan.platforms[0] ?? "ios",
        before?.reading.index,
        scan.themesOutside,
      ),
      opacityFirst: helpers.size > 0,
    },
  };
}

/** `helpers` after `texts` changed: each changed Swift file is a helper when its new text has one. */
function helpersAfter(helpers: ReadonlySet<string>, texts: Iterable<[string, string | null]>): Set<string> {
  const out = new Set(helpers);
  for (const [rel, text] of texts) {
    if (!rel.endsWith(".swift")) continue;
    if (text && opacityFirstIn([swiftSource(rel, text)])) out.add(rel);
    else out.delete(rel);
  }
  return out;
}

/** `framework`'s source files in `state`, as the catalog reads them, each parsed once; tests left out. */
function sourcesOf(state: State, framework: FrameworkId): FrameworkSources {
  const parse = framework === "swiftui" ? swiftSource : framework === "compose" ? kotlinSource : jsSource;
  const files: Parsed[] = [];
  for (const { rel } of state.files) {
    const text = state.texts.get(rel);
    if (!text || !EXTENSIONS[framework](rel) || isTestPath(rel)) continue;
    const source = state.parsed.get(rel) ?? parse(rel, text);
    state.parsed.set(rel, source);
    files.push(source);
  }
  if (framework === "compose") return { framework, files: files as KotlinSource[] };
  if (framework === "react-native") return { framework, files: files as JsSource[] };
  return { framework, files: files as SwiftSource[] };
}

/** The packages `state`'s package.json files depend on. */
function packagesOf(state: State): Set<string> {
  const out = new Set<string>();
  for (const { rel } of state.files) {
    if (rel !== "package.json" && !rel.endsWith("/package.json")) continue;
    try {
      const manifest = JSON.parse(state.texts.get(rel) ?? "{}") as Record<string, unknown>;
      for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
        const list = manifest[field];
        if (typeof list === "object" && list !== null) for (const name of Object.keys(list)) out.add(name);
      }
    } catch {
      // A package.json that isn't JSON names no packages.
    }
  }
  return out;
}

/** `state`'s strings table, worked out once it's needed. */
function tableOf(state: State): StringTable {
  const { strings } = state;
  if (strings.table) return strings.table;
  const files: StringsFile[] = [];
  for (const { rel } of state.files) {
    const text = state.texts.get(rel);
    if (text === undefined || !isStringsFile(rel)) continue;
    const file = strings.files.get(rel) ?? stringsFile(rel, text);
    strings.files.set(rel, file);
    files.push(file);
  }
  strings.table = stringTable(files);
  return strings.table;
}

/** The largest strings file read: a string catalog holding every language can be several megabytes. */
const MAX_STRINGS_BYTES = 32 * 1024 * 1024;

/** The app's strings files the scan didn't read, read into `texts`. */
async function readStrings(files: readonly SourceFile[], texts: Map<string, string>): Promise<void> {
  for (const file of files) {
    if (texts.has(file.rel) || !isStringsFile(file.rel)) continue;
    try {
      if ((await stat(file.abs)).size <= MAX_STRINGS_BYTES)
        texts.set(file.rel, decodeStrings(await readFile(file.abs)));
    } catch {
      // A strings file that can't be read (gone, or not permitted) gives no text: its keys read as null.
    }
  }
}

/** A context listing `state`'s files and reading their texts from it, with nothing read from disk. */
function contextOf(state: State): ScanContext {
  return {
    root: state.root,
    files: [...state.files],
    truncated: state.scan.truncated,
    unreadable: state.scan.unreadable,
    read: async (file) => state.texts.get(file.rel),
  };
}

/** `state` with `changes` made, reading again only the changed files and the tokens they declare. */
async function changed(state: State, changes: ReadonlyMap<string, string | null>): Promise<State> {
  const texts = new Map(state.texts);
  // A deleted file stays listed: with no text, every reader skips it.
  const files = [...state.files];
  const listed = new Set(files.map((f) => f.rel));
  for (const [rel, text] of changes) {
    if (text === null) texts.delete(rel);
    else texts.set(rel, text);
    if (text !== null && !listed.has(rel)) files.push({ rel, abs: path.join(state.root, rel) });
  }
  const parsed = new Map(state.parsed);
  for (const rel of changes.keys()) parsed.delete(rel);
  const edited = new Set([...state.edited, ...changes.keys()]);
  const strings = [...changes.keys()].some(isStringsFile)
    ? { files: new Map([...state.strings.files].filter(([rel]) => !changes.has(rel))) }
    : state.strings;
  const next: State = { ...state, files, texts, parsed, edited, strings };
  const ctx = contextOf(next);
  const frameworks = new Map<FrameworkId, Framework>();
  for (const [id, before] of state.frameworks) {
    const declares = (rel: string) =>
      EXTENSIONS[id](rel) || TOKEN_RESOURCES[id](rel) || before.files.has(rel);
    const helpers = id === "swiftui" ? helpersAfter(before.helpers, changes) : before.helpers;
    // Whether hex digits read opacity first decides every hex colour's value, so when it flips each token is read again.
    const flipped = helpers.size > 0 !== before.helpers.size > 0;
    const reread = flipped
      ? new Map([...[...before.files].map((rel) => [rel, texts.get(rel) ?? null] as const), ...changes])
      : changes;
    const tokens = await changedTokens(before.plugin, before.tokens, reread, ctx, declares, helpers);
    const same = !tokens && !flipped;
    frameworks.set(
      id,
      same
        ? { ...before, helpers }
        : framework({ ...before, tokens: tokens ?? before.tokens, helpers }, before),
    );
  }
  return { ...next, frameworks };
}

function viewOf(state: State): AppView {
  const scans = [...state.frameworks.values()].map((f) => f.scan);
  const byId = new Map(scans.flatMap((f) => f.screens.map((s) => [s.id, s] as const)));
  const finders = new Map(
    [...state.frameworks].map(([id, f]) => [
      id,
      makeFilesFor(() => ({
        scan: f.scan,
        tokens: f.tokens,
        reading: f.reading,
        sources: sourcesOf(state, id),
        packages: packagesOf(state),
        edited: state.edited,
      })),
    ]),
  );
  const layouts = new Map<FrameworkId, () => LayoutIndex>(
    [...state.frameworks].map(([id, f]) => {
      let index: LayoutIndex | undefined;
      return [
        id,
        () => {
          index ??= layoutIndex({
            scan: f.scan,
            sources: sourcesOf(state, id),
            edited: state.edited,
            packages: packagesOf(state),
          });
          return index;
        },
      ];
    }),
  );
  /** The view `screen` names, and its framework's layouts: one the scan found, or one declared in a file changed since,
   * which only the layouts know; none in a file deleted. */
  const viewNamed = (screen: string | ScreenRef): [ScreenRef, LayoutIndex] => {
    const id = typeof screen === "string" ? screen : screen.id;
    // An id starts with its framework's (`swiftui:App/Cart.swift#Cart`), so only that framework is read.
    const index = [...layouts].find(([framework]) => id.startsWith(`${framework}:`))?.[1]();
    // A screen the scan found in a file changed since that its rules for changed files don't find is still that screen.
    const scanned = byId.get(id);
    const found = index?.views.get(id) ?? (scanned && state.texts.has(scanned.file) ? scanned : undefined);
    if (!index || !found)
      throw new Error(`No screen ${id} in the app: pass an id from app.screens() or a layout's ref.`);
    return [found, index];
  };
  const stringsOf = (rel: string, text?: string) => {
    const framework = frameworkOf(state, rel);
    const source = text ?? state.texts.get(rel);
    return framework && source !== undefined
      ? stringsIn(framework.scan.framework, rel, source, tableOf(state))
      : undefined;
  };
  /** What `screenParts` reads: each view's layout, and each file's text shown, read once for all the views it looks
   * into. */
  const partReading = (layoutOf?: PartReading["layoutOf"]): PartReading => {
    const layouts = new Map<string, LayoutNode | undefined>();
    const strings = new Map<string, StringUse[]>();
    return {
      layoutOf:
        layoutOf ??
        ((id) => {
          if (!layouts.has(id)) {
            const [view, index] = viewNamed(id);
            layouts.set(id, index.layoutOf(view));
          }
          return layouts.get(id);
        }),
      namesOf: (id) => {
        const [view, index] = viewNamed(id);
        const shown = strings.get(view.file) ?? stringsOf(view.file) ?? [];
        strings.set(view.file, shown);
        return {
          text: state.texts.get(view.file) ?? "",
          code: index.code(view.file) ?? state.texts.get(view.file) ?? "",
          strings: shown,
          viewName: (ref) => index.views.get(ref)?.name,
          memberAt: (offset) => index.memberAt(view.file, offset),
        };
      },
    };
  };
  // Each file's line index, found once for all the spans of it.
  const locators = new Map<string, Locator>();
  // What layoutIssues reads, kept for every call on this view: an app's issues are found screen by screen, and the
  // views several screens place are read once for all of them.
  const layoutReadings = new Map<string, ReturnType<Readings["layout"]>>();
  const readLayout = (screen: string | ScreenRef) => {
    const [found, index] = viewNamed(screen);
    let read = layoutReadings.get(found.id);
    if (!read) {
      read = { view: found, reading: index.read(found) };
      layoutReadings.set(found.id, read);
    }
    return read;
  };
  let sharedParts: PartReading | undefined;
  const readings: Readings = {
    layout: readLayout,
    parts: (screen) => {
      sharedParts ??= partReading((id) => {
        const { reading } = readLayout(id);
        return "layout" in reading ? reading.layout : undefined;
      });
      return readParts(viewNamed(screen)[0].id, sharedParts);
    },
    span: (rel, start, end) => {
      let locate = locators.get(rel);
      if (!locate) {
        locate = locator(rel, state.texts.get(rel) ?? "");
        locators.set(rel, locate);
      }
      return locate(start, end);
    },
  };
  const view: AppView = {
    root: state.root,
    frameworks: scans,
    skipped: { truncated: state.scan.truncated, unreadable: state.scan.unreadable },
    screens: (framework) =>
      scans.filter((f) => !framework || f.framework === framework).flatMap((f) => f.screens),
    screen: (id) => byId.get(id),
    tokensIn(rel, text) {
      const framework = frameworkOf(state, rel);
      const source = text ?? state.texts.get(rel);
      return framework && source !== undefined ? tokensIn(framework.reading, rel, source) : undefined;
    },
    stringsIn: stringsOf,
    filesFor(screen) {
      const [found] = viewNamed(screen);
      const finder = finders.get(found.framework);
      if (!finder) throw new Error(`No screen ${found.id} in the app: pass an id from app.screens().`);
      return finder(found);
    },
    layoutOf(screen) {
      const [found, index] = viewNamed(screen);
      return index.layoutOf(found);
    },
    screenParts(screen) {
      const [found] = viewNamed(screen);
      return screenParts(found.id, partReading());
    },
    layoutIssues: (screen) => layoutIssues(readings, screen),
    withChanges: async (changes) => viewOf(await changed(state, new Map(Object.entries(changes)))),
  };
  return view;
}

/** Scans the app in `root` once, keeping every file's text, for many questions to share. */
export async function readApp(root: string): Promise<App> {
  const disk = await createContext(root);
  const texts = new Map<string, string>();
  // Each file is read once, by the scan, and kept.
  const ctx: ScanContext = {
    ...disk,
    read: async (file) => {
      const known = texts.get(file.rel);
      if (known !== undefined) return known;
      const text = await disk.read(file);
      if (text !== undefined) texts.set(file.rel, text);
      return text;
    },
  };
  const scan = await scanContext(ctx);
  await readStrings(disk.files, texts);
  const frameworks = new Map<FrameworkId, Framework>();
  for (const found of scan.frameworks) {
    const plugin = plugins.find((p) => p.id === found.framework);
    if (plugin)
      frameworks.set(
        found.framework,
        framework({
          scan: found,
          plugin,
          tokens: found.tokens,
          helpers: found.framework === "swiftui" ? helpersAfter(new Set(), texts) : new Set(),
        }),
      );
  }
  let state: State = {
    root: disk.root,
    files: disk.files,
    texts,
    frameworks,
    scan,
    parsed: new Map(),
    edited: new Set(),
    strings: { files: new Map() },
  };
  let view = viewOf(state);
  let updating = Promise.resolve();
  const app: App = {
    get root() {
      return view.root;
    },
    get skipped() {
      return view.skipped;
    },
    get frameworks() {
      return view.frameworks;
    },
    screens: (framework) => view.screens(framework),
    screen: (id) => view.screen(id),
    tokensIn: (rel, text) => view.tokensIn(rel, text),
    stringsIn: (rel, text) => view.stringsIn(rel, text),
    filesFor: (screen) => view.filesFor(screen),
    layoutOf: (screen) => view.layoutOf(screen),
    screenParts: (screen) => view.screenParts(screen),
    layoutIssues: (screen) => view.layoutIssues(screen),
    withChanges: (changes) => view.withChanges(changes),
    // Each update starts from the one before, so two made at once both land; one that fails doesn't stop the next.
    update(rel, text) {
      const next = updating.then(async () => {
        state = await changed(state, new Map([[rel, text]]));
        view = viewOf(state);
      });
      updating = next.catch(() => undefined);
      return next;
    },
  };
  return app;
}
