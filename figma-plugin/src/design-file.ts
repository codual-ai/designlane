/** What a Figma file holds and the marks a sync leaves on it: its collection and modes, variables, text styles and
 * fonts. */

import type { DesignFile, DesignFileEntry, DesignFileTheme, VariableValue } from "../../src/sync/plan.js";
import type { TextValue } from "../../src/sync/tokens-file.js";
import { fromFigmaColor, hasOwnDark, weightOfStyle } from "./values.js";

/** Where the plugin keeps its own data on variables, styles and its collection; shared, so other tools can read it. */
export const NAMESPACE = "designmap";
/** The plugin data keys a sync writes and reads back, under `NAMESPACE`. */
export const KEYS = {
  /** On the collection a sync made, set to `SYNCED_COLLECTION`, or `THEME_COLLECTION` for one of a theme. */
  collection: "collection",
  /** On a theme's collection, the theme's name. */
  theme: "theme",
  lightMode: "lightMode",
  darkMode: "darkMode",
  darkUnavailable: "darkUnavailable",
  identity: "identity",
  /** On a synced variable or text style, the values it and the code last had alike, which tells a designer's change
   * from the code's. */
  agreed: "agreed",
  deprecated: "deprecated",
  descriptionBefore: "descriptionBefore",
  hiddenBefore: "hiddenBefore",
  /** On the page Designmap draws the design system on, and on the frame it draws there. */
  page: "page",
  sheet: "sheet",
} as const;
export const SYNCED_COLLECTION = "tokens";
export const THEME_COLLECTION = "theme";

/** The app's name as a title, `Shop`; a name already capitalized, like `ShopKit`, is kept. */
export const appTitle = (app: string) => `${app.charAt(0).toUpperCase()}${app.slice(1)}`;

/** What Designmap names what it makes for an app: "Shop (Designmap)". */
export const designmapName = (app: string | undefined) =>
  app ? `${appTitle(app)} (Designmap)` : "Designmap";
/** What Designmap names the collection of one of an app's other themes: "Shop · Desert (Designmap)". */
export const themeCollectionName = (app: string | undefined, theme: string) =>
  designmapName(app ? `${appTitle(app)} · ${theme}` : theme);

/** How many variables deep a value pointing at another variable is followed before it's taken as unreadable. */
const MAX_ALIAS_DEPTH = 10;

export const identityOf = (item: PluginDataMixin) =>
  item.getSharedPluginData(NAMESPACE, KEYS.identity) || undefined;
export const isDeprecated = (item: PluginDataMixin) =>
  item.getSharedPluginData(NAMESPACE, KEYS.deprecated) === "true";

/** The collection a sync made, found by the mark it left rather than its name, which a designer may change. */
export async function syncedCollection(): Promise<VariableCollection | undefined> {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  return collections.find(
    (collection) => collection.getSharedPluginData(NAMESPACE, KEYS.collection) === SYNCED_COLLECTION,
  );
}

/** The collection a sync made for each of the app's other themes, by the theme's name; the first, if a designer
 * duplicated one. */
export async function themeCollections(): Promise<Map<string, VariableCollection>> {
  const found = new Map<string, VariableCollection>();
  for (const collection of await figma.variables.getLocalVariableCollectionsAsync()) {
    if (collection.getSharedPluginData(NAMESPACE, KEYS.collection) !== THEME_COLLECTION) continue;
    const theme = collection.getSharedPluginData(NAMESPACE, KEYS.theme);
    if (!found.has(theme)) found.set(theme, collection);
  }
  return found;
}

export type SyncModes = { light?: string; dark?: string };

/** The modes a sync writes to, as recorded when it made them, so a designer's own modes are never written over.
 * One a designer deleted is missing. */
export function syncModes(collection: VariableCollection): SyncModes {
  const recorded = (key: string) => {
    const id = collection.getSharedPluginData(NAMESPACE, key);
    return collection.modes.some((mode) => mode.modeId === id) ? id : undefined;
  };
  const light = recorded(KEYS.lightMode);
  const dark = recorded(KEYS.darkMode);
  return { ...(light ? { light } : {}), ...(dark ? { dark } : {}) };
}

/** The collections a sync found couldn't take a Dark mode (Figma plans limit modes): the default theme's, and the
 * other themes' by name. */
export interface DarkUnavailable {
  main: boolean;
  themes: Set<string>;
}

/** Which collections couldn't take a Dark mode, so the code's dark values for them are left out until one can be
 * added. */
