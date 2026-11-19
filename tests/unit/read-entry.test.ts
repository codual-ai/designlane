import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findFrameworks } from "../../src/read/index.js";
import { kotlin, RN_MANIFEST, swift } from "../helpers/catalog.js";
import { appIn } from "../helpers/read-apps.js";

const SRC = path.join(process.cwd(), "src");
const IMPORT = /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/g;
/** What a reader of the code must never load: the command line, the MCP server and its SDK, the Figma sync, the
 * code edits and the output files. */
const NOT_READING = ["cli", "mcp", "sync", "edit", "output/write.ts", "previews"].map((p) =>
  path.join(SRC, p),
);

/** Every module `entry` loads, its own files by path and packages by name. */
function importGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  for (let file = stack.pop(); file; file = stack.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    if (!file.startsWith(SRC)) continue;
    for (const [, specifier = ""] of readFileSync(file, "utf8").matchAll(IMPORT))
      stack.push(
        specifier.startsWith(".")
          ? path.resolve(path.dirname(file), specifier).replace(/\.js$/, ".ts")
          : specifier,
      );
  }
  return seen;
}

describe("designlane/read", () => {
  it("loads none of the command line, the MCP server, the Figma sync, the code edits or the output files", () => {
    const loaded = [...importGraph(path.join(SRC, "read", "index.ts"))];
    expect(loaded.filter((m) => m.includes("@modelcontextprotocol"))).toEqual([]);
    expect(loaded.filter((m) => NOT_READING.some((p) => m.startsWith(p)))).toEqual([]);
  });

  it("is a package export of its own", () => {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
    expect(pkg.exports["./read"]).toEqual({
      types: "./dist/read/index.d.ts",
      default: "./dist/read/index.js",
    });
  });
});

describe("findFrameworks", () => {
  it("finds each framework from file names and manifests, with the folders its code is in", async () => {
    const root = await appIn({
      "ios/Shop.xcodeproj/project.pbxproj": "",
      "ios/Shop/App.swift": swift("struct A: View { var body: some View { Text(t) } }"),
      "android/app/build.gradle.kts": "android { buildFeatures { compose = true } }",
      "android/app/src/main/java/a/A.kt": kotlin("@Composable fun A() {}"),
      "android/lib/build.gradle.kts": "dependencies { implementation(libs.okhttp) }",
    });
    expect(await findFrameworks(root)).toEqual([
      { framework: "swiftui", platforms: ["ios"], roots: ["ios"] },
      { framework: "compose", platforms: ["android"], roots: ["android/app"] },
    ]);
  });

  it("takes a React Native app's native folders for part of it, not apps of their own", async () => {
    const root = await appIn({
      ...RN_MANIFEST,
      "App.tsx": 'import { View } from "react-native";',
      "ios/Widget/Widget.swift": swift("struct W: View { var body: some View { Text(t) } }"),
      "modules/bridge/ios/Bridge.swift": "import Foundation",
    });
    expect(await findFrameworks(root)).toEqual([
      { framework: "react-native", platforms: ["react-native"], roots: [""] },
    ]);
  });
});
