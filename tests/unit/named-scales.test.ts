import { describe, expect, it } from "vitest";
import { toDesignMd } from "../../src/output/design-md.js";
import { toDesignTokens } from "../../src/output/tokens-json.js";
import { scanRepo } from "../../src/scan/index.js";
import type { FrameworkId } from "../../src/scan/types.js";
import { planSync } from "../../src/sync/plan.js";
import { readTokensFile } from "../../src/sync/tokens-file.js";
import { step, syncedFile, tokens } from "../helpers/sync-tokens.js";
import { tempDir } from "../helpers/temp.js";

const SWIFT_SPACING = [
  "import SwiftUI",
  "public enum AppSpacing {",
  "    public static let small: CGFloat = 8",
  "    public static let large: CGFloat = 16",
  "    public static let buttonHeight: CGFloat = 44",
  "}",
  "",
].join("\n");
const SWIFT_USES = [
  "import SwiftUI",
  "struct Card: View {",
  '  var body: some View { Text("Hi").padding(AppSpacing.large).padding(.top, AppSpacing.small).padding(AppSpacing.large) }',
  "}",
].join("\n");

async function scales(framework: FrameworkId, files: Record<string, string>) {
  const scan = await scanRepo(await tempDir(files));
  return { scan, scales: scan.frameworks.find((f) => f.framework === framework)?.tokens.scales };
}

describe("named spacing and radius scales", () => {
  it("reads a Swift scale with each step's reference, uses and where its value is written, leaving sizes out", async () => {
    const { scales: found } = await scales("swiftui", {
      "App/Style/AppSpacing.swift": SWIFT_SPACING,
      "App/Card.swift": SWIFT_USES,
    });
    expect(found?.spacing.map((s) => [s.reference, s.value, s.uses])).toEqual([
      ["AppSpacing.small", 8, 1],
      ["AppSpacing.large", 16, 2],
    ]);
    const small = found?.spacing[0];
    expect(small?.location).toMatchObject({ file: "App/Style/AppSpacing.swift", line: 3, kind: "literal" });
    const start = SWIFT_SPACING.indexOf("8");
    expect([small?.location.start, small?.location.end]).toEqual([start, start + 1]);
    expect(found?.radii).toEqual([]);
  });

  it("leaves out a screen's own constants: nested in a view's type, private, or used only in their own file", async () => {
    const { scales: found } = await scales("swiftui", {
      "App/Card.swift": [
        "import SwiftUI",
        "struct CardView: View {",
        "  enum Spacing { static let small: CGFloat = 8; static let large: CGFloat = 16 }",
        '  var body: some View { Text("").padding(Spacing.small) }',
        "}",
        "enum Radius {\n  private static let small: CGFloat = 4\n  private static let large: CGFloat = 8\n}",
        "enum Padding {\n  static let small: CGFloat = 4\n  static let large: CGFloat = 8\n}",
        "let p = Padding.small + Padding.large",
      ].join("\n"),
      "App/Other.swift": "import SwiftUI\nlet r = Radius.small\n",
    });
    expect(found).toBeUndefined();
  });

  it("reads a scale nested in the app's theme", async () => {
    const { scales: found } = await scales("swiftui", {
      "App/Theme.swift": [
        "import SwiftUI",
        "enum Theme {",
        "  enum CornerRadius {",
        "    static let card: CGFloat = 12",
        "    static let pill: CGFloat = 999",
        "  }",
        "}",
      ].join("\n"),
      "App/Card.swift": "import SwiftUI\nlet r = Theme.CornerRadius.card\n",
    });
    expect(found?.radii.map((s) => s.reference)).toEqual([
      "Theme.CornerRadius.card",
      "Theme.CornerRadius.pill",
    ]);
  });

  it("reads a Compose object and a data class read through a composition local", async () => {
    const { scales: found } = await scales("compose", {
      "app/src/main/kotlin/ui/theme/Spacing.kt": [
        "import androidx.compose.ui.unit.dp",
        "import androidx.compose.runtime.Composable",
        "object Radii {",
        "    val card = 12.dp",
        "    val sheet: Dp = 28.dp",
        "}",
        "data class Spacing(",
        "    val small: Dp = 8.dp,",
        "    val medium: Dp = 12.dp,",
        ")",
      ].join("\n"),
      "app/src/main/kotlin/ui/Home.kt": [
        "import androidx.compose.runtime.Composable",
        "@Composable fun Home() { Box(Modifier.padding(LocalSpacing.current.medium).clip(RoundedCornerShape(Radii.card))) }",
      ].join("\n"),
    });
    expect(found?.spacing.map((s) => [s.reference, s.value, s.uses])).toEqual([
      ["Spacing.small", 8, 0],
      ["Spacing.medium", 12, 1],
    ]);
    expect(found?.radii.map((s) => [s.reference, s.value, s.location.kind])).toEqual([
      ["Radii.card", 12, "expression"],
      ["Radii.sheet", 28, "expression"],
    ]);
  });

  it("reads exported JavaScript scales, a theme's too, counting accesses and component props", async () => {
    const { scales: found } = await scales("react-native", {
      "package.json": '{ "dependencies": { "react-native": "0.76.0" } }',
      "src/theme.ts": [
        "export const space = { '4px': 4, '8px': 8, '15px (Deprecated)': 15 } as const;",
        "export const theme = { radii: { card: 12, pill: 999 } };",
        "const local = { spacing: { a: 1, b: 2 } };",
      ].join("\n"),
      "src/Card.tsx": [
        'import { View } from "react-native";',
        'export const Card = () => <Box padding="8px" style={{ borderRadius: theme.radii.card, margin: space["4px"] }} />;',
      ].join("\n"),
    });
    expect(found?.spacing.map((s) => [s.reference, s.uses])).toEqual([
      ['space["4px"]', 1],
      ['space["8px"]', 1],
    ]);
    expect(found?.radii.map((s) => [s.reference, s.uses])).toEqual([
      ["theme.radii.card", 1],
      ["theme.radii.pill", 0],
    ]);
  });

  it("writes the steps to tokens.json and DESIGN.md, and a sync reads them by reference", async () => {
    const { scan } = await scales("swiftui", {
      "App/Style/AppSpacing.swift": SWIFT_SPACING,
      "App/Card.swift": SWIFT_USES,
    });
    const file = toDesignTokens(scan);
    expect(file.spacing).toMatchObject({
      small: { $type: "dimension", $value: { value: 8, unit: "px" } },
      large: { $extensions: { designlane: { reference: "AppSpacing.large", uses: 2, line: 4 } } },
    });
    expect(readTokensFile(JSON.parse(JSON.stringify(file))).spacing).toEqual([
      { identity: "spacing:AppSpacing.small", key: "small", value: 8, reference: "AppSpacing.small" },
      { identity: "spacing:AppSpacing.large", key: "large", value: 16, reference: "AppSpacing.large" },
    ]);
    const md = toDesignMd(scan);
    expect(md).toContain('  small: "8px"');
    expect(md).toContain(
      "The spacing scale the code names, in `App/Style/AppSpacing.swift`: AppSpacing.small 8px (1 use)",
    );
  });
});

