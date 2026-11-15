/** The code's tokens fitted to what this Figma file can hold: no dark values where a collection has no room for a Dark
 * mode, and no text styles whose font the file doesn't have. */

import type { SyncPlan } from "../../src/sync/plan.js";
import type { SyncColor, SyncTokens } from "../../src/sync/tokens-file.js";
import { availableFontStyles, type DarkUnavailable, textStyleFonts } from "./design-file.js";
import { describeFont, type FontValue, fontFor, hasOwnDark } from "./values.js";

/** A text style left out of a sync, and the font this file doesn't have for it. */
export interface MissingFont {
  name: string;
  font: string;
}

const lightOnly = ({ dark: _, ...color }: SyncColor): SyncColor => color;
const hasDarkValues = (colors: SyncColor[]) => colors.some((color) => hasOwnDark(color.light, color.dark));

/** The collections whose dark values are left out: those that couldn't take a Dark mode and have dark values to
 * write, each on its own, so one theme's full collection doesn't take the others' dark values. */
export function darkLeftOutOf(tokens: SyncTokens, full: DarkUnavailable): DarkUnavailable {
  const themes = (tokens.themes ?? []).filter((t) => full.themes.has(t.name) && hasDarkValues(t.colors));
  return { main: full.main && hasDarkValues(tokens.colors), themes: new Set(themes.map((t) => t.name)) };
}

/** The code's tokens as a file holds them: no dark values in a collection that can't have a Dark mode, so they
 * don't show as changed on every sync, and elsewhere a dark value only where it differs from the light one. */
export function withDarkWhereRoom(tokens: SyncTokens, leftOut: DarkUnavailable): SyncTokens {
  const own = (color: SyncColor) => (hasOwnDark(color.light, color.dark) ? color : lightOnly(color));
  const change = (isLeftOut: boolean) => (isLeftOut ? lightOnly : own);
  return {
    ...tokens,
    colors: tokens.colors.map(change(leftOut.main)),
    ...(tokens.themes
      ? {
          themes: tokens.themes.map((theme) => ({
            ...theme,
            colors: theme.colors.map(change(leftOut.themes.has(theme.name))),
          })),
        }
      : {}),
  };
}

/** The plan without the text styles whose font this file doesn't have, which no sync could make, so they'd otherwise
 * show as new or changed every time; and their names, with the font they need. */
export async function withoutMissingFonts(
  plan: SyncPlan,
): Promise<{ plan: SyncPlan; missingFonts: MissingFont[] }> {
  const fontStyles = await availableFontStyles();
  const currentFonts = await textStyleFonts();
  const fontOfNew = (entry: { value: FontValue }) => ({ value: entry.value, current: undefined });
  const fontOfExisting = (entry: { id: string; token: { value: FontValue } }) => ({
    value: entry.token.value,
    current: currentFonts.get(entry.id),
  });
  const { textStyles } = plan;
  const create = splitByFont(textStyles.create, fontOfNew, fontStyles);
  const update = splitByFont(textStyles.update, fontOfExisting, fontStyles);
  const rename = splitByFont(textStyles.rename, fontOfExisting, fontStyles);
  return {
    plan: {
      ...plan,
      textStyles: { ...textStyles, create: create.kept, update: update.kept, rename: rename.kept },
    },
    missingFonts: [...create.missing, ...update.missing, ...rename.missing],
  };
}

/** `entries` split into those whose font this file has, and the rest with the font they need. */
function splitByFont<T extends { name: string }>(
  entries: T[],
  fontOf: (entry: T) => { value: FontValue; current: FontName | undefined },
  fontStyles: Map<string, string[]>,
): { kept: T[]; missing: MissingFont[] } {
  const kept: T[] = [];
  const missing: MissingFont[] = [];
  for (const entry of entries) {
    const { value, current } = fontOf(entry);
    const { family, style } = fontFor(value, current, fontStyles);
    if (style) kept.push(entry);
    else missing.push({ name: entry.name, font: describeFont(family, value.weight) });
  }
  return { kept, missing };
}
