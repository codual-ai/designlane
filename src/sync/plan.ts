/**
 * What a sync changes in a design file: tokens read from the code, matched to what the file already has by the
 * identity each records, never by name, so a designer can rename anything and the next sync still finds it.
 */

import { numberLabel } from "../output/token-names.js";
import type { Rgba, SyncColor, SyncDimension, SyncTheme, SyncTokens, TextValue } from "./tokens-file.js";

/** A value a variable holds: a colour (light, and dark when it has one) or a number. */
export type VariableValue = { light: Rgba; dark?: Rgba } | number;

/** A variable or text style the design file has. `identity` is missing on ones a designer made. */
export interface DesignFileEntry<V> {
  id: string;
  name: string;
  identity?: string;
  value: V;
  deprecated: boolean;
}

/** The variables a design file has for one of the app's other themes, by the theme's name. */
export interface DesignFileTheme {
  theme: string;
  variables: DesignFileEntry<VariableValue>[];
}

export interface DesignFile {
  /** The default theme's colours, and the spacing and radius steps the code names (or, in a file synced before
   * scales were named, bare values). */
  variables: DesignFileEntry<VariableValue>[];
  /** A design file's text style always has a family, size and weight. */
  textStyles: DesignFileEntry<Required<TextValue>>[];
  /** Missing on a file that has no other theme, or one read before themes were synced. */
  themes?: DesignFileTheme[];
}

/** A token from the code: what it's recognised by, the name it gets when first made, and its value. */
export interface CodeToken<V> {
  identity: string;
  name: string;
  value: V;
  /** How the code refers to it, shown to designers beside the value. */
  reference?: string;
}

export interface Plan<V> {
  create: CodeToken<V>[];
  /** Ones whose value changed, or that come back after being deprecated; they keep their name in the file. */
  update: { id: string; name: string; token: CodeToken<V>; restored: boolean }[];
  /** Ones the code no longer has, marked rather than deleted, since designs may still use them. */
  deprecate: { id: string; name: string }[];
  /** Ones that look renamed in the code (`Theme.c3` became `Theme.secondaryText`): the only token gone and the only one
   * new in their group with that value. The entry takes the new identity and keeps its name and everything using it. */
  rename: { id: string; name: string; token: CodeToken<V> }[];
  /** Too many tokens changed at once to guess renames, so any renames among them are planned as deprecate plus
   * create. */
  renamesSkipped: boolean;
  unchanged: number;
}

/** What a sync changes in one of the app's other themes, which a design file keeps apart from the default one. */
export interface ThemePlan {
  theme: string;
  variables: Plan<VariableValue>;
}

export interface SyncPlan {
  variables: Plan<VariableValue>;
  textStyles: Plan<TextValue>;
  /** Each theme the code or the design file has: those only in the file are planned with nothing left in the code. */
  themes: ThemePlan[];
}

/** The group for colours the code uses without naming them, so a designer sees them apart from the named ones. */
const UNNAMED = "Unnamed";

export function planSync(tokens: SyncTokens, file: DesignFile): SyncPlan {
  const variables: CodeToken<VariableValue>[] = [
    ...tokens.colors.map(colorToken),
    ...tokens.spacing.map((d) => dimensionToken("spacing", d)),
    ...tokens.radii.map((d) => dimensionToken("radius", d)),
  ];
  const textStyles: CodeToken<TextValue>[] = tokens.textStyles.map((s) => ({
    identity: s.identity,
    name: `Text/${s.key}`,
    value: s.value,
    ...(s.reference ? { reference: s.reference } : {}),
  }));
  return {
    variables: plan(variables, file.variables, sameVariable, tokens.complete),
    textStyles: plan(textStyles, file.textStyles, sameText, tokens.complete),
    themes: themePlans(tokens.themes ?? [], file.themes ?? [], tokens.complete),
  };
}

const colorToken = (c: SyncColor): CodeToken<VariableValue> => ({
  identity: c.identity,
  name: c.identity.startsWith("color:#")
    ? `color/${UNNAMED}/${c.key.replace(/^hex-/, "")}`
    : `color/${c.key}`,
  value: c.dark ? { light: c.light, dark: c.dark } : { light: c.light },
  ...(c.reference ? { reference: c.reference } : {}),
});

/** A scale's step named by its key (`spacing/large`); a bare value from an older file by the value (`spacing/16`). */
const dimensionToken = (kind: "spacing" | "radius", d: SyncDimension): CodeToken<VariableValue> => ({
  identity: d.identity,
  name: `${kind}/${d.reference ? d.key : numberLabel(d.value)}`,
  value: d.value,
  ...(d.reference ? { reference: d.reference } : {}),
});

