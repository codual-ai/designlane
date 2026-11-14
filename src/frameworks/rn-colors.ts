/**
 * A React Native app's colours: those its theme objects name (`colors.surface`, with a `light` and `dark` object
 * paired into one colour), where the code uses them, and the colours written straight into styles.
 */

import type ts from "typescript";
import type { ColorFindings, NamedColor } from "../scan/palette.js";
import { type JsSource, renderPath } from "./js-sources.js";
import { collectNamed, mostlyColors, resolveAliases, type Valued } from "./rn-color-entries.js";
import { Modules } from "./rn-color-modules.js";
import { collectUses, type Known } from "./rn-color-uses.js";
import { modeOf, namedColor, themesApart } from "./rn-themes.js";
import { TAILWIND_CONFIG } from "./tailwind-config.js";

/** `tailwind` holds the files whose colours Tailwind names (see tailwind-colors.ts), left out here. */
export function rnColors(sources: JsSource[], tailwind: Set<string> = new Set()): ColorFindings {
  const read = sources.filter((s) => !TAILWIND_CONFIG.test(s.rel) && !tailwind.has(s.rel));
  const modules = new Modules(read);
  const leaves = new Map<ts.ObjectLiteralExpression, number>();
  const entries = read.flatMap((source) => collectNamed(source, modules, leaves));
  const valued = mostlyColors(resolveAliases(entries, modules), leaves);
  const { kept, themes } = themesApart(valued);
  const named = once(pairModes(kept));
  const known: Known = {
    names: new Set(named.map((c) => c.name)),
    constants: constantsByName(valued),
    definitions: new Set(valued.map((e) => e.node)),
    holders: new Set(valued.flatMap((e) => e.path.slice(0, -1).map((part) => part.toLowerCase()))),
  };
  const found: ColorFindings = {
    named,
    references: [],
    literals: [],
    system: [],
    ...(themes.length > 0 ? { themes } : {}),
  };
  for (const source of read) collectUses(source, known, found);
  return found;
}

/** Colours told apart only by a `light` and a `dark` object (`themes.light.surface`, `themes.dark.surface`, or
 * `lightTheme.surface` and `darkTheme.surface` in their own files) are one colour with both values; the rest stand as
 * they are, a second colour at the same path included. */
function pairModes(entries: Valued[]): NamedColor[] {
  const pairs = new Map<string, { light?: Valued; dark?: Valued }>();
  const alone: NamedColor[] = [];
  // A colour with its own two values, `SECONDARY_LABEL = { light: "…", dark: "…" }`, is named by its object.
  const own = new Map<string, { light?: Valued; dark?: Valued; path: string[] }>();
  const rest: Valued[] = [];
  for (const e of entries) {
    const mode = e.path.length > 1 ? (e.path[e.path.length - 1] ?? "").toLowerCase() : "";
    if (mode !== "light" && mode !== "dark") {
      rest.push(e);
      continue;
    }
    const key = `${e.source.rel}\0${e.path.slice(0, -1).join("\0")}`;
    const pair = own.get(key) ?? { path: e.path.slice(0, -1) };
    pair[mode] = e;
    own.set(key, pair);
  }
  for (const { light, dark, path: at } of own.values()) {
    const first = light ?? dark;
    if (!first) continue;
    alone.push({
      ...namedColor(first, light && dark),
      name: at[at.length - 1] ?? first.name,
      reference: renderPath(at),
    });
  }
  for (const e of rest) {
    const at = e.path.slice(0, -1).findIndex((part) => modeOf(part) !== undefined);
    const mode = at === -1 ? undefined : modeOf(e.path[at] ?? "");
    // `lightColors` pairs with `darkColors`, and `LightTheme` with `DarkTheme`, not with each other.
    const rest = (e.path[at] ?? "").toLowerCase().replace(mode ?? "", "*");
    const key = mode && [...e.path.slice(0, at), rest, ...e.path.slice(at + 1)].join("\0");
    const pair = key ? (pairs.get(key) ?? {}) : undefined;
    if (!mode || !key || !pair || pair[mode]) {
      alone.push(namedColor(e));
      continue;
    }
    pair[mode] = e;
    pairs.set(key, pair);
  }
  const paired = [...pairs.values()].flatMap(({ light, dark }) => {
    if (light) return [namedColor(light, dark)];
    return dark ? [namedColor(dark)] : [];
  });
  return [...paired, ...alone];
}

/** One colour per name and values: a theme reached two ways (`light.fontDefault`, `colors.light.fontDefault`) or
 * repeated (`text: "#fff"` in each card's colours) is one colour, at its first place. */
function once(colors: NamedColor[]): NamedColor[] {
  const seen = new Set<string>();
  return colors.filter((c) => {
    const key = `${c.name}|${c.light}|${c.dark ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function constantsByName(entries: Valued[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const e of entries.filter((x) => x.path.length === 1)) {
    const files = out.get(e.name) ?? new Set<string>();
    files.add(e.source.rel);
    out.set(e.name, files);
  }
  return out;
}
