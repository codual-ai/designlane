/**
 * Reads a tokens.json that Designlane wrote into the tokens a sync works with. Each token's identity is how the code
 * refers to it (`Theme.surface`, `WMFSpacing.large`), so a sync finds it again whatever it's called in the design file.
 * Designlane writes only what the code names; a file written before it did may hold values known by the value itself
 * (an inline `#ff0000`, a spacing of 8), which sync as before until the next run drops them.
 */

import { z } from "zod";
import {
  type ColorTokenEntry,
  type ColorValue,
  parseTokensFile,
  type ScaleTokenEntry,
  type TextStyleGroup,
} from "../output/tokens-schema.js";
import type { Platform } from "../scan/types.js";

/** A colour as `#rrggbb` with opacity 0–1. */
export interface Rgba {
  hex: string;
  alpha: number;
}

export interface SyncColor {
  /** What a sync recognises it by from one run to the next. */
  identity: string;
  key: string;
  light: Rgba;
  dark?: Rgba;
  reference?: string;
}

/** One of the app's themes beside its default one, known by its name. */
export interface SyncTheme {
  name: string;
  /** Its key in tokens.json, which a code edit names its colours by (`<key>/<colour key>`). */
  key: string;
  colors: SyncColor[];
}

/** A text style's values as the code sets them: what it computes is left out. */
export interface TextValue {
  family?: string;
  size?: number;
  weight?: number;
}

export interface SyncTextStyle {
  identity: string;
  key: string;
  value: TextValue;
  reference?: string;
}

/** A spacing or radius: a step of a scale the code names, or in a file from before scales were named, a bare value. */
export interface SyncDimension {
  identity: string;
  key: string;
  value: number;
  reference?: string;
}

/** Every token the app's code uses. */
export interface SyncTokens {
  /** The default theme's colours. */
  colors: SyncColor[];
  /** The app's other themes, when it has some; a theme's colours are matched only within it. */
  themes?: SyncTheme[];
  textStyles: SyncTextStyle[];
  spacing: SyncDimension[];
  radii: SyncDimension[];
  /** The scan read the whole app, so a token missing here is one the code dropped. */
  complete: boolean;
  /** The app's name, when the file records it. */
  app?: string;
  /** The platform the app's code is for; files from before it was recorded are iOS. */
  platform?: Platform;
}

/** The tokens in `json`, or an error saying what's wrong and what to do. */
export function readTokensFile(json: unknown): SyncTokens {
  const file = parseTokensFile(json);
  if (!file.success) {
    throw new Error(
      `This isn't a tokens.json Designlane writes. Run designlane on the app again. ${z.prettifyError(file.error)}`,
    );
  }
  const colors = tokensIn(file.data.color).map(([key, token]) => syncColor(key, token));
  const textStyles = tokensIn(file.data.typography).map(([key, style]) => ({
    token: syncTextStyle(key, style),
  }));
  // A theme with no colours holds nothing to sync, and mustn't make an empty file look full.
  const themes = tokensIn(file.data.theme)
    .map(([key, theme]) => ({
      name: theme.$extensions.designlane.name,
      key,
      colors: distinct(tokensIn(theme.color).map(([key, token]) => syncColor(key, token))),
    }))
    .filter((theme) => theme.colors.length > 0);
  const spacing = tokensIn(file.data.spacing).map(([key, token]) => syncDimension("spacing", key, token));
  const radii = tokensIn(file.data.radius).map(([key, token]) => syncDimension("radius", key, token));
  const app = file.data.$extensions?.designlane.app;
  const complete = file.data.$extensions?.designlane.partial !== true;
  // An app whose code names nothing is a sync like any other, but a file that only looks empty would deprecate
  // everything: one Designlane didn't write, or a scan that didn't read the whole app.
  if (
    !colors.length &&
    !themes.length &&
    !textStyles.length &&
    !spacing.length &&
    !radii.length &&
    (!app || !complete)
  ) {
    throw new Error("This tokens.json has no tokens. Run designlane on the app again before syncing.");
  }
  return {
    colors: distinct(colors),
    ...(themes.length > 0 ? { themes } : {}),
    textStyles: distinct(textStyles),
    spacing,
    radii,
    complete,
    ...(app ? { app } : {}),
    ...(file.data.$extensions?.designlane.platform
      ? { platform: file.data.$extensions.designlane.platform }
      : {}),
  };
}

