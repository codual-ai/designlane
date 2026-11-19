/** Tokens as a sync reads them, and a design file as a first sync leaves it: what the sync tests start from. */

import { scanRepo, toDesignTokens } from "../../src/index.js";
import {
  type CodeToken,
  type DesignFile,
  type DesignFileEntry,
  planSync,
  type VariableValue,
} from "../../src/sync/plan.js";
import {
  readTokensFile,
  type SyncColor,
  type SyncDimension,
  type SyncTokens,
  type TextValue,
} from "../../src/sync/tokens-file.js";
import { tempDir } from "./temp.js";

export const APP = {
  "App/Theme.swift": [
    "import SwiftUI",
    "enum Theme {",
    "  static let brand = Color(red: 0.2, green: 0.4, blue: 0.9)",
    "  static let glass = Color(red: 1, green: 0, blue: 0, opacity: 0.5)",
    "}",
    "extension Font { static let heading = Font.system(size: 22, weight: .semibold) }",
  ].join("\n"),
  "App/Home.swift": [
    "import SwiftUI",
    "let accent = Color(red: 0, green: 0.5, blue: 0)",
    "struct Home: View {",
    "  var body: some View { Text(t).font(.heading).foregroundStyle(Theme.brand).tint(accent)",
    "    .padding(8).cornerRadius(12).background(Theme.glass) }",
    "}",
  ].join("\n"),
};

/** The tokens Designlane writes for `files`, read back the way a sync reads them. */
export async function tokensOf(files: Record<string, string>): Promise<SyncTokens> {
  return readTokensFile(JSON.parse(JSON.stringify(toDesignTokens(await scanRepo(await tempDir(files))))));
}

/** Spacing and radii given as bare values are an older file's, known by the value; a step is given as itself. */
type Dimensions = (number | SyncDimension)[];
const asDimensions = (kind: "spacing" | "radius", values: Dimensions = []): SyncDimension[] =>
  values.map((v) =>
    typeof v === "number" ? { identity: `${kind}:${v}`, key: `${kind}-${v}`, value: v } : v,
  );

export const tokens = ({
  spacing,
  radii,
  ...parts
}: Partial<Omit<SyncTokens, "spacing" | "radii">> & {
  spacing?: Dimensions;
  radii?: Dimensions;
}): SyncTokens => ({
  colors: [],
  textStyles: [],
  complete: true,
  ...parts,
  spacing: asDimensions("spacing", spacing),
  radii: asDimensions("radius", radii),
});

/** A step of a scale the code names: `step("spacing", "WMFSpacing.large", 16)`. */
export const step = (kind: "spacing" | "radius", reference: string, value: number): SyncDimension => ({
  identity: `${kind}:${reference}`,
  key: reference.split(".").at(-1) ?? reference,
  value,
  reference,
});
export const color = (identity: string, hex: string, extra: Partial<SyncColor> = {}): SyncColor => ({
  identity,
  key: identity.replace(/^color:/, ""),
  light: { hex, alpha: 1 },
  ...extra,
});

/** A colour token as tokens.json writes it, for a file-local `reference` in `source`. */
export const colorEntry = (hex: string, reference: string, source = "A.swift", line?: number) => ({
  $type: "color",
  $value: { colorSpace: "srgb", components: [0, 0, 0], hex },
  $extensions: { designlane: { reference, source, uses: 1, ...(line ? { line } : {}) } },
});

/** A design file as a first sync of `code` leaves it: every token made, with its identity. */
export function syncedFile(code: SyncTokens): DesignFile {
  const first = planSync(code, { variables: [], textStyles: [] });
  const entry = <V>(token: CodeToken<V>, i: number): DesignFileEntry<V> => ({
    id: `${token.identity}#${i}`,
    name: token.name,
    identity: token.identity,
    value: token.value,
    deprecated: false,
  });
  const fullStyle = (value: TextValue): Required<TextValue> => ({
    family: "SF Pro",
    size: 17,
    weight: 400,
    ...value,
  });
  return {
    variables: first.variables.create.map(entry),
    textStyles: first.textStyles.create.map((token, i) => ({
      ...entry(token, i),
      value: fullStyle(token.value),
    })),
  };
}

/** The first variable a synced file has; every caller syncs at least one. */
export function firstVariable(file: DesignFile): DesignFileEntry<VariableValue> {
  const [first] = file.variables;
  if (!first) throw new Error("the synced file has no variables");
  return first;
}
