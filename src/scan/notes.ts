import { FRAMEWORK_NAMES, type ScanResult } from "./types.js";

/** What to do about a theme the app reads from a library outside the project, in a sentence, or undefined. */
export function themesOutsideNote(scan: Pick<ScanResult, "frameworks">): string | undefined {
  const themes = [...new Set(scan.frameworks.flatMap((f) => f.themesOutside ?? []))];
  if (!themes.length) return undefined;
  const names = themes.map((t) => `\`${t}\``).join(" and ");
  const one = themes.length === 1;
  return (
    `This app's theme (${names}) is defined outside this project, so its colours and text styles aren't here. ` +
    `Run Designlane on the repo that defines ${one ? "it" : "them"}, and connect the Figma plugin there.`
  );
}

/** What a navigation library Designlane doesn't read means for the result, in a sentence, or undefined. */
function navigationNotReadNote(scan: Pick<ScanResult, "frameworks">): string | undefined {
  const libraries = [...new Set(scan.frameworks.flatMap((f) => f.navigationNotRead ?? []))];
  if (!libraries.length) return undefined;
  return (
    `This app moves between screens with ${libraries.join(" and ")}, which Designlane doesn't read yet: its screens ` +
    "are found by what they contain, and the links between them aren't listed."
  );
}

/** What a React Native app's native code means for the result, in a sentence, or undefined. */
function nativeAlongsideNote(scan: Pick<ScanResult, "nativeAlongside">): string | undefined {
  const native = scan.nativeAlongside ?? [];
  if (!native.length) return undefined;
  const names = native.map((f) => FRAMEWORK_NAMES[f]).join(" and ");
  return `This React Native app also has ${names} code, its native side (widgets, extensions): only the React Native app is read.`;
}

/** Everything a reader of the scan should know about what it couldn't see, as sentences. */
export const scanNotes = (scan: Pick<ScanResult, "frameworks" | "nativeAlongside">) =>
  [themesOutsideNote(scan), navigationNotReadNote(scan), nativeAlongsideNote(scan)].filter(
    (note) => note !== undefined,
  );