/** A scale's step is known by how the code refers to it, which is one in the whole app; a bare value by itself. */
function syncDimension(
  kind: "spacing" | "radius",
  key: string,
  token: z.output<typeof ScaleTokenEntry>,
): SyncDimension {
  const value = token.$value.value;
  const reference = token.$extensions?.designlane.reference;
  return {
    identity: `${kind}:${reference ?? value}`,
    key,
    value,
    ...(reference ? { reference } : {}),
  };
}

/** A group's tokens with their keys, without its `$description`. */
function tokensIn<T>(group: Record<string, string | T> | undefined): [string, T][] {
  return Object.entries(group ?? {}).flatMap(([key, value]) =>
    typeof value === "string" ? [] : [[key, value]],
  );
}

const rgba = (value: z.output<typeof ColorValue>): Rgba => ({
  hex: value.hex.toLowerCase(),
  alpha: value.alpha ?? 1,
});

/**
 * A colour's identity. A type's member (`Theme.surface`) or an asset (`Color("Brand")`) is one in the whole app; a
 * plain constant (`accent`) may be private to its file, so its file is part of its identity whether or not another
 * file has one too. A colour with no name is known by its value.
 */
function colorIdentity(reference: string | undefined, source: string, value: Rgba): string {
  if (!reference) return `color:${value.hex}${value.alpha === 1 ? "" : `/${value.alpha}`}`;
  return `color:${/[.(]/.test(reference) ? reference : `${reference}@${source}`}`;
}

/** A colour, and the line it's declared on, which orders same-named colours in one file. */
function syncColor(
  key: string,
  token: z.output<typeof ColorTokenEntry>,
): { token: SyncColor; line?: number } {
  const { reference, source, line, modes } = token.$extensions.designlane;
  const light = rgba(token.$value);
  return {
    token: {
      identity: colorIdentity(reference, source, light),
      key,
      light,
      ...(modes ? { dark: rgba(modes.dark) } : {}),
      ...(reference ? { reference } : {}),
    },
    ...(line ? { line } : {}),
  };
}

/** A text style is known by its name in the code (`heading`, `brand 20 bold` for a helper called with a size, or a
 * description like `System 15 semibold`) and the font helper it comes from, which is one in the whole app. */
function syncTextStyle(key: string, style: z.output<typeof TextStyleGroup>): SyncTextStyle {
  const { reference, name } = style.$extensions.designlane;
  return {
    identity: `type:${reference ? `${reference}|${name}` : name}`,
    key,
    value: {
      ...(style.fontFamily ? { family: style.fontFamily.$value } : {}),
      ...(style.fontSize ? { size: style.fontSize.$value.value } : {}),
      ...(style.fontWeight ? { weight: style.fontWeight.$value } : {}),
    },
    ...(reference ? { reference } : {}),
  };
}

/** Tokens whose identities still clash (two `let accent`s in one file) told apart in the order they're declared,
 * which a change of value doesn't move. */
function distinct<T extends { identity: string; key: string }>(entries: { token: T; line?: number }[]): T[] {
  const byIdentity = new Map<string, { token: T; line?: number }[]>();
  for (const entry of entries) {
    const same = byIdentity.get(entry.token.identity) ?? [];
    byIdentity.set(entry.token.identity, same);
    same.push(entry);
  }
  const renamed = new Map<T, string>();
  for (const [identity, same] of byIdentity) {
    if (same.length < 2) continue;
    const declared = [...same].sort(
      (a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.token.key < b.token.key ? -1 : 1),
    );
    for (const [i, { token }] of declared.entries())
      renamed.set(token, i === 0 ? identity : `${identity}#${i + 1}`);
  }
  return entries.map(({ token }) => {
    const identity = renamed.get(token);
    return identity ? { ...token, identity } : token;
  });
}
