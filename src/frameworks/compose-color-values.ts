/** What a Compose colour expression is worth: `Color(0xFFD0BCFF)`, `Color(red = 0.5f, …)`, `Color.White`,
 * `Brand.copy(alpha = 0.5f)`, `colorResource(R.color.brand)`, or a named colour. */

import { rgbToHex } from "../scan/tokens.js";
import type { ValueLocation } from "../scan/types.js";
import { type Argument, callArguments } from "./kotlin-calls.js";
import { type KotlinSource, spanIn, treeOf } from "./kotlin-sources.js";
import { through, valueAt } from "./value-locations.js";

/** Compose's own colour constants, as `#rrggbb[aa]`. */
export const COMPOSE_COLORS: Record<string, string> = {
  Black: "#000000",
  DarkGray: "#444444",
  Gray: "#888888",
  LightGray: "#cccccc",
  White: "#ffffff",
  Red: "#ff0000",
  Green: "#00ff00",
  Blue: "#0000ff",
  Yellow: "#ffff00",
  Cyan: "#00ffff",
  Magenta: "#ff00ff",
  Transparent: "#00000000",
};

/** Alpha first, `aarrggbb`, as `#rrggbb[aa]`. */
function fromArgb(argb: string): string {
  const alpha = argb.slice(0, 2);
  return `#${argb.slice(2)}${alpha === "ff" ? "" : alpha}`;
}

/** `0xFFD0BCFF` as `#d0bcff`: Compose reads the number as alpha, red, green, blue, so six digits are fully
 * transparent (`0x6650A4` is `#6650a400`), as Compose draws them. */
export function argbHex(literal: string): string | undefined {
  const digits = literal.match(/^0x([0-9a-f]{1,8})[uUlL]*$/i)?.[1];
  return digits ? fromArgb(digits.padStart(8, "0").toLowerCase()) : undefined;
}

