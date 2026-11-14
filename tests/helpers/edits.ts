/** A tokens.json recording where its values are written in a few files, and edits planned against those files. */

import { type EditPlan, planEdit, type TokenChange } from "../../src/edit/plan.js";
import type { ValueKind } from "../../src/scan/types.js";

export type Files = Record<string, string>;

/** Text in a file, the first place it's written unless `nth` says otherwise. */
export interface Place {
  file: string;
  text: string;
  nth?: number;
}

/** Where a value is written, and each name on the way to it. */
export interface At extends Place {
  kind: ValueKind;
  via?: Place[];
}

export interface ColorSpec {
  key: string;
  reference?: string;
  /** `#rrggbb` or `#rrggbbaa`. */
  light: string;
  dark?: string;
  at?: { light?: At; dark?: At };
}

export interface StyleSpec {
  key: string;
  reference?: string;
  family?: string;
  size?: number;
  weight?: number;
  at?: { fontFamily?: At; fontSize?: At; fontWeight?: At };
}

/** The span of `place` in `files`. */
export function spanOf(files: Files, { file, text, nth = 0 }: Place) {
  const code = files[file] ?? "";
  let start = -1;
  for (let i = 0; i <= nth; i++) start = code.indexOf(text, start + 1);
  if (start === -1) throw new Error(`${text} isn't in ${file}`);
  return { file, line: code.slice(0, start).split("\n").length, start, end: start + text.length };
}

const located = (files: Files, at: At) => ({
  ...spanOf(files, at),
  kind: at.kind,
  ...(at.via ? { via: at.via.map((place) => spanOf(files, place)) } : {}),
});

const locations = (files: Files, at: Record<string, At | undefined> = {}) =>
  Object.fromEntries(
    Object.entries(at).flatMap(([key, place]) => (place ? [[key, located(files, place)]] : [])),
  );

const colorValue = (hex: string) => ({
  colorSpace: "srgb",
  components: [0, 0, 0],
  hex: hex.slice(0, 7),
  ...(hex.length === 9 ? { alpha: Number.parseInt(hex.slice(7), 16) / 255 } : {}),
});

const colorGroup = (files: Files, colors: ColorSpec[]) =>
  Object.fromEntries(
    colors.map(({ key, reference, light, dark, at }) => [
      key,
      {
        $type: "color",
        $value: colorValue(light),
        $extensions: {
          designmap: {
            ...(reference ? { reference } : {}),
            source: "Theme.swift",
            uses: 1,
            ...(dark ? { modes: { dark: colorValue(dark) } } : {}),
            locations: locations(files, at),
          },
        },
      },
    ]),
  );

/** A tokens.json with `colors`, `styles` and other themes' colours, their values written where `files` has them. */
export function tokensFile(
  files: Files,
  {
    colors = [],
    styles = [],
    themes = {},
  }: { colors?: ColorSpec[]; styles?: StyleSpec[]; themes?: Record<string, ColorSpec[]> },
) {
  const typography = Object.fromEntries(
    styles.map(({ key, reference, family, size, weight, at }) => [
      key,
      {
        $extensions: {
          designmap: {
            name: key,
            ...(reference ? { reference } : {}),
            uses: 1,
            locations: locations(files, at),
          },
        },
        ...(family ? { fontFamily: { $type: "fontFamily", $value: family } } : {}),
        ...(size ? { fontSize: { $type: "dimension", $value: { value: size, unit: "px" } } } : {}),
        ...(weight ? { fontWeight: { $type: "fontWeight", $value: weight } } : {}),
      },
    ]),
  );
  const theme = Object.fromEntries(
    Object.entries(themes).map(([key, list]) => [
      key,
      { $extensions: { designmap: { name: key } }, color: colorGroup(files, list) },
    ]),
  );
  return {
    $description: "Read from the code of Shop by Designmap",
    color: { $description: "Most used first", ...colorGroup(files, colors) },
    typography: { $description: "Most used first", ...typography },
    theme,
  };
}

/** The edit making `change` in `files`, as tokens.json describes them. */
export function plan(files: Files, tokens: unknown, change: TokenChange): Promise<EditPlan> {
  return planEdit(tokens, async (file) => files[file], change);
}

/** What a plan writes, or why it refuses. */
export const outcome = (planned: EditPlan) =>
  planned.ok ? planned.edit.after : `refused: ${planned.reason}`;

/** What the code says after changing the colour `Brand`, written as `text` in `file`, from `old` to `to`. */
export async function recolored(file: string, code: string, at: Omit<At, "file">, old: string, to: string) {
  const files = { [file]: code };
  const tokens = tokensFile(files, {
    colors: [{ key: "Brand", light: old, at: { light: { file, ...at } } }],
  });
  return outcome(await plan(files, tokens, { token: "Brand", property: "light", value: to }));
}

/** What the code says after changing a text style's value, written as `text` in `file`, from `old` to `to`. */
export async function restyled(
  property: "family" | "size" | "weight",
  file: string,
  code: string,
  at: Omit<At, "file">,
  old: string | number,
  to: string,
) {
  const files = { [file]: code };
  const key = { family: "fontFamily", size: "fontSize", weight: "fontWeight" }[property];
  const style: StyleSpec = { key: "Title", [property]: old, at: { [key]: { file, ...at } } };
  const tokens = tokensFile(files, { styles: [style] });
  return outcome(await plan(files, tokens, { token: "Title", property, value: to }));
}

/** A palette and a theme naming its colours. */
export const PALETTE: Files = {
  "src/colors.ts": [
    "export const colors = { blue0: '#BFE1FF', gray1: '#F3F3F8' };",
    "export const themes = {",
    "  light: { link: colors.blue0, surface: colors.blue0 },",
    "};",
  ].join("\n"),
};
/** Where `link` (the `nth` name of `colors.blue0`) is written, through the name. */
export const linkAt = (nth: number) => ({
  file: "src/colors.ts",
  text: "#BFE1FF",
  kind: "literal" as const,
  via: [{ file: "src/colors.ts", text: "colors.blue0", nth }],
});
