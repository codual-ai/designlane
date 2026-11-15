/** What a designer changed in Figma that the code doesn't have: each synced value that moved away from the one Figma
 * and the code last agreed on. Comparing with that value, not only with the code's, is what tells a designer's change
 * from a code change Figma hasn't taken yet. */

import { z } from "zod";
import { EDIT_PROPERTIES, type EditProperty } from "../../src/edit/edit-tokens.js";
import type { DesignFile, DesignFileEntry, VariableValue } from "../../src/sync/plan.js";
import type { Rgba, SyncColor, SyncTokens, TextValue } from "../../src/sync/tokens-file.js";
import { parsedJson } from "./connection.js";
import { type DarkUnavailable, KEYS, NAMESPACE } from "./design-file.js";
import type { FigmaChange } from "./messages.js";

/** A token's values by property, as a code edit takes them: `#rrggbb` or `#rrggbbaa`, a number, a family's name. A
 * colour's `dark` is there only when it differs from its light value. */
type Values = Partial<Record<EditProperty, string>>;
const Values = z.partialRecord(z.enum(EDIT_PROPERTIES), z.string());
const HEX = /^#[0-9a-f]{6}$/;
const OPAQUE = 255;

/** One synced variable or text style, as the code and Figma each have it. */
interface Pair {
  id: string;
  kind: "variable" | "style";
  /** Its name in Figma, after its theme's (`Desert: color/tint`). */
  name: string;
  /** Its key in tokens.json, which a code edit names it by. */
  token: string;
  code: Values;
  figma: Values;
  /** Its collection has no Dark mode, so its dark values aren't compared or agreed on. */
  lightOnly: boolean;
}

/** Every synced variable and text style the code still has, paired with its token. A designer's own entries aren't
 * synced, and a copy a designer made of a synced one is left alone, as a sync leaves it. A collection `withoutDark`,
 * which has no Dark mode, has no dark values to compare. */
export function pairsOf(tokens: SyncTokens, file: DesignFile, withoutDark: DarkUnavailable): Pair[] {
  const groups = [
    {
      label: "",
      lightOnly: withoutDark.main,
      tokens: tokens.colors.map((c) => colorToken(c.key, c, withoutDark.main)),
      entries: file.variables,
    },
    ...(tokens.themes ?? []).map((theme) => ({
      label: `${theme.name}: `,
      lightOnly: withoutDark.themes.has(theme.name),
      tokens: theme.colors.map((c) =>
        colorToken(`${theme.key}/${c.key}`, c, withoutDark.themes.has(theme.name)),
      ),
      entries: file.themes?.find((t) => t.theme === theme.name)?.variables ?? [],
    })),
  ];
  const textStyles = tokens.textStyles.map((s) => ({
    identity: s.identity,
    key: s.key,
    values: textValues(s.value),
  }));
  return [
    ...groups.flatMap(({ label, lightOnly, tokens, entries }) =>
      paired(tokens, entries, variableValues, { kind: "variable", label, lightOnly }),
    ),
    ...paired(textStyles, file.textStyles, textValues, { kind: "style", label: "", lightOnly: false }),
  ];
}

interface Token {
  identity: string;
  key: string;
  values: Values;
}

function paired<V>(
  tokens: Token[],
  entries: DesignFileEntry<V>[],
  valuesOf: (value: V) => Values | undefined,
  { kind, label, lightOnly }: Pick<Pair, "kind" | "lightOnly"> & { label: string },
): Pair[] {
  const synced = syncedByIdentity(entries);
  return tokens.flatMap((token) => {
    const entry = synced.get(token.identity);
    const figma = entry && valuesOf(entry.value);
    if (!entry || !figma) return [];
    const name = label + entry.name;
    return [{ id: entry.id, kind, name, token: token.key, code: token.values, figma, lightOnly }];
  });
}

/** The entries a sync made, by the identity each records; a copy a designer made keeps it too, so the first wins. */
export function syncedByIdentity<V>(entries: DesignFileEntry<V>[]): Map<string, DesignFileEntry<V>> {
  const synced = new Map<string, DesignFileEntry<V>>();
  for (const entry of entries)
    if (entry.identity && !synced.has(entry.identity)) synced.set(entry.identity, entry);
  return synced;
}

/** A change's id, which the designer ticks: the variable or style, and which of its values. */
export const changeIdOf = (entryId: string, property: EditProperty) => `${entryId} ${property}`;

const colorToken = (key: string, color: SyncColor, isLightOnly: boolean): Token => ({
  identity: color.identity,
  key,
  values: colorValues(color.light, isLightOnly ? undefined : color.dark),
});

