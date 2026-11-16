/** The page that shows the app's design system as a designer sees it: colour swatches linked to their variables, a
 * sample of each text style, and the spacing and radius scales a file written before Designlane left them to DESIGN.md
 * holds. Redrawn on every apply; only its own frame changes, so what a designer adds to the page stays. */

import type { VariableValue } from "../../src/sync/plan.js";
import {
  appTitle,
  designlaneName,
  identityOf,
  isDeprecated,
  KEYS,
  NAMESPACE,
  syncedCollection,
  syncedValue,
  syncModes,
} from "./design-file.js";

const LABEL_FONT = { family: "Inter", style: "Regular" };
const HEADING_FONT = { family: "Inter", style: "Bold" };
const SAMPLE = "The quick brown fox jumps over the lazy dog";
/** How wide a section runs before its items wrap onto another row. */
const SECTION_WIDTH = 1200;
const SWATCH = 96;
const PADDING = 64;
const GREY = { r: 0.6, g: 0.6, b: 0.6 };
const WHITE = { r: 1, g: 1, b: 1 };

/** A synced variable with its value as the sync reads it, links to other variables followed. */
interface Token {
  variable: Variable;
  value: VariableValue;
}

/** Draws the design system on its page, made on the first apply and named after the app. Every node joins the sheet as
 * it's made; if drawing fails, the new sheet goes, and so does the page when this apply made it, leaving the file as
 * it was. */
export async function drawDesignSystemPage(app: string | undefined): Promise<void> {
  const { page, isNew } = await designSystemPage(app);
  let sheet: FrameNode | undefined;
  try {
    await page.loadAsync();
    await Promise.all([figma.loadFontAsync(LABEL_FONT), figma.loadFontAsync(HEADING_FONT)]);
    sheet = stack(page, "VERTICAL", PADDING);
    await fill(sheet, app);
    replaceLastSheet(page, sheet);
  } catch (error) {
    sheet?.remove();
    if (isNew) page.remove();
    throw error;
  }
}

async function fill(sheet: FrameNode, app: string | undefined): Promise<void> {
  sheet.name = designlaneName(app);
  sheet.fills = [{ type: "SOLID", color: WHITE }];
  sheet.setSharedPluginData(NAMESPACE, KEYS.sheet, "true");
  sheet.paddingTop = sheet.paddingRight = sheet.paddingBottom = sheet.paddingLeft = PADDING;
  header(sheet, app);
  const collection = await syncedCollection();
  if (collection) {
    const tokens = await syncedTokens(collection);
    colours(sheet, collection, tokens);
    scale(sheet, "Spacing", numbers(tokens, "spacing:"), spacingSquare);
    scale(sheet, "Radius", numbers(tokens, "radius:"), radiusBox);
  }
  await typography(sheet);
}

/** The page a sync drew on, found by its mark rather than its name, which a designer may change; or a new one. */
async function designSystemPage(app: string | undefined): Promise<{ page: PageNode; isNew: boolean }> {
  const marked = figma.root.children.find(
    (page) => page.getSharedPluginData(NAMESPACE, KEYS.page) === "true",
  );
  if (marked) return { page: marked, isNew: false };
  const page = figma.createPage();
  page.name = designlaneName(app);
  page.setSharedPluginData(NAMESPACE, KEYS.page, "true");
  return { page, isNew: true };
}

/** Puts `sheet` where the last one was, in the same section or frame and position, placed freely there too if it was,
 * since a designer may have moved it; the last one goes. */
function replaceLastSheet(page: PageNode, sheet: FrameNode): void {
  const last = page
    .findAllWithCriteria({ sharedPluginData: { namespace: NAMESPACE, keys: [KEYS.sheet] } })
    .find((node) => node !== sheet);
  if (!last?.parent) return;
  last.parent.insertChild(last.parent.children.indexOf(last), sheet);
  if ("layoutPositioning" in last) sheet.layoutPositioning = last.layoutPositioning;
  sheet.x = last.x;
  sheet.y = last.y;
  last.remove();
}

/** The variables a sync made and the code still has, with their values. */
async function syncedTokens(collection: VariableCollection): Promise<Token[]> {
  const modes = syncModes(collection);
  const variables = await Promise.all(
    collection.variableIds.map((id) => figma.variables.getVariableByIdAsync(id)),
  );
  const synced = variables.filter(
    (v): v is Variable => v !== null && identityOf(v) !== undefined && !isDeprecated(v),
  );
  return Promise.all(
    synced.map(async (variable) => ({ variable, value: await syncedValue(variable, modes) })),
  );
}

function header(parent: FrameNode, app: string | undefined): void {
  const block = stack(parent, "VERTICAL", 8);
  text(block, app ? appTitle(app) : "Design system", 48, HEADING_FONT);
  text(block, `Design system, synced from the code by Designlane on ${today()}`, 16);
}

