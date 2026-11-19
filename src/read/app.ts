/**
 * An app read once, for answering many questions about it without reading it again: `readApp` scans it and keeps
 * every file's text; `withChanges` gives a view of it with some files changed (copy-on-write, the app untouched),
 * reading only those files again; `update` changes the app itself, for a working tree being edited.
 */

import path from "node:path";
import { RESOURCE_FILE } from "../frameworks/android-resources.js";
import { isScript } from "../frameworks/js-sources.js";
import type { FrameworkPlugin, ScanContext } from "../frameworks/plugin.js";
import { opacityFirstIn } from "../frameworks/swiftui-colors.js";
import { swiftSource } from "../frameworks/swiftui-sources.js";
import { isColorset } from "../frameworks/xcode-colors.js";
import type { SourceFile } from "../scan/files.js";
import { createContext, frameworks as plugins, scanContext } from "../scan/index.js";
import type { DesignTokens, FrameworkId, FrameworkScan, ScanResult, ScreenRef } from "../scan/types.js";
import { changedTokens, tokenFiles } from "./changed-tokens.js";
import type { FileTokens } from "./schema.js";
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
}

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
      index: tokenIndex(tokens, scan.framework, scan.platforms[0] ?? "ios", before?.reading.index),
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
  const next: State = { ...state, files, texts };
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
  let state: State = { root: disk.root, files: disk.files, texts, frameworks, scan };
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
