/** For each kind of value an edit changes, how to read the new value it's given and the value the code writes. */

import { assetReadings, callChannelReadings } from "./color-channels.js";
import { hexReadings } from "./color-hex.js";
import { type Color, parseColor, sameColor, showColor } from "./color-value.js";
import type { SpanText, Written } from "./notation.js";
import { familyReadings, sizeReadings, weightReadings } from "./type-values.js";

export interface ValueEditor<T> {
  /** What a new value looks like, for when one isn't. */
  expected: string;
  parse: (input: string) => T | undefined;
  /** Each way the code's text can be read; none when it's in no notation this editor can rewrite. */
  readings: (span: SpanText) => Written<T>[];
  same: (a: T, b: T) => boolean;
  show: (value: T) => string;
}

const same = <T>(a: T, b: T) => a === b;
const NUMBER = /^\d+(?:\.\d+)?$/;
const MIN_WEIGHT = 100;
const MAX_WEIGHT = 900;

export const COLOR_EDITOR: ValueEditor<Color> = {
  expected: "a colour like #ff8800, or #ff880080 with its opacity",
  parse: parseColor,
  readings: (span) => [...hexReadings(span), ...callChannelReadings(span), ...assetReadings(span)],
  same: sameColor,
  show: showColor,
};

export const SIZE_EDITOR: ValueEditor<number> = {
  expected: "a size in points above 0, like 17",
  parse: (input) => {
    const size = NUMBER.test(input.trim()) ? Number(input) : 0;
    return size > 0 && Number.isFinite(size) ? size : undefined;
  },
  readings: sizeReadings,
  same,
  show: String,
};

export const WEIGHT_EDITOR: ValueEditor<number> = {
  expected: "a weight from 100 to 900 by the hundred, like 600",
  parse: (input) => {
    const weight = NUMBER.test(input.trim()) ? Number(input) : 0;
    return weight >= MIN_WEIGHT && weight <= MAX_WEIGHT && weight % 100 === 0 ? weight : undefined;
  },
  readings: weightReadings,
  same,
  show: String,
};

export const FAMILY_EDITOR: ValueEditor<string> = {
  expected: "a font family's name",
  parse: (input) => input.trim() || undefined,
  readings: familyReadings,
  same,
  show: (family) => `"${family}"`,
};
