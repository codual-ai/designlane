/** Colours written channel by channel: a call (`Color(red: 0.2, green: 0.4, blue: 0.9)`, `.init(red: 222 / 255, …)`,
 * `srgb(0x23, 0x83, 0xF8)`, `rgba(34, 131, 248, 0.5)`) or an asset catalog's `components`. */

import { alphaOf, type Color, isUpperCase, keepsAlpha } from "./color-value.js";
import {
  type Argument,
  callArguments,
  type Language,
  MAX_VALUE_LENGTH,
  type SpanText,
  spliced,
  type Written,
} from "./notation.js";

/** One channel as written: its value 0–255, and how to write another the same way. */
interface Channel {
  byte: number;
  write: (byte: number) => string;
}

/** A channel's text and where it starts in the span. */
interface Placed {
  text: string;
  start: number;
}

const OVER_255 = /^(\d+)(\.0+)?(\s*\/\s*255(?:\.0*)?[fF]?)$/;
const HEX_BYTE = /^0[xX]([0-9a-fA-F]{1,2})$/;
/** A fraction 0–1 (`0.2`, `1.`), its decimals, with Kotlin's float suffix (`0.2f`, `1f`). */
const FRACTION = /^(?:\d*\.(\d+)|\d+\.|\d+(?=[fF]))[fF]?$/;
const FLOAT_SUFFIX = /[fF]$/;
const INTEGER = /^\d+$/;
/** Three decimals tell every 0–255 channel apart, so a fraction written with none (`red: 1`) gets three. */
const EXACT_DECIMALS = 3;
const CHANNELS = ["red", "green", "blue"] as const;
const ALPHA_LABELS = new Set(["alpha", "opacity"]);
const LABELS = new Set<string>([...CHANNELS, ...ALPHA_LABELS]);
/** The colour space a call may name first, the one tokens.json's values are in. */
const SRGB = ".sRGB";
const ASSET_COMPONENT = /"(red|green|blue|alpha)"\s*:\s*(?:"([^"\n]*)"|([\d.]+))/g;

/** A call with each channel as its own argument. Its opacity is read, so a changed one is caught, and kept as it is. */
export function callChannelReadings({ text, kind, language, fileText }: SpanText): Written<Color>[] {
  if (kind !== "expression" && kind !== "literal") return [];
  const args = callArguments(text);
  const placed = args && channelArguments(args);
  if (!placed) return [];
  const opacity = placed[3] && opacityOf(placed[3].text, language);
  if (placed[3] && opacity === undefined) return [];
  return readings(text, placed.slice(0, 3), language, fileText).map((reading) =>
    opacity === undefined ? reading : { ...reading, value: { ...reading.value, alpha: opacity } },
  );
}

/** A call's opacity 0–255: a fraction 0–1, or in Kotlin a whole number 0–255. */
function opacityOf(text: string, language: Language): number | undefined {
  const isByte = language === "kotlin" && INTEGER.test(text);
  if (!isByte && !FRACTION.test(text) && !INTEGER.test(text)) return undefined;
  const number = Number(text.replace(FLOAT_SUFFIX, ""));
  const byte = isByte ? number : Math.round(number * 255);
  return byte <= 255 ? byte : undefined;
}

/** The red, green and blue arguments, and the opacity after them when there is one: labelled (`red:`, `red =`), or
 * three or four numbers, with an opacity labelled after them (`srgb(0x23, 0x83, 0xF8, opacity: 1)`). */
function channelArguments(args: Argument[]): Placed[] | undefined {
  const rest = args[0]?.value === SRGB && !args[0].label ? args.slice(1) : args;
  const positional = rest.filter((arg) => !arg.label);
  const labels = rest.flatMap((arg) => (arg.label ? [arg.label] : []));
  if (new Set(labels).size !== labels.length) return undefined;
  const placed = (channels: (Argument | undefined)[]) =>
    channels.every((arg) => arg !== undefined)
      ? channels.map(({ value, start }) => ({ text: value, start }))
      : undefined;
  if (positional.length === 0) {
    if (!labels.every((label) => LABELS.has(label))) return undefined;
    const opacity = rest.find((arg) => ALPHA_LABELS.has(arg.label ?? ""));
    const channels = placed(CHANNELS.map((label) => rest.find((arg) => arg.label === label)));
    return channels && opacity ? [...channels, { text: opacity.value, start: opacity.start }] : channels;
  }
  const opacity = rest.filter((arg) => arg.label || positional.indexOf(arg) === 3);
  const isPositional = (positional.length === 3 || positional.length === 4) && opacity.length <= 1;
  return isPositional && labels.every((label) => ALPHA_LABELS.has(label))
    ? placed([...positional.slice(0, 3), ...opacity])
    : undefined;
}