/** Each theme planned on its own, so a colour is matched, renamed or deprecated only within its theme. */
function themePlans(themes: SyncTheme[], file: DesignFileTheme[], complete: boolean): ThemePlan[] {
  const names = [...new Set([...themes.map((t) => t.name), ...file.map((t) => t.theme)])];
  return names.map((theme) => ({
    theme,
    variables: plan(
      themes.filter((t) => t.name === theme).flatMap((t) => t.colors.map(colorToken)),
      file.filter((t) => t.theme === theme).flatMap((t) => t.variables),
      sameVariable,
      complete,
    ),
  }));
}

/** A design file entry the sync manages: one it made, so it has an identity. */
type Synced<F> = DesignFileEntry<F> & { identity: string };

function plan<F, C>(
  tokens: CodeToken<C>[],
  file: DesignFileEntry<F>[],
  same: (inFile: F, inCode: C) => boolean,
  mayDeprecate: boolean,
): Plan<C> {
  // A variable duplicated in the design file carries the same identity: the first is synced, copies are left alone.
  const byIdentity = new Map<string, Synced<F>>();
  const copies = new Map<string, number>();
  for (const entry of file) {
    if (!entry.identity) continue;
    copies.set(entry.identity, (copies.get(entry.identity) ?? 0) + 1);
    if (!byIdentity.has(entry.identity))
      byIdentity.set(entry.identity, { ...entry, identity: entry.identity });
  }
  const update: Plan<C>["update"] = [];
  const created: CodeToken<C>[] = [];
  let unchanged = 0;
  for (const token of tokens) {
    const found = byIdentity.get(token.identity);
    if (!found) created.push(token);
    else if (found.deprecated || !same(found.value, token.value)) {
      update.push({ id: found.id, name: found.name, token, restored: found.deprecated });
    } else unchanged++;
  }
  // After a partial scan, a token missing from the code may only be missing from what was read.
  const listed = new Set(tokens.map((token) => token.identity));
  const dropped = mayDeprecate
    ? [...byIdentity.values()].filter((entry) => !listed.has(entry.identity) && !entry.deprecated)
    : [];
  const { rename, deprecate, renamesSkipped, toCreate } = dropsAndRenames(dropped, created, copies, same);
  // Names are handed out last, so a token that turned out to be a rename doesn't hold one; a name a designer already
  // used gets a suffix rather than a clash.
  const names = new Set(file.map((entry) => entry.name));
  const create = toCreate.map((token) => ({ ...token, name: unique(token.name, names) }));
  return { create, update, deprecate, rename, renamesSkipped, unchanged };
}

/** What becomes of the entries the code dropped: renamed to a new token that looks like the same one, or
 * deprecated; and the new tokens left to create. */
function dropsAndRenames<F, C>(
  dropped: Synced<F>[],
  created: CodeToken<C>[],
  copies: Map<string, number>,
  same: (inFile: F, inCode: C) => boolean,
) {
  // Renaming a duplicated entry would leave its copy to take its old identity, so only single entries are renamed;
  // every dropped entry still counts towards whether a match is the only one.
  const renamable = (entry: Synced<F>) => copies.get(entry.identity) === 1;
  const renamed = ownerRenames(dropped, created, same, renamable);
  const goneLeft = dropped.filter((entry) => !renamed.has(entry));
  const takenByOwner = new Set(renamed.values());
  const newLeft = created.filter((token) => !takenByOwner.has(token));
  const renamesSkipped = goneLeft.length * newLeft.length > MAX_RENAME_COMPARISONS;
  if (!renamesSkipped)
    for (const [entry, token] of renames(goneLeft, newLeft, same, renamable)) renamed.set(entry, token);
  const takenByRename = new Set(renamed.values());
  return {
    rename: [...renamed].map(([entry, token]) => ({ id: entry.id, name: entry.name, token })),
    deprecate: dropped
      .filter((entry) => !renamed.has(entry))
      .map((entry) => ({ id: entry.id, name: entry.name })),
    renamesSkipped,
    toCreate: created.filter((token) => !takenByRename.has(token)),
  };
}

/** A reference written as a path from an owner: `MainTheme.colors.error`, not `Color("Brand.bg")` or `R.color.x`'s
 * call-free cousins with quotes. */
const OWNED_PATH = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/;

/** What an identity names inside its owner: `color:colors.error` for `color:MainTheme.colors.error`, and for a text
 * style its name too (`type:typography.body|body`). Missing for one with no owner: an asset (`Color("Brand")`), a
 * file's own constant (`accent@Home.swift`), a value. */