/** An Android resource colour, `#rgb`, `#argb`, `#rrggbb` or `#aarrggbb`, as `#rrggbb[aa]`. */
export function androidHex(value: string): string | undefined {
  let hex = value
    .trim()
    .match(/^#([0-9a-f]+)$/i)?.[1]
    ?.toLowerCase();
  if (!hex || ![3, 4, 6, 8].includes(hex.length)) return undefined;
  if (hex.length <= 4) hex = [...hex].map((c) => c + c).join("");
  return hex.length === 6 ? `#${hex}` : fromArgb(hex);
}

/** A channel: `0.5f` as a 0–1 fraction, `128` as 0–255. */
function channel(value: string): number | undefined {
  const m = value.match(/^(\d+(?:\.\d+)?|\.\d+)([fF])?$/);
  if (!m?.[1]) return undefined;
  const n = Number(m[1]);
  return m[2] || m[1].includes(".") ? n : n / 255;
}

/** A colour's value, and where it's written when it's written as it is (`Color(0xFF6650A4)`) or reached by name. */
export interface ColorAt {
  hex: string;
  location?: ValueLocation;
}

/** A colour the app names, by how the code wrote the name in `file`. */
export type ColorLookup = (name: string, file: string) => ColorAt | undefined;

/** The colour `source`'s code holds from `at` to `end`, or undefined when it isn't one that can be worked out. A
 * `.copy(alpha = …)` of any colour takes that colour with the new alpha, which is worked out, so written nowhere. */
export function colorValue(
  source: KotlinSource,
  at: number,
  end: number,
  known: ColorLookup,
): ColorAt | undefined {
  const { code } = source;
  const lead = code.slice(at, end).length - code.slice(at, end).trimStart().length;
  const start = at + lead;
  const base = baseColor(source, start, known);
  if (!base) return undefined;
  const rest = code.slice(base.end, end).trim();
  if (!rest) return { hex: base.hex, ...(base.location && { location: base.location }) };
  const copy = rest.match(/^\.copy\s*\(/);
  if (!copy) return undefined;
  const open = code.indexOf("(", base.end);
  const { args, close } = callArguments(source, open);
  if (code.slice(close + 1, end).trim()) return undefined;
  // Only alpha is read; a copy changing a channel too is worked out as the app runs.
  const [alpha] = args;
  const fraction =
    args.length === 1 && alpha && (!alpha.name || alpha.name === "alpha") ? channel(alpha.value) : undefined;
  return fraction === undefined ? undefined : { hex: rgbToHex(...rgb(base.hex), fraction) };
}

/** Where a name written from `start` to `end` leads: the value it names, with the name first on the way. */
const named = (source: KotlinSource, start: number, end: number, color: ColorAt) =>
  color.location && through(color.location, [spanIn(source, start, end)]);

/** The colour starting at `at` before any `.copy`, and where it ends: a `Color(…)` call, `colorResource(…)`, or a
 * name. */
function baseColor(
  source: KotlinSource,
  at: number,
  known: ColorLookup,
): (ColorAt & { end: number }) | undefined {
  const head = source.code.slice(at, at + MAX_HEAD);
  const call = head.match(/^(Color|colorResource)\s*\(/);
  if (call) {
    const { args, close } = callArguments(source, at + call[0].length - 1);
    const end = close + 1;
    if (call[1] === "Color") {
      const hex = callColor(args);
      return hex ? { hex, location: valueAt(spanIn(source, at, end), "expression"), end } : undefined;
    }
    const color = resourceColor(args, (name) => known(name, source.rel));
    const location = color && named(source, at, end, color);
    return color ? { hex: color.hex, ...(location && { location }), end } : undefined;
  }
  const name = head.match(/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/)?.[0];
  if (!name) return undefined;
  // `Brand.copy(…)`: the name ends before `.copy`.
  const path = name.replace(/\.copy$/, "");
  const end = at + path.length;
  const system = COMPOSE_COLORS[path.match(/^Color\.(\w+)$/)?.[1] ?? ""];
  if (system) return { hex: system, location: valueAt(spanIn(source, at, end), "expression"), end };
  const color = known(path, source.rel);
  const location = color && named(source, at, end, color);
  return color ? { hex: color.hex, ...(location && { location }), end } : undefined;
}

/** Where the expression starting at `at` ends: a name, calls (`Color(…)`), and what's read from them
 * (`.copy(…)`), so whatever follows on the line isn't part of it. */
export function expressionEnd(source: KotlinSource, at: number): number {
  const { code } = source;
  const { closeOf } = treeOf(source);
  let pos = at;
  for (let step = 0; step < MAX_CHAIN; step++) {
    const name = code.slice(pos, pos + MAX_HEAD).match(/^\.?\s*[A-Za-z_][\w.]*/)?.[0];
    if (!name) break;
    pos += name.length;
    const open = pos + (code.slice(pos, pos + MAX_HEAD).match(/^\s*/)?.[0].length ?? 0);
    const close = code[open] === "(" ? closeOf.get(open) : undefined;
    if (close === undefined) break;
    pos = close + 1;
    if (code[pos] !== ".") break;
  }
  return pos;
}

/** How many links of `name(…).name(…)` an expression may have. */
const MAX_CHAIN = 8;

/** How much of an expression's start is read to tell what it is. */
const MAX_HEAD = 200;

function callColor(args: Argument[]): string | undefined {
  const only = args.length === 1 ? args[0] : undefined;
  if (only && (!only.name || only.name === "color")) return argbHex(only.value);
  return channelsColor(args);
}

const resourceColor = (args: Argument[], known: (name: string) => ColorAt | undefined) => {
  const name = args[0]?.value.match(/^R\.color\.(\w+)$/)?.[1];
  return args.length === 1 && name ? known(`R.color.${name}`) : undefined;
};

const CHANNELS = ["red", "green", "blue", "alpha"];

/** `Color(0.2f, 0.4f, 0.9f)` or `Color(red = 51, green = 102, blue = 230, alpha = 255)`. */
function channelsColor(args: Argument[]): string | undefined {
  const values = new Map<string, number | undefined>();
  args.forEach((arg, i) => {
    values.set(arg.name ?? CHANNELS[i] ?? "", channel(arg.value));
  });
  const [r, g, b] = CHANNELS.slice(0, 3).map((k) => values.get(k));
  const a = values.has("alpha") ? values.get("alpha") : 1;
  if (r === undefined || g === undefined || b === undefined || a === undefined) return undefined;
  return rgbToHex(r, g, b, a);
}

const rgb = (hex: string): [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16) / 255,
  Number.parseInt(hex.slice(3, 5), 16) / 255,
  Number.parseInt(hex.slice(5, 7), 16) / 255,
];
