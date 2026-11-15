/** The code's tokens with the values a designer changed in Figma in place of the code's, so a sync leaves those values
 * as Figma has them and still applies everything else, until the code has them too. */

import { EDIT_PROPERTIES, type EditProperty } from "../../src/edit/edit-tokens.js";
import type { DesignFile, DesignFileEntry, VariableValue } from "../../src/sync/plan.js";
import type { SyncColor, SyncTokens, TextValue } from "../../src/sync/tokens-file.js";
import type { DarkUnavailable } from "./design-file.js";
import { changeIdOf, syncedByIdentity } from "./figma-changes.js";
import type { FigmaChange } from "./messages.js";
import { hasOwnDark } from "./values.js";

type KeptOf = (entryId: string) => ReadonlySet<EditProperty>;

/** `tokens` with each of the `kept` changes' values taken from `file`, the Figma file as it is now; a collection
 * `withoutDark` has no Dark mode to keep a value in. */
export function withFigmaValues(
  tokens: SyncTokens,
  file: DesignFile,
  kept: readonly FigmaChange[],
  withoutDark: DarkUnavailable,
): SyncTokens {
  const ids = new Set(kept.map((change) => change.id));
  const keptOf: KeptOf = (entryId) =>
    new Set(EDIT_PROPERTIES.filter((property) => ids.has(changeIdOf(entryId, property))));
  return {
    ...tokens,
    colors: keptColors(tokens.colors, file.variables, keptOf, withoutDark.main),
    textStyles: keptTextStyles(tokens.textStyles, file.textStyles, keptOf),
    ...(tokens.themes
      ? {
          themes: tokens.themes.map((theme) => {
            const entries = file.themes?.find((inFile) => inFile.theme === theme.name)?.variables ?? [];
            const lightOnly = withoutDark.themes.has(theme.name);
            return { ...theme, colors: keptColors(theme.colors, entries, keptOf, lightOnly) };
          }),
        }
      : {}),
  };
}

function keptColors(
  colors: SyncColor[],
  entries: DesignFileEntry<VariableValue>[],
  keptOf: KeptOf,
  lightOnly: boolean,
): SyncColor[] {
  const synced = syncedByIdentity(entries);
  return colors.map((color) => {
    const entry = synced.get(color.identity);
    const kept = entry ? keptOf(entry.id) : new Set();
    if (!entry || kept.size === 0 || typeof entry.value === "number") return color;
    const inFigma = entry.value;
    const light = kept.has("light") ? inFigma.light : color.light;
    const dark = kept.has("dark") ? (inFigma.dark ?? inFigma.light) : codeDark(color, lightOnly);
    const { dark: _, ...rest } = color;
    return dark && hasOwnDark(light, dark) ? { ...rest, light, dark } : { ...rest, light };
  });
}

/** The code's dark value, which a colour alike in both modes has in its Light one, unless its collection has no Dark
 * mode, where only a dark value of the code's own would add one. */
const codeDark = (color: SyncColor, lightOnly: boolean) =>
  lightOnly ? color.dark : (color.dark ?? color.light);

function keptTextStyles(
  styles: SyncTokens["textStyles"],
  entries: DesignFileEntry<Required<TextValue>>[],
  keptOf: KeptOf,
): SyncTokens["textStyles"] {
  const synced = syncedByIdentity(entries);
  return styles.map((style) => {
    const entry = synced.get(style.identity);
    const kept = entry ? keptOf(entry.id) : new Set();
    if (!entry || kept.size === 0) return style;
    const inFigma = entry.value;
    const value: TextValue = {
      ...style.value,
      ...(kept.has("family") ? { family: inFigma.family } : {}),
      ...(kept.has("size") ? { size: inFigma.size } : {}),
      ...(kept.has("weight") ? { weight: inFigma.weight } : {}),
    };
    return { ...style, value };
  });
}

/** A change the designer may set back to the code's value: any not in a pull request already. */
export const mayKeepCode = (change: FigmaChange) => change.pullRequest === undefined;

/** The changes Apply keeps as Figma has them: all but those the designer chose the code's value for (`keepCode`). */
export const keptChanges = (changes: readonly FigmaChange[], keepCode: readonly string[]) =>
  changes.filter((change) => !(mayKeepCode(change) && keepCode.includes(change.id)));