function memberOf(identity: string): string | undefined {
  const kind = kindOf(identity);
  const [reference = "", ...name] = identity.slice(kind.length + 1).split("|");
  const member = OWNED_PATH.exec(reference)?.[2];
  return member ? [`${kind}:${member}`, ...name].join("|") : undefined;
}

/** Each renamable gone entry paired with the new token whose owner alone was renamed (`MainTheme.colors.error` became
 * `BoltTheme.colors.error`), with the same value: each the only one of its member on its side. */
function ownerRenames<F, C>(
  gone: Synced<F>[],
  created: CodeToken<C>[],
  same: (inFile: F, inCode: C) => boolean,
  renamable: (entry: Synced<F>) => boolean,
): Map<Synced<F>, CodeToken<C>> {
  const byMember = <T>(items: T[], identity: (item: T) => string) => {
    const found = new Map<string, T[]>();
    for (const item of items) {
      const member = memberOf(identity(item));
      if (!member) continue;
      const same = found.get(member);
      if (same) same.push(item);
      else found.set(member, [item]);
    }
    return found;
  };
  const newByMember = byMember(created, (token) => token.identity);
  const pairs = new Map<Synced<F>, CodeToken<C>>();
  for (const [member, [entry, ...others]] of byMember(gone, (e) => e.identity)) {
    const [token, ...rivals] = newByMember.get(member) ?? [];
    if (
      entry &&
      token &&
      !others.length &&
      !rivals.length &&
      renamable(entry) &&
      same(entry.value, token.value)
    )
      pairs.set(entry, token);
  }
  return pairs;
}

/** More comparisons than this between gone and new tokens is a rewrite, not a rename: the plan says it skipped them. */
const MAX_RENAME_COMPARISONS = 100_000;

/** Each renamable gone entry paired with a new token when each is the other's only match among every gone entry:
 * same kind, same value. */
function renames<F, C>(
  gone: Synced<F>[],
  created: CodeToken<C>[],
  same: (inFile: F, inCode: C) => boolean,
  renamable: (entry: Synced<F>) => boolean,
): Map<Synced<F>, CodeToken<C>> {
  const matches = (entry: Synced<F>, token: CodeToken<C>) =>
    kindOf(entry.identity) === kindOf(token.identity) && same(entry.value, token.value);
  const candidates = gone.map((entry) => created.filter((token) => matches(entry, token)));
  const timesMatched = new Map<CodeToken<C>, number>();
  for (const tokens of candidates) {
    for (const token of tokens) timesMatched.set(token, (timesMatched.get(token) ?? 0) + 1);
  }
  const pairs = new Map<Synced<F>, CodeToken<C>>();
  for (const [i, entry] of gone.entries()) {
    const [token, ...others] = candidates[i] ?? [];
    if (token && others.length === 0 && timesMatched.get(token) === 1 && renamable(entry))
      pairs.set(entry, token);
  }
  return pairs;
}

/** What kind of token an identity names: `color`, `spacing`, `radius` or `type`. */
export const kindOf = (identity: string) => identity.slice(0, identity.indexOf(":"));

function unique(name: string, names: Set<string>): string {
  let candidate = name;
  for (let n = 2; names.has(candidate); n++) candidate = `${name} ${n}`;
  names.add(candidate);
  return candidate;
}

/** Opacity a design file stores as a long fraction and tokens.json rounds to three places: closer than this is equal. */
const ALPHA_TOLERANCE = 0.002;

/** Whether two colours match, allowing `ALPHA_TOLERANCE` in opacity. */
export const sameRgba = (a: Rgba | undefined, b: Rgba | undefined) =>
  a === b ||
  (!!a &&
    !!b &&
    a.hex.toLowerCase() === b.hex.toLowerCase() &&
    Math.abs(a.alpha - b.alpha) < ALPHA_TOLERANCE);

function sameVariable(inFile: VariableValue, inCode: VariableValue): boolean {
  if (typeof inFile === "number" || typeof inCode === "number") return inFile === inCode;
  return sameRgba(inFile.light, inCode.light) && sameRgba(inFile.dark, inCode.dark);
}

/** Only what the code sets: a size it computes is whatever the designer set in the file. */
const sameText = (inFile: Required<TextValue>, inCode: TextValue) =>
  (inCode.family === undefined || inFile.family === inCode.family) &&
  (inCode.size === undefined || inFile.size === inCode.size) &&
  (inCode.weight === undefined || inFile.weight === inCode.weight);
