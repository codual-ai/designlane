import path from "node:path";
import { compose } from "../frameworks/compose.js";
import type { FrameworkPlugin, ScanContext } from "../frameworks/plugin.js";
import { reactNative, reactNativeRoots } from "../frameworks/react-native.js";
import { swiftui } from "../frameworks/swiftui.js";
import { viewKey } from "../frameworks/view-links.js";
import { classify } from "./classify.js";
import { listFiles, readText, type SourceFile } from "./files.js";
import { screenLinks } from "./screen-links.js";
import type { FrameworkId, ScanResult, ScreenRef } from "./types.js";

export const frameworks: readonly FrameworkPlugin[] = [swiftui, compose, reactNative];

export async function createContext(root: string): Promise<ScanContext> {
  const abs = path.resolve(root);
  const { files, truncated, unreadable } = await listFiles(abs);
  return { root: abs, files, truncated, unreadable, read: (file: SourceFile) => readText(file.abs) };
}

/** Views with the same file and name (nested types, `#if` branches) are told apart by line. */
function uniqueIds(screens: ScreenRef[]): ScreenRef[] {
  const counts = new Map<string, number>();
  for (const s of screens) counts.set(s.id, (counts.get(s.id) ?? 0) + 1);
  return screens.map((s) => ((counts.get(s.id) ?? 0) > 1 ? { ...s, id: `${s.id}@${s.line}` } : s));
}

const bestFirst = (a: ScreenRef, b: ScreenRef) =>
  b.score - a.score || a.name.localeCompare(b.name, "en", { numeric: true });

/** The folders a React Native app keeps its native side in (a widget, an extension), which aren't apps of their own. */
const nativeFolders = (roots: string[]) =>
  roots.flatMap((root) => ["ios", "android"].map((folder) => (root ? `${root}/${folder}/` : `${folder}/`)));

/** `ctx` with only the files `keep` says, for reading a React Native app's native side apart from the rest. */
const withFiles = (ctx: ScanContext, keep: (rel: string) => boolean): ScanContext => ({
  ...ctx,
  files: ctx.files.filter((f) => keep(f.rel)),
});

/** Finds every supported framework in the project, its screens (best first) and its design tokens. */
export async function scanRepo(root: string): Promise<ScanResult> {
  return scanContext(await createContext(root));
}

/** `scanRepo` over files a context lists and reads, which may be in memory. */
export async function scanContext(ctx: ScanContext): Promise<ScanResult> {
  const result: ScanResult = {
    root: ctx.root,
    frameworks: [],
    filesScanned: ctx.files.length,
    truncated: ctx.truncated,
    unreadable: ctx.unreadable,
  };
  // A React Native app's own native folders are left out of the native scans, once the app is found.
  const roots = await reactNativeRoots(ctx);
  const app = roots.length > 0 ? await reactNative.scan(ctx) : undefined;
  const native = app ? nativeFolders(roots) : [];
  const inNative = (rel: string) => native.some((folder) => rel.startsWith(folder));
  const nativeAlongside: FrameworkId[] = [];
  for (const plugin of frameworks) {
    const own = plugin.id !== "react-native" && native.length > 0;
    const found =
      plugin === reactNative ? app : await plugin.scan(own ? withFiles(ctx, (rel) => !inNative(rel)) : ctx);
    if (own && (await plugin.scan(withFiles(ctx, inNative)))) nativeAlongside.push(plugin.id);
    if (!found) continue;
    const screens = uniqueIds(classify(plugin.id, found.views));
    const idOf = new Map(screens.map((s) => [viewKey(s), s.id]));
    const linked = screenLinks(screens, found.links ?? [], found.placements ?? []);
    const starts = (found.starts ?? []).flatMap((v) => idOf.get(viewKey(v)) ?? []);
    const unresolvedLinks = (found.unresolvedLinks ?? 0) + linked.unresolved;
    result.frameworks.push({
      framework: plugin.id,
      platforms: plugin.platforms,
      screens: screens.sort(bestFirst),
      tokens: found.tokens,
      ...(found.links && { links: linked.links }),
      ...(starts.length > 0 && { starts }),
      ...(unresolvedLinks > 0 && { unresolvedLinks }),
      ...(found.navigationNotRead?.length && { navigationNotRead: found.navigationNotRead }),
      ...(found.themesOutside?.length ? { themesOutside: found.themesOutside } : {}),
    });
  }
  return nativeAlongside.length > 0 ? { ...result, nativeAlongside } : result;
}