/** An asset catalog's `components`, each channel and the alpha once, written as strings or numbers. */
export function assetReadings({ text, kind, fileText }: SpanText): Written<Color>[] {
  if (kind !== "components" || text.length > MAX_VALUE_LENGTH) return [];
  const found = new Map<string, Placed>();
  for (const match of text.matchAll(ASSET_COMPONENT)) {
    const [whole, name = "", quoted, bare] = match;
    const value = quoted ?? bare ?? "";
    if (found.has(name)) return [];
    found.set(name, { text: value, start: (match.index ?? 0) + whole.lastIndexOf(value) });
  }
  const channels = CHANNELS.map((name) => found.get(name));
  if (!channels.every((channel) => channel !== undefined)) return [];
  const alpha = found.get("alpha");
  return readings(text, alpha ? [...channels, alpha] : channels, "json", fileText);
}

/** `placed`'s channels read as a colour, and `text` with them rewritten for another; a fourth is the alpha. */
function readings(text: string, placed: Placed[], language: Language, fileText: string): Written<Color>[] {
  const decimals = Math.max(
    0,
    ...placed.map(({ text: written }) => FRACTION.exec(written)?.[1]?.length ?? 0),
  );
  const style: Style = {
    language,
    decimals: decimals || EXACT_DECIMALS,
    upper: isUpperCase(placed.map((p) => HEX_BYTE.exec(p.text)?.[1] ?? "").join(""), fileText),
    over: placed.map((p) => OVER_255.exec(p.text)).find((match) => match !== null) ?? undefined,
  };
  const channels = placed.map((p) => channel(p.text, style));
  const [red, green, blue, alpha] = channels;
  if (!red || !green || !blue || channels.some((c) => !c)) return [];
  const value: Color = { red: red.byte, green: green.byte, blue: blue.byte };
  if (alpha) value.alpha = alpha.byte;
  return [
    {
      value,
      write: (to, from) => {
        if (!alpha && !keepsAlpha(from, to)) return undefined;
        const bytes = [to.red, to.green, to.blue, alphaOf(from, to)];
        return spliced(
          text,
          placed.map((p, i) => ({
            start: p.start,
            end: p.start + p.text.length,
            text: channels[i]?.write(bytes[i] ?? 0) ?? p.text,
          })),
        );
      },
    },
  ];
}

/** How a call's channels are written, which a channel shown no other way takes after. */
interface Style {
  language: Language;
  decimals: number;
  /** Whether hex channels are upper case, as the call's own are, or else as the file's. */
  upper: boolean;
  /** A channel written `222 / 255`, which a Swift `0` or `1` beside it is written like. */
  over: RegExpExecArray | undefined;
}

const overWrite = (over: RegExpExecArray) => (byte: number) => `${byte}${over[2] ?? ""}${over[3]}`;

/** A channel in one of the forms code writes: `222 / 255`, `0x23`, a fraction 0–1 (`0.2`, `0.2f`), or a whole number,
 * which is 0–255 except in Swift, where it's the fraction (`red: 1`). */
function channel(text: string, { language, decimals, upper, over: sibling }: Style): Channel | undefined {
  const over = OVER_255.exec(text);
  if (over) return byteChannel(Number(over[1]), overWrite(over));
  const hex = HEX_BYTE.exec(text)?.[1];
  if (hex) {
    const write = (byte: number) => {
      const digits = byte.toString(16).padStart(hex.length, "0");
      return `${text.slice(0, 2)}${upper ? digits.toUpperCase() : digits}`;
    };
    return byteChannel(Number.parseInt(hex, 16), write);
  }
  // CSS's `rgb()` takes 0–255 even with decimals, which this doesn't write.
  if (FRACTION.test(text) && (language === "js" || language === "css")) return undefined;
  if (FRACTION.test(text) || (language === "swift" && INTEGER.test(text))) {
    const suffix = FLOAT_SUFFIX.exec(text)?.[0] ?? "";
    const unit = Number(text.slice(0, text.length - suffix.length));
    if (!(unit <= 1)) return undefined;
    const byte = Math.round(unit * 255);
    if (sibling && INTEGER.test(text)) return { byte, write: overWrite(sibling) };
    return { byte, write: (to) => `${fraction(to, decimals)}${suffix}` };
  }
  return INTEGER.test(text) ? byteChannel(Number(text), String) : undefined;
}

/** `byte` as a fraction 0–1 with `decimals`, or more when that many can't hold it exactly. */
function fraction(byte: number, decimals: number): string {
  const most = Math.max(decimals, EXACT_DECIMALS);
  for (let places = decimals; places < most; places++) {
    const written = (byte / 255).toFixed(places);
    if (Math.round(Number(written) * 255) === byte) return written;
  }
  return (byte / 255).toFixed(most);
}

function byteChannel(byte: number, write: (byte: number) => string): Channel | undefined {
  return byte <= 255 ? { byte, write } : undefined;
}
