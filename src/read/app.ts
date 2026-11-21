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
import { opacityFirstIn } from "../frameworks/swiftui-colors.js";
import { type SwiftSource, swiftSource } from "../frameworks/swiftui-sources.js";
import { isColorset } from "../frameworks/xcode-colors.js";
import type { SourceFile } from "../scan/files.js";
import { createContext, frameworks as plugins, scanContext } from "../scan/index.js";
import { isTestPath } from "../scan/test-paths.js";
import type { DesignTokens, FrameworkId, FrameworkScan, ScanResult, ScreenRef } from "../scan/types.js";
import { changedTokens, tokenFiles } from "./changed-tokens.js";
import { makeFilesFor } from "./files-for.js";
import type { FileTokens, ScreenFile, StringUse } from "./schema.js";
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
   * followed too. `screen` is one the scan found: throws for one this view doesn't have, or whose file it deletes. */
  filesFor(screen: string | ScreenRef): ScreenFile[];
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
  return {
    root: state.root,
    frameworks: scans,
    screens: (framework) =>
      scans.filter((f) => !framework || f.framework === framework).flatMap((f) => f.screens),
    screen: (id) => byId.get(id),
    tokensIn(rel, text) {
      const framework = frameworkOf(state, rel);
      const source = text ?? state.texts.get(rel);
      return framework && source !== undefined ? tokensIn(framework.reading, rel, source) : undefined;
    },
    stringsIn(rel, text) {
      const framework = frameworkOf(state, rel);
      const source = text ?? state.texts.get(rel);
      return framework && source !== undefined
        ? stringsIn(framework.scan.framework, rel, source, tableOf(state))
        : undefined;
    },
    filesFor(screen) {
      const id = typeof screen === "string" ? screen : screen.id;
      const found = byId.get(id);
      const finder = found && finders.get(found.framework);
      // A view that deletes a screen's file has no screen there, though its scan, read before, lists it.
      if (!found || !finder || !state.texts.has(found.file))
        throw new Error(`No screen ${id} in the app: pass an id from app.screens().`);
      return finder(found);
    },
    withChanges: async (changes) => viewOf(await changed(state, new Map(Object.entries(changes)))),
  };
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
    get frameworks() {
      return view.frameworks;
    },
    screens: (framework) => view.screens(framework),
    screen: (id) => view.screen(id),
    tokensIn: (rel, text) => view.tokensIn(rel, text),
    stringsIn: (rel, text) => view.stringsIn(rel, text),
    filesFor: (screen) => view.filesFor(screen),
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
