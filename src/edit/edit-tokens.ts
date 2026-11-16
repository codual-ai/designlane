/** The tokens in a tokens.json an edit can change: each colour and text style, its values, and where each is written. */

import { z } from "zod";
import {
  type ColorTokenEntry,
  type ColorValue,
  parseTokensFile,
  type ValueLocation as RecordedLocation,
  type TextStyleGroup,
} from "../output/tokens-schema.js";
import { type Color, rgbOf } from "./color-value.js";

export const COLOR_PROPERTIES = ["light", "dark"] as const;
const TYPE_PROPERTIES = ["family", "size", "weight"] as const;
export const EDIT_PROPERTIES = [...COLOR_PROPERTIES, ...TYPE_PROPERTIES] as const;
export type EditProperty = (typeof EDIT_PROPERTIES)[number];

export const PROPERTY_NAMES: Record<EditProperty, string> = {
  light: "colour",
  dark: "dark colour",
  family: "font family",
  size: "font size",
  weight: "font weight",
};

/** How a message names one value of a token: `link's dark colour`. */
export const valueLabel = (key: string, property: EditProperty) => `${key}'s ${PROPERTY_NAMES[property]}`;

/** A value of a token, as tokens.json has it, and where it's written when the file records that. */
export type TokenValue = { location?: ValueLocation } & (
  | { property: (typeof COLOR_PROPERTIES)[number]; old: Color }
  | { property: "size" | "weight"; old: number }
  | { property: "family"; old: string }
);

/** Where a value is written, as tokens.json records it. */
export type ValueLocation = z.output<typeof RecordedLocation>;

export interface EditableToken {
  /** Its key in tokens.json; a theme's colour is `<theme key>/<colour key>`. */
  key: string;
  /** How the code refers to it (`Theme.surface`) and, for a text style, its name. */
  names: string[];
  values: TokenValue[];
  /** The line declaring it, when tokens.json records one. */
  declared?: { file: string; line: number };
}

type ColorEntry = z.output<typeof ColorTokenEntry>;
type TypeEntry = z.output<typeof TextStyleGroup>;

/** Every colour and text style in `json`, or an error saying the file isn't a tokens.json Designlane writes. */
export function editableTokens(json: unknown): { colors: EditableToken[]; textStyles: EditableToken[] } {
  const file = parseTokensFile(json);
  if (!file.success) {
    throw new Error(
      `This isn't a tokens.json Designlane writes. Run designlane on the app again. ${z.prettifyError(file.error)}`,
    );
  }
  const themes = entries(file.data.theme).flatMap(([themeKey, theme]) =>
    entries(theme.color).map(([key, entry]) => colorToken(`${themeKey}/${key}`, entry)),
  );
  return {
    colors: [...entries(file.data.color).map(([key, entry]) => colorToken(key, entry)), ...themes],
    textStyles: entries(file.data.typography).map(([key, entry]) => typeToken(key, entry)),
  };
}

const entries = <T>(group: Record<string, string | T> | undefined): [string, T][] =>
  Object.entries(group ?? {}).flatMap(([key, value]) => (typeof value === "string" ? [] : [[key, value]]));

function color(value: z.output<typeof ColorValue>): Color {
  return { ...rgbOf(value.hex.slice(1)), alpha: Math.round((value.alpha ?? 1) * 255) };
}

/** `value` with where it's written, when the file records that. */
function located<T extends TokenValue>(value: T, location: ValueLocation | undefined): T {
  return location ? { ...value, location } : value;
}

function colorToken(key: string, entry: ColorEntry): EditableToken {
  const { reference, modes, locations, source, line } = entry.$extensions.designlane;
  const values: TokenValue[] = [located({ property: "light", old: color(entry.$value) }, locations?.light)];
  if (modes) values.push(located({ property: "dark", old: color(modes.dark) }, locations?.dark));
  const names = reference ? [reference] : [];
  return { key, names, values, ...(line ? { declared: { file: source, line } } : {}) };
}

function typeToken(key: string, entry: TypeEntry): EditableToken {
  const { name, reference, locations } = entry.$extensions.designlane;
  const values: TokenValue[] = [];
  if (entry.fontFamily) {
    values.push(located({ property: "family", old: entry.fontFamily.$value }, locations?.fontFamily));
  }
  if (entry.fontSize) {
    values.push(located({ property: "size", old: entry.fontSize.$value.value }, locations?.fontSize));
  }
  if (entry.fontWeight) {
    values.push(located({ property: "weight", old: entry.fontWeight.$value }, locations?.fontWeight));
  }
  return { key, names: reference ? [reference, name] : [name], values };
}

/** The one token `name` names among `tokens`: by its key first, then by how the code refers to it or its name. */
export function findToken(
  tokens: EditableToken[],
  name: string,
): { token: EditableToken } | { reason: string } {
  const byKey = tokens.filter((token) => token.key === name);
  const found = byKey.length > 0 ? byKey : tokens.filter((token) => token.names.includes(name));
  const [only] = found;
  if (found.length === 1 && only) return { token: only };
  if (found.length === 0) return { reason: `tokens.json has no ${name}.` };
  const keys = found.map((token) => token.key).join(", ");
  return { reason: `${name} could be any of ${found.length} tokens (${keys}); name it by its key.` };
}
