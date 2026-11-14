/**
 * Colours from Tailwind (NativeWind, Uniwind): those a `tailwind.config.js` or a CSS `@theme` names, and the class
 * names that use them (`bg-primary-500`, `dark:text-muted`).
 */

import ts from "typescript";
import type { ColorFindings, NamedColor } from "../scan/palette.js";
import { colorOf } from "./css-color.js";
import {
  type JsSource,
  lineOf,
  literalLocation,
  propertyName,
  stringValue,
  unwrapped,
} from "./js-sources.js";
import type { ScanContext } from "./plugin.js";
import { classColors, eachClassList } from "./tailwind-classes.js";
import { type Located, MAX_HOPS, type Resolver, themeGroups } from "./tailwind-config.js";
import { cssColors, readCss } from "./tailwind-css.js";

export interface TailwindFindings extends ColorFindings {
  /** The configs and the modules they read colours from, whose colours are Tailwind's names, not objects' paths. */
  files: Set<string>;
  /** The app uses Tailwind: it has a config, or a stylesheet bringing Tailwind in. */
  used: boolean;
  /** The families a CSS `@theme` names, by class name: `--font-inter: "Inter"` is `font-inter`. */
  fonts: Record<string, string>;
}

/** The colours Tailwind names in the project, with the class names using them; empty for an app without Tailwind. */
export async function tailwindColors(ctx: ScanContext, sources: JsSource[]): Promise<TailwindFindings> {
  const files = new Set<string>();
  const named = [...configColors(sources, files), ...(await cssColors(ctx))];
  const css = await readCss(ctx);
  const used = files.size > 0 || css.imports;
  const found: TailwindFindings = {
    named,
    references: [],
    literals: [],
    system: [],
    files,
    used,
    fonts: css.fonts,
  };
  if (named.length === 0) return found;
  const names = new Set(named.map((c) => c.name));
  for (const source of sources) {
    eachClassList(source, (_, text) => {
      for (const name of classColors(text))
        if (names.has(name)) found.references.push({ name, reference: name });
    });
  }
  return found;
}

/** The colours `theme.colors` and `theme.extend.colors` name in a Tailwind config, nested names joined by `-`
 * (`charcoal: { 500 }` is `charcoal-500`, `DEFAULT` is the group's own), also from modules the config requires. */
function configColors(sources: JsSource[], files: Set<string>): NamedColor[] {
  const out: NamedColor[] = [];
  for (const { config, groups, resolver } of themeGroups(sources, "colors")) {
    files.add(config.rel);
    for (const group of groups) flatten(group, [], resolver, files, out, 0);
  }
  return out;
}

function flatten(
  at: Located,
  names: string[],
  resolver: Resolver,
  files: Set<string>,
  out: NamedColor[],
  hops: number,
) {
  const object = hops > MAX_HOPS ? undefined : resolver.object(at);
  if (!object) return;
  files.add(object.source.rel);
  for (const property of object.node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = propertyName(property.name);
    if (key === undefined) continue;
    const parts = key === "DEFAULT" ? names : [...names, key];
    const text = stringValue(property.initializer);
    const light = text === undefined ? undefined : colorOf(text, true);
    const written = literalLocation(object.source, unwrapped(property.initializer));
    const name = parts.join("-");
    if (light && name) {
      out.push({
        name,
        light,
        source: object.source.rel,
        reference: name,
        line: lineOf(property),
        kind: "code",
        ...(written && { locations: { light: written } }),
      });
      continue;
    }
    // A nested group, also one held elsewhere: `brand: require("./brand")`.
    flatten({ node: property.initializer, source: object.source }, parts, resolver, files, out, hops + 1);
  }
}