describe("syncing named scale steps", () => {
  it("updates a step's variable when its value changes, and creates it as a gap variable named by its key", () => {
    const first = planSync(tokens({ spacing: [step("spacing", "AppSpacing.large", 16)] }), {
      variables: [],
      textStyles: [],
    });
    expect(first.variables.create.map((v) => [v.name, v.reference])).toEqual([
      ["spacing/large", "AppSpacing.large"],
    ]);
    const file = syncedFile(tokens({ spacing: [step("spacing", "AppSpacing.large", 16)] }));
    const plan = planSync(tokens({ spacing: [step("spacing", "AppSpacing.large", 18)] }), file).variables;
    expect(plan.update.map((u) => [u.name, u.token.value])).toEqual([["spacing/large", 18]]);
    expect([plan.create, plan.deprecate]).toEqual([[], []]);
  });

  it("keeps a variable an older file made for a bare value, renamed to the step with that value", () => {
    const file = syncedFile(tokens({ spacing: [16] }));
    const plan = planSync(tokens({ spacing: [step("spacing", "AppSpacing.large", 16)] }), file).variables;
    expect(plan.rename.map((r) => [r.name, r.token.identity])).toEqual([
      ["spacing/16", "spacing:AppSpacing.large"],
    ]);
    expect([plan.create, plan.deprecate]).toEqual([[], []]);
  });

  it("follows a step the code renamed, keeping its variable", () => {
    const file = syncedFile(
      tokens({ radii: [step("radius", "Radii.card", 12), step("radius", "Radii.pill", 999)] }),
    );
    const plan = planSync(
      tokens({ radii: [step("radius", "Radii.tile", 12), step("radius", "Radii.pill", 999)] }),
      file,
    ).variables;
    expect(plan.rename.map((r) => [r.name, r.token.identity])).toEqual([
      ["radius/card", "radius:Radii.tile"],
    ]);
  });
});