const hexOf = ({ hex, alpha }: Rgba) => {
  const byte = Math.round(alpha * OPAQUE);
  return byte === OPAQUE ? hex.toLowerCase() : `${hex.toLowerCase()}${byte.toString(16).padStart(2, "0")}`;
};

function colorValues(light: Rgba, dark: Rgba | undefined): Values {
  const lightHex = hexOf(light);
  const darkHex = dark && hexOf(dark);
  return { light: lightHex, ...(darkHex && darkHex !== lightHex ? { dark: darkHex } : {}) };
}

/** A variable's colours, or none for a number or a value Figma can't resolve. */
const variableValues = (value: VariableValue) =>
  typeof value !== "number" && HEX.test(value.light.hex) ? colorValues(value.light, value.dark) : undefined;

const textValues = ({ family, size, weight }: TextValue): Values => ({
  ...(family === undefined ? {} : { family }),
  ...(size === undefined ? {} : { size: String(size) }),
  ...(weight === undefined ? {} : { weight: String(weight) }),
});

/** Each value both sides have, the code's and Figma's. A dark value counts when either side has one of its own; the
 * other's is then its light value. */
function compared({ code, figma }: Pair): { property: EditProperty; inCode: string; inFigma: string }[] {
  return EDIT_PROPERTIES.flatMap((property) => {
    const hasOwnDark = code.dark !== undefined || figma.dark !== undefined;
    const inCode = property === "dark" && hasOwnDark ? (code.dark ?? code.light) : code[property];
    const inFigma = property === "dark" && hasOwnDark ? (figma.dark ?? figma.light) : figma[property];
    return inCode === undefined || inFigma === undefined ? [] : [{ property, inCode, inFigma }];
  });
}

/** The values a designer changed in Figma since it and the code last agreed (`agreed`, by pair id), and the code
 * doesn't have. A rename isn't a change: pairs are matched by identity, never by name. */
export function figmaChanges(pairs: Pair[], agreed: Map<string, Values>): FigmaChange[] {
  return pairs.flatMap((pair) =>
    compared(pair).flatMap(({ property, inCode, inFigma }) => {
      const last = agreed.get(pair.id)?.[property];
      if (last === undefined || inFigma === last || inFigma === inCode) return [];
      const { id, name, token } = pair;
      return [
        {
          id: changeIdOf(id, property),
          name,
          token,
          property,
          from: inCode,
          to: inFigma,
          inCodeToo: inCode !== last,
        },
      ];
    }),
  );
}

/** What each pair's values agree on now, kept beside what they agreed on before for the values that differ now; only
 * the pairs whose record changes. */
function agreements(pairs: Pair[], agreed: Map<string, Values>): Map<Pair, Values> {
  const changed = new Map<Pair, Values>();
  for (const pair of pairs) {
    const before = agreed.get(pair.id) ?? {};
    const now: Values = { ...before };
    for (const { property, inCode, inFigma } of compared(pair))
      if (inCode === inFigma) now[property] = inCode;
    // A colour alike in both modes agrees on its dark value too, so a later change to Dark alone has one to compare.
    // Without a Dark mode there's none to agree on: one added later starts as a copy of Light, not a designer's value.
    const { code, figma } = pair;
    if (
      !pair.lightOnly &&
      code.dark === undefined &&
      figma.dark === undefined &&
      code.light !== undefined &&
      code.light === figma.light
    ) {
      now.dark = code.light;
    }
    if (JSON.stringify(now) !== JSON.stringify(before)) changed.set(pair, now);
  }
  return changed;
}

/** The values each pair's variable or style last agreed on with the code, as recorded on it. */
export async function readAgreed(pairs: Pair[]): Promise<Map<string, Values>> {
  const agreed = new Map<string, Values>();
  for (const pair of pairs) {
    const item = await itemOf(pair);
    const recorded =
      item && Values.safeParse(parsedJson(item.getSharedPluginData(NAMESPACE, KEYS.agreed))).data;
    if (recorded) agreed.set(pair.id, recorded);
  }
  return agreed;
}

/** Records on each pair's variable or style what it and the code agree on now, given what they `agreed` on before.
 * Nothing a designer sees changes. */
export async function recordAgreements(pairs: Pair[], agreed: Map<string, Values>): Promise<void> {
  for (const [pair, values] of agreements(pairs, agreed)) {
    (await itemOf(pair))?.setSharedPluginData(NAMESPACE, KEYS.agreed, JSON.stringify(values));
  }
}

const itemOf = async (pair: Pair): Promise<PluginDataMixin | null> =>
  pair.kind === "variable" ? figma.variables.getVariableByIdAsync(pair.id) : figma.getStyleByIdAsync(pair.id);
