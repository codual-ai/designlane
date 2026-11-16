import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_PROMPT } from "../../src/cli/agent-prompt.js";
import { run } from "../../src/cli/run.js";
import { mergeAgentTokens } from "../../src/scan/agent-tokens.js";
import { scanRepo } from "../../src/scan/index.js";
import { tempDir } from "../helpers/temp.js";

const RN = 'import { View } from "react-native";\n';

/** A React Native app whose palette Designlane's own reading misses: built by a function, not written as an object. */
const APP = {
  "package.json": '{ "dependencies": { "react-native": "0.76.0" } }',
  "src/palette.ts": [
    'export const makePalette = (base: string) => ({ surface: base, ink: "#16161A", glow: "rgb(51, 102, 230)" });',
    'export const palette = makePalette("#F2F2F7");',
    "export const typography = { body: { fontFamily: 'Inter', fontSize: 15 } };",
    'export const fonts = buildFonts({ headline: ["Inter", 22] });',
  ].join("\n"),
  "src/Home.tsx": `${RN}export const Home = () => <View />;`,
};

const merged = async (agent: object, files: Record<string, string> = APP) =>
  mergeAgentTokens(await scanRepo(await tempDir(files)), agent);

describe("a coding agent's reading", () => {
  it("adds the colours the code writes, as hex or as channels, by how the code refers to them", async () => {
    const { scan, added, dropped } = await merged({
      colors: {
        "palette.ink": { light: "#16161a" },
        "palette.glow": { light: "#3366e6" },
      },
    });
    const colors = scan.frameworks[0]?.tokens.colors ?? [];
    expect(colors.find((c) => c.reference === "palette.ink")).toMatchObject({
      name: "ink",
      light: "#16161a",
      source: "src/palette.ts",
      kind: "code",
    });
    expect(colors.find((c) => c.reference === "palette.glow")?.light).toBe("#3366e6");
    expect([added, dropped]).toEqual([2, []]);
  });

  it("leaves out what the code doesn't bear out: a value it never writes, or a name it never uses", async () => {
    const { added, dropped } = await merged({
      colors: {
        "palette.ghost": { light: "#16161a" },
        "palette.ink": { light: "#abcdef" },
        "palette.surface": { light: "#f2f2f7", dark: "not a colour" },
      },
      textStyles: { "typography.missing": { size: 15 } },
    });
    expect(added).toBe(0);
    expect(dropped).toEqual(["palette.ghost", "palette.ink", "palette.surface", "typography.missing"]);
  });

  it("adds a text style the code names, with a weight it knows, and nothing Designlane already read", async () => {
    const { scan, added } = await merged({
      textStyles: {
        "fonts.headline": { family: "Inter", size: 22, weight: "semibold" },
        "fonts.subhead": { size: 15, weight: "very heavy" },
      },
    });
    const styles = scan.frameworks[0]?.tokens.typeStyles ?? [];
    expect(styles.find((s) => s.reference === "fonts.headline")).toMatchObject({
      kind: "app",
      family: "Inter",
      size: 22,
      weight: "semibold",
    });
    // `subhead` isn't a name the code uses.
    expect(added).toBe(1);
    // A style Designlane read itself is kept as it read it; one with neither size nor family says nothing.
    const again = await mergeAgentTokens(scan, {
      textStyles: { "fonts.headline": { size: 40 }, "palette.ink": { weight: "bold" } },
    });
    expect(again.added).toBe(0);
    expect(again.dropped).toEqual(["palette.ink"]);
    expect(
      again.scan.frameworks[0]?.tokens.typeStyles.find((s) => s.reference === "fonts.headline")?.size,
    ).toBe(22);
  });

  it("skips a colour Designlane already has, by how the code refers to it or by its value", async () => {
    const files = {
      ...APP,
      "src/theme.ts":
        'export const themes = { light: { accent: "#FF6B00" } };\nexport const brandAccent = themes.light.accent;',
    };
    const scan = await scanRepo(await tempDir(files));
    const known = scan.frameworks[0]?.tokens.colors.find((c) => c.light === "#ff6b00");
    expect(known).toBeDefined();
    const byName = await mergeAgentTokens(scan, {
      colors: { [known?.reference ?? ""]: { light: "#ff6b00" } },
    });
    const byValue = await mergeAgentTokens(scan, {
      colors: { brandAccent: { light: "#ff6b00" } },
    });
    expect([byName.added, byValue.added, byValue.dropped]).toEqual([0, 0, []]);
  });

  it("checks a colour exactly: its dark value too, its opacity, whole literals, and shorthand hex", async () => {
    const files = {
      ...APP,
      "src/extra.ts": [
        // Built by calls, so Designlane's own reading doesn't name them.
        'export const night = pick("#202125"); export const mist = pick("#ccc");',
        "const cache16161abc = true;",
      ].join("\n"),
    };
    const { added, dropped } = await merged(
      {
        colors: {
          "palette.ink": { light: "#16161a", dark: "#abcdef" },
          "palette.surface": { light: "#f2f2f700" },
          mist: { light: "#cccccc" },
          night: { light: "#202125" },
        },
      },
      files,
    );
    expect(dropped).toEqual(["palette.ink", "palette.surface"]);
    expect(added).toBe(2);
    const onlyInAName = await merged(
      { colors: { cache: { light: "#16161a" } } },
      { ...files, "src/palette.ts": 'export const x = "#16161ag"; export const cache = 1;' },
    );
    expect(onlyInAName.dropped).toEqual(["cache"]);
  });

  it("reads names written in brackets, and never counts Designlane's own folders, nested ones included", async () => {
    const files = {
      ...APP,
      "src/brand.ts": 'export const colors = build({ "brand-blue": "#1a73e8" });',
      "apps/web/designlane/agent.json": '{ "colors": { "ghost": { "light": "#999999" } } }',
    };
    const { added, dropped } = await merged(
      { colors: { 'colors["brand-blue"]': { light: "#1a73e8" }, ghost: { light: "#999999" } } },
      files,
    );
    expect([added, dropped]).toEqual([1, ["ghost"]]);
  });

  it("speed: reads a file of long runs of numbers quickly", async () => {
    const files = { ...APP, "src/noise.ts": `export const n = [${"0, ".repeat(100_000)}1];` };
    const started = performance.now();
    await merged({ colors: { "palette.glow": { light: "#3366e6" } } }, files);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it("skips a colour one of the app's other themes already has", async () => {
    const files = {
      ...APP,
      "src/theme.ts": [
        "export const themes = {",
        '  light: { ink: "#111111", paper: "#ffffff" },',
        '  dark: { ink: "#eeeeee", paper: "#000000" },',
        '  sepia: { ink: "#704214", paper: "#f4ecd8" },',
        "};",
        "export const sepiaInk = themes.sepia.ink;",
      ].join("\n"),
    };
    const scan = await scanRepo(await tempDir(files));
    expect(scan.frameworks[0]?.tokens.themes?.length).toBe(1);
    const { added, dropped } = await mergeAgentTokens(scan, { colors: { sepiaInk: { light: "#704214" } } });
    expect([added, dropped]).toEqual([0, []]);
  });

  it("refuses a file in another shape, and a repo with more than one app", async () => {
    await expect(merged({ colors: { ink: "#000000" } })).rejects.toThrow(/expected shape/);
    const twoApps = {
      "ios/App/Theme.swift":
        "import SwiftUI\nenum Theme { static let ink = Color(red: 0, green: 0, blue: 0) }",
      "android/app/src/main/java/Theme.kt":
        "import androidx.compose.ui.graphics.Color\nval Ink = Color(0xFF000000)",
    };
    await expect(merged({ colors: {} }, twoApps)).rejects.toThrow(/more than one app/);
  });
});

describe("designlane prompt and --from-agent", () => {
  const designlane = async (...argv: string[]) => {
    const out: string[] = [];
    const error: string[] = [];
    const code = await run(argv, { out: (t) => out.push(t), error: (t) => error.push(t) });
    return { code, out: out.join("\n"), error: error.join("\n") };
  };

  it("prints the agent's instructions, naming the file and its shape", async () => {
    const { code, out } = await designlane("prompt");
    expect(code).toBe(0);
    expect(out).toBe(AGENT_PROMPT);
    expect(out).toContain("designlane/agent.json");
  });

  it("writes the agent's tokens the code bears out, and says what it left out", async () => {
    const root = await tempDir({
      ...APP,
      "designlane/agent.json": JSON.stringify({
        colors: { "palette.ink": { light: "#16161a" }, "palette.ghost": { light: "#123456" } },
      }),
    });
    const { code, out, error } = await designlane(
      root,
      "--from-agent",
      path.join(root, "designlane", "agent.json"),
    );
    expect(code).toBe(0);
    expect(out).toContain("Added 1 token from");
    expect(error).toContain("left out 1 token the code doesn't bear out: palette.ghost");
    const tokens = JSON.parse(await readFile(path.join(root, "designlane", "tokens.json"), "utf8"));
    expect(JSON.stringify(tokens.color)).toContain("palette.ink");
  });

  it("prints the scan with the agent's tokens for --json, its summary kept off stdout", async () => {
    const root = await tempDir({
      ...APP,
      "agent.json": JSON.stringify({ colors: { "palette.ink": { light: "#16161a" } } }),
    });
    const { code, out, error } = await designlane(
      root,
      "--json",
      "--from-agent",
      path.join(root, "agent.json"),
    );
    expect(code).toBe(0);
    expect(error).toContain("Added 1 token");
    const colors: { reference?: string }[] = JSON.parse(out).frameworks[0].tokens.colors;
    expect(colors.some((c) => c.reference === "palette.ink")).toBe(true);
  });

  it("says when the agent's file can't be read", async () => {
    const root = await tempDir(APP);
    const { code, error } = await designlane(root, "--from-agent", path.join(root, "missing.json"));
    expect(code).toBe(1);
    expect(error).toContain("couldn't read");
  });
});
