/** The plugin driven as its window drives it, against a fake Figma file, and helpers to look inside that file. */

import type { PlanSummary, ToWindow } from "../../figma-plugin/src/messages.js";
import { createSession } from "../../figma-plugin/src/session.js";
import { type FakeOptions, useFakeFigma } from "./fake-figma.js";

export function plugin(options?: FakeOptions) {
  const fake = useFakeFigma(options);
  const sent: ToWindow[] = [];
  const session = createSession((message) => sent.push(message));
  const last = () => sent[sent.length - 1];
  let picks = 0;
  async function plan(json: string): Promise<PlanSummary> {
    await session({ type: "plan", id: ++picks, json });
    const message = last();
    if (message?.type !== "plan") throw new Error(`expected a plan, got ${JSON.stringify(message)}`);
    return message.summary;
  }
  async function apply(): Promise<string[]> {
    await session({ type: "apply", id: picks });
    const message = last();
    if (message?.type !== "applied") throw new Error(`expected applied, got ${JSON.stringify(message)}`);
    return message.notes;
  }
  async function sync(json: string): Promise<string[]> {
    await plan(json);
    return apply();
  }
  return { fake, sent, last, session, plan, apply, sync };
}

type Fake = ReturnType<typeof useFakeFigma>;

export function variableNamed(fake: Fake, name: string) {
  const found = [...fake.variables.values()].find((variable) => variable.name === name);
  if (!found) throw new Error(`no variable ${name}`);
  return found;
}

export function styleNamed(fake: Fake, name: string) {
  const found = [...fake.styles.values()].find((style) => style.name === name);
  if (!found) throw new Error(`no style ${name}`);
  return found;
}

export function onlyCollection(fake: Fake) {
  const [collection] = fake.collections.values();
  if (!collection) throw new Error("no collection");
  return collection;
}

export function modeNamed(fake: Fake, name: string) {
  const found = onlyCollection(fake).modes.find((mode) => mode.name === name);
  if (!found) throw new Error(`no ${name} mode`);
  return found.modeId;
}

export const rgb = (hex: string) => ({
  r: Number.parseInt(hex.slice(1, 3), 16) / 255,
  g: Number.parseInt(hex.slice(3, 5), 16) / 255,
  b: Number.parseInt(hex.slice(5, 7), 16) / 255,
  a: 1,
});

/** A designer setting a colour variable's Light or Dark value. */
export function recolor(
  fake: Fake,
  name: string,
  mode: "Light" | "Dark",
  hex: string,
  collectionName = "Designmap",
) {
  const collection = [...fake.collections.values()].find((c) => c.name === collectionName);
  const modeId = collection?.modes.find((m) => m.name === mode)?.modeId;
  const variable = collection?.variableIds
    .map((id) => fake.variables.get(id))
    .find((candidate) => candidate?.name === name);
  if (!variable || !modeId) throw new Error(`no ${name} with a ${mode} mode in ${collectionName}`);
  variable.valuesByMode[modeId] = rgb(hex);
}

export interface StyleChange {
  family?: string;
  style?: string;
  size?: number;
}

/** A designer setting a text style's family, style or size. */
export async function restyle(fake: Fake, name: string, change: StyleChange) {
  const style = styleNamed(fake, name);
  if (change.family || change.style) {
    const font = {
      family: change.family ?? style.fontName.family,
      style: change.style ?? style.fontName.style,
    };
    await fake.api.loadFontAsync(font);
    style.fontName = font;
  }
  if (change.size) style.fontSize = change.size;
}