export async function darkUnavailable(): Promise<DarkUnavailable> {
  const full = (collection: VariableCollection | undefined) =>
    collection?.getSharedPluginData(NAMESPACE, KEYS.darkUnavailable) === "true";
  const themes = [...(await themeCollections())].filter(([, collection]) => full(collection));
  return { main: full(await syncedCollection()), themes: new Set(themes.map(([theme]) => theme)) };
}

/** Each text style's font, by the style's id. */
export async function textStyleFonts(): Promise<Map<string, FontName>> {
  return new Map((await figma.getLocalTextStylesAsync()).map((style) => [style.id, style.fontName]));
}

/** The styles of each font family this file can use. */
export async function availableFontStyles(): Promise<Map<string, string[]>> {
  const styles = new Map<string, string[]>();
  for (const { fontName } of await figma.listAvailableFontsAsync()) {
    styles.set(fontName.family, [...(styles.get(fontName.family) ?? []), fontName.style]);
  }
  return styles;
}

/** The file's entries as the sync plan compares them. */
export async function readDesignFile(): Promise<DesignFile> {
  const collection = await syncedCollection();
  const variables = collection ? await variablesOf(collection) : [];
  const themes: DesignFileTheme[] = [];
  for (const [theme, themeCollection] of await themeCollections()) {
    themes.push({ theme, variables: await variablesOf(themeCollection) });
  }
  const textStyles: DesignFileEntry<Required<TextValue>>[] = (await figma.getLocalTextStylesAsync()).map(
    (style) => ({
      ...entryOf(style),
      value: {
        family: style.fontName.family,
        size: style.fontSize,
        weight: weightOfStyle(style.fontName.style),
      },
    }),
  );
  return { variables, textStyles, themes };
}

async function variablesOf(collection: VariableCollection): Promise<DesignFileEntry<VariableValue>[]> {
  const modes = syncModes(collection);
  const variables: DesignFileEntry<VariableValue>[] = [];
  for (const id of collection.variableIds) {
    const variable = await figma.variables.getVariableByIdAsync(id);
    if (variable) variables.push({ ...entryOf(variable), value: await syncedValue(variable, modes) });
  }
  return variables;
}

function entryOf(item: { id: string; name: string } & PluginDataMixin) {
  const identity = identityOf(item);
  return { id: item.id, name: item.name, ...(identity ? { identity } : {}), deprecated: isDeprecated(item) };
}

/** A value the file holds that can't be read (a link to a variable that's gone, a loop, or a Designmap mode a
 * designer deleted): never equal to the code's, so a sync writes the code's value over it rather than losing it. */
const UNREADABLE = { color: { light: { hex: "", alpha: Number.NaN } }, number: Number.NaN };

/** A variable's value as the sync compares it: a colour in light (and dark) mode, or a number, the same in both. */
export async function syncedValue(variable: Variable, modes: SyncModes): Promise<VariableValue> {
  const isNumber = variable.resolvedType === "FLOAT";
  const light = modes.light ? await resolve(variable, modes.light) : undefined;
  const dark = modes.dark ? await resolve(variable, modes.dark) : undefined;
  if (isNumber)
    return typeof light === "number" && (!modes.dark || dark === light) ? light : UNREADABLE.number;
  if (!isColor(light) || (modes.dark && !isColor(dark))) return UNREADABLE.color;
  const lightColor = fromFigmaColor(light);
  const darkColor = isColor(dark) ? fromFigmaColor(dark) : undefined;
  return darkColor && hasOwnDark(lightColor, darkColor)
    ? { light: lightColor, dark: darkColor }
    : { light: lightColor };
}

/** The value a variable holds in `modeId`, following links to other variables: within one collection in the same mode,
 * into another collection in that collection's default mode (a page can pick another mode there, which a sync can't
 * see). */
async function resolve(variable: Variable, modeId: string): Promise<unknown> {
  let current = variable;
  let mode = modeId;
  for (let depth = 0; depth < MAX_ALIAS_DEPTH; depth++) {
    const value = current.valuesByMode[mode];
    if (!isAlias(value)) return value;
    const target = await figma.variables.getVariableByIdAsync(value.id);
    if (!target) return undefined;
    if (target.variableCollectionId !== current.variableCollectionId) {
      const collection = await figma.variables.getVariableCollectionByIdAsync(target.variableCollectionId);
      if (!collection) return undefined;
      mode = collection.defaultModeId;
    }
    current = target;
  }
  return undefined;
}

const isAlias = (value: unknown): value is VariableAlias =>
  typeof value === "object" && value !== null && "type" in value && value.type === "VARIABLE_ALIAS";

const isColor = (value: unknown): value is RGBA =>
  typeof value === "object" && value !== null && "r" in value && "g" in value && "b" in value;
