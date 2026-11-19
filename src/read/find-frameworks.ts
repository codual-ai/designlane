/**
 * Which frameworks an app is built with, from its file names and manifests alone, with no code read: fast enough to
 * show before the app is read. A guess `readApp` settles: a Swift project with no SwiftUI view, say, has no screens.
 */

import path from "node:path";
import { reactNativeRoots } from "../frameworks/react-native.js";
import { createContext } from "../scan/index.js";
import type { FoundFramework } from "./schema.js";

/** Gradle build files, which name Compose when a module uses it. */
const GRADLE = /(?:^|\/)build\.gradle(?:\.kts)?$/;
const COMPOSE = /\bcompose\b/i;
/** A path inside an `ios/` or `android/` folder. */
const NATIVE_FOLDER = /(?:^|\/)(?:ios|android)\//;
/** What marks a folder as an Apple app or package. */
const APPLE_PROJECT = /(?:^|\/)(?:[^/]+\.xcodeproj\/project\.pbxproj|Package\.swift)$/;
/** An Xcode project's own folder in a path, so the path reads as a file in the folder holding the project. */
const XCODEPROJ = /[^/]+\.xcodeproj\//;

/** The folder of each file `rel` matches, `""` for the app's own, each once, in order. */
const foldersOf = (rels: string[]) => [
  ...new Set(rels.map((rel) => (path.posix.dirname(rel) === "." ? "" : path.posix.dirname(rel)))),
];

/** The frameworks found in `root`, in the order `readApp` lists them. */
export async function findFrameworks(root: string): Promise<FoundFramework[]> {
  const ctx = await createContext(root);
  const rels = ctx.files.map((f) => f.rel);
  const rnRoots = await reactNativeRoots(ctx);
  // A React Native app's native code (its own `ios/` and `android/` folders, and its native modules') holds widgets,
  // extensions and bridges, not apps of their own.
  const own = rnRoots.length ? rels.filter((rel) => !NATIVE_FOLDER.test(rel)) : rels;
  const found: FoundFramework[] = [];
  if (own.some((rel) => rel.endsWith(".swift"))) {
    // An Xcode project's folder is the one holding `App.xcodeproj`; a Swift package's, the one with `Package.swift`.
    const projects = foldersOf(
      own.filter((rel) => APPLE_PROJECT.test(rel)).map((rel) => rel.replace(XCODEPROJ, "")),
    );
    found.push({ framework: "swiftui", platforms: ["ios"], roots: projects.length ? projects : [""] });
  }
  const owned = new Set(own);
  const gradle = ctx.files.filter((f) => GRADLE.test(f.rel) && owned.has(f.rel));
  const compose: string[] = [];
  for (const file of gradle) if (COMPOSE.test((await ctx.read(file)) ?? "")) compose.push(file.rel);
  if (compose.length && own.some((rel) => rel.endsWith(".kt")))
    found.push({ framework: "compose", platforms: ["android"], roots: foldersOf(compose) });
  if (rnRoots.length) found.push({ framework: "react-native", platforms: ["react-native"], roots: rnRoots });
  return found;
}