/** The designer's local date, `2026-11-10`. */
function today(): string {
  const now = new Date();
  const twoDigits = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${twoDigits(now.getMonth() + 1)}-${twoDigits(now.getDate())}`;
}

/** A swatch for each colour, linked to its variable: in Light, and in Dark beside it when the colour looks different
 * there. A colour that can't be read is left out. */
function colours(parent: FrameNode, collection: VariableCollection, tokens: Token[]): void {
  const { light, dark } = syncModes(collection);
  const readable = tokens.flatMap(({ variable, value }) =>
    typeof value !== "number" && Number.isFinite(value.light.alpha) ? [{ variable, value }] : [],
  );
  if (readable.length === 0) return;
  const grid = wrappingGrid(section(parent, "Colours"), 24, 32);
  for (const { variable, value } of readable) {
    const card = stack(grid, "VERTICAL", 6);
    const chips = stack(card, "HORIZONTAL", 0);
    if (light) chip(chips, variable, collection, light);
    if (dark && value.dark) chip(chips, variable, collection, dark);
    text(card, variable.name, 13, HEADING_FONT);
    const reference = variable.codeSyntax.iOS ?? variable.codeSyntax.ANDROID;
    if (reference) text(card, reference, 12);
    text(card, [value.light.hex, value.dark?.hex].filter(Boolean).join(" / "), 12);
  }
}

/** A square filled with `variable` as it is in `modeId`, so it follows the variable when it changes. */
function chip(parent: FrameNode, variable: Variable, collection: VariableCollection, modeId: string): void {
  const frame = figma.createFrame();
  parent.appendChild(frame);
  frame.resize(SWATCH, SWATCH);
  frame.setExplicitVariableModeForCollection(collection, modeId);
  const paint = figma.variables.setBoundVariableForPaint({ type: "SOLID", color: WHITE }, "color", variable);
  frame.fills = [paint];
}

/** The number variables of one kind that can be read, smallest first. */
function numbers(tokens: Token[], kind: string): { name: string; value: number }[] {
  return tokens
    .flatMap(({ variable, value }) =>
      identityOf(variable)?.startsWith(kind) && typeof value === "number" && Number.isFinite(value)
        ? [{ name: variable.name, value }]
        : [],
    )
    .sort((a, b) => a.value - b.value);
}

/** One shape per value, each named under it, in a grid that wraps. */
function scale(
  parent: FrameNode,
  title: string,
  entries: { name: string; value: number }[],
  shape: (parent: FrameNode, value: number) => void,
): void {
  if (entries.length === 0) return;
  const grid = wrappingGrid(section(parent, title), 32, 24);
  grid.counterAxisAlignItems = "MAX";
  for (const { name, value } of entries) {
    const item = stack(grid, "VERTICAL", 8);
    shape(item, value);
    text(item, name, 12);
  }
}

/** A square as wide as the spacing it shows. */
function spacingSquare(parent: FrameNode, value: number): void {
  const square = figma.createRectangle();
  parent.appendChild(square);
  square.resize(Math.max(value, 1), Math.max(value, 1));
  square.fills = [{ type: "SOLID", color: GREY }];
}

/** A box with the corner radius it shows. */
function radiusBox(parent: FrameNode, value: number): void {
  const box = figma.createRectangle();
  parent.appendChild(box);
  box.resize(64, 64);
  box.cornerRadius = value;
  box.fills = [{ type: "SOLID", color: GREY }];
}

/** A sample of each text style a sync made, largest first, set in that style, with its name and font. */
async function typography(parent: FrameNode): Promise<void> {
  const synced = (await figma.getLocalTextStylesAsync()).filter(
    (style) => identityOf(style) !== undefined && !isDeprecated(style),
  );
  if (synced.length === 0) return;
  const rows = stack(section(parent, "Typography"), "VERTICAL", 20);
  for (const style of synced.sort((a, b) => b.fontSize - a.fontSize)) {
    const { family, style: weight } = style.fontName;
    const row = stack(rows, "VERTICAL", 4);
    text(row, `${style.name}  ${family} ${weight} ${style.fontSize}`, 12);
    await sampleOf(style, row);
  }
}

/** A line set in `style`, added to `row`; or, when this file can't load its font, a note saying so. */
async function sampleOf(style: TextStyle, row: FrameNode): Promise<void> {
  try {
    await figma.loadFontAsync(style.fontName);
  } catch {
    text(row, "This file doesn't have the font to show a sample.", 12);
    return;
  }
  await text(row, SAMPLE, 16).setTextStyleIdAsync(style.id);
}

/** A titled block in `parent`, returning the block its content goes in. */
function section(parent: FrameNode, title: string): FrameNode {
  const block = stack(parent, "VERTICAL", 24);
  text(block, title, 24, HEADING_FONT);
  return block;
}

/** A row as wide as a section, whose items wrap onto further rows and whose height grows with them. */
function wrappingGrid(parent: FrameNode, gap: number, rowGap: number): FrameNode {
  const grid = stack(parent, "HORIZONTAL", gap);
  grid.layoutWrap = "WRAP";
  grid.counterAxisSpacing = rowGap;
  // Resizing fixes both sizes; the width stays fixed so items wrap, and the height goes back to growing with them.
  grid.resize(SECTION_WIDTH, grid.height);
  grid.primaryAxisSizingMode = "FIXED";
  grid.counterAxisSizingMode = "AUTO";
  return grid;
}

/** A frame in `parent` that lays out its children in a row or column and grows to fit them. */
function stack(
  parent: BaseNode & ChildrenMixin,
  direction: "HORIZONTAL" | "VERTICAL",
  gap: number,
): FrameNode {
  const frame = figma.createFrame();
  parent.appendChild(frame);
  frame.layoutMode = direction;
  frame.itemSpacing = gap;
  frame.primaryAxisSizingMode = "AUTO";
  frame.counterAxisSizingMode = "AUTO";
  frame.clipsContent = false;
  frame.fills = [];
  return frame;
}

function text(parent: FrameNode, characters: string, size: number, font: FontName = LABEL_FONT): TextNode {
  const node = figma.createText();
  parent.appendChild(node);
  node.fontName = font;
  node.characters = characters;
  node.fontSize = size;
  return node;
}
