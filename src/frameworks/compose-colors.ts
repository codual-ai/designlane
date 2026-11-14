/**
 * A Compose app's colours for the shared palette: colour resources, named constants (`val Purple80 =
 * Color(0xFFD0BCFF)`, `Palette.Brand`), the theme's roles (see `compose-themes.ts`), and colours written inline. A
 * constant only the theme reads is part of the theme, so it isn't listed again beside the role it sets.
 */

import type { ColorFindings, NamedColor } from "../scan/palette.js";
import type { ResourceColor } from "./android-resources.js";
import { COMPOSE_COLORS, type ColorLookup, colorValue, expressionEnd } from "./compose-color-values.js";
import { themeColors } from "./compose-themes.js";
import { declaredIn, isDeclared, located, prefixesOf, Spans } from "./kotlin-calls.js";
import type { KotlinSource } from "./kotlin-sources.js";

/** A named colour constant, top-level or in an object; which kind is checked where it's declared. */
const CONSTANT = /\bval\s+(\w+)\s*(?::\s*Color\s*)?=\s*(?=Color\s*\(|Color\.\w|[\w.]+\.copy\s*\()/g;
/** A use of a name: a dotted path, not being set (`=`); a call on it (`Brand.copy(`) is still a use of `Brand`. */
const NAME_USE = /(?<![\w.])((?:[A-Za-z_]\w*\.)*[A-Za-z_]\w*)\b(?!\s*=[^=])/g;

/** Named colours by how the code refers to them, where their values are written, and how to look one up. */
class Colors {
  readonly named: NamedColor[] = [];
  readonly written = new Map<KotlinSource, Spans>();
  private readonly byReference = new Map<string, NamedColor>();
  /** Each colour by every dotted end of its reference (`Dark.Brand` for `Palette.Dark.Brand`), first come first
   * served, for code that imports part of the path. */
  private readonly byEnd = new Map<string, NamedColor>();
  /** Every colour with a bare name, since files may each declare their own private `Primary`. */
  private readonly byName = new Map<string, NamedColor[]>();

  /** A bare name is the colour declared in the same file first, as Kotlin resolves a private one. */
  readonly known: ColorLookup = (name, file) => {
    const all = this.byName.get(name) ?? [];
    const color = name.includes(".")
      ? (this.byReference.get(name) ?? this.byEnd.get(name))
      : (all.find((c) => c.source === file) ?? this.byReference.get(name) ?? all[0]);
    const location = color?.locations?.light;
    return color && { hex: color.light, ...(location && { location }) };
  };

  has = (reference: string) => this.byReference.has(reference);

  add(color: NamedColor, source?: KotlinSource, span?: [number, number]): void {
    this.named.push(color);
    this.byReference.set(color.reference, color);
    const sameName = this.byName.get(color.name) ?? [];
    sameName.push(color);
    this.byName.set(color.name, sameName);
    const parts = color.reference.split(".");
    for (let i = 1; i < parts.length - 1; i++) {
      const end = parts.slice(i).join(".");
      if (!this.byEnd.has(end)) this.byEnd.set(end, color);
    }
    if (source && span) {
      const spans = this.written.get(source) ?? new Spans();
      spans.add(...span);
      this.written.set(source, spans);
    }
  }
}

export function composeColors(sources: KotlinSource[], resources: ResourceColor[]): ColorFindings {
  const colors = new Colors();
  for (const r of resources) colors.add({ ...r, reference: `R.color.${r.name}`, kind: "asset" });
  constants(sources, colors);
  const theme = themeColors(sources, colors.known);
  for (const { color, source } of theme.colors) colors.add(color, source);
  const { named, references } = uses(sources, colors.named, theme.definitions);
  return {
    named,
    references,
    literals: literals(sources, [colors.written, theme.definitions]),
    system: sources.flatMap((s) =>
      [...s.code.matchAll(/\bColor\.(\w+)\b/g)].flatMap((m) =>
        m[1] && m[1] in COMPOSE_COLORS ? [m[1]] : [],
      ),
    ),
  };
}

/** Named colour constants. A copy of another (`val Faded = Brand.copy(alpha = 0.5f)`) is read once every plain one
 * is known, so it finds its base wherever that's declared. */
function constants(sources: KotlinSource[], colors: Colors): void {
  const found = sources.flatMap((source) =>
    located(source, CONSTANT).flatMap(({ m, line }) => {
      const owner = declaredIn(source, m.index ?? 0);
      if (owner === undefined) return [];
      const at = (m.index ?? 0) + m[0].length;
      const name = m[1] ?? "";
      const reference = owner ? `${owner}.${name}` : name;
      return [{ source, at, end: expressionEnd(source, at), name, reference, line }];
    }),
  );
  const isCopy = (c: (typeof found)[number]) => /\.copy\s*\(/.test(c.source.code.slice(c.at, c.end));
  for (const constant of [...found.filter((c) => !isCopy(c)), ...found.filter(isCopy)]) {
    const { source, at, end, name, reference, line } = constant;
    if (colors.has(reference)) continue;
    const value = colorValue(source, at, end, colors.known);
    if (!value) continue;
    const locations = value.location ? { locations: { light: value.location } } : {};
    colors.add(
      { name, light: value.hex, source: source.rel, reference, line, kind: "code", ...locations },
      source,
      [at, end],
    );
  }
}

/** The named colours, less constants only the theme reads, and every use of the rest outside the theme. */
function uses(sources: KotlinSource[], named: NamedColor[], theme: Map<KotlinSource, Spans>) {
  const references: ColorFindings["references"] = [];
  const inTheme = new Set<string>();
  const used = new Set<string>();
  const byReference = new Set(named.map((c) => c.reference));
  // A top-level constant is used by its bare name; one in an object or a resource, by its path.
  const byName = new Set(
    named.filter((c) => c.kind === "code" && !c.reference.includes(".")).map((c) => c.name),
  );
  for (const source of sources) {
    const spans = theme.get(source)?.start();
    for (const m of source.code.matchAll(NAME_USE)) {
      let path = "";
      for (const start of prefixesOf(m[1] ?? ""))
        if (byReference.has(start) || byName.has(start)) {
          path = start;
          break;
        }
      if (!path) continue;
      if (spans?.contains(m.index ?? 0)) {
        inTheme.add(path);
        continue;
      }
      used.add(path);
      references.push(
        byReference.has(path) ? { name: path.split(".").at(-1) ?? path, reference: path } : { name: path },
      );
    }
  }
  const partOfTheme = (c: NamedColor) =>
    c.kind === "code" && inTheme.has(c.reference) && !used.has(c.reference);
  return { named: named.filter((c) => !partOfTheme(c)), references };
}

/** Each colour value written outside the definitions of named colours and the theme, with its file. */
function literals(
  sources: KotlinSource[],
  definitions: Map<KotlinSource, Spans>[],
): ColorFindings["literals"] {
  const out: ColorFindings["literals"] = [];
  for (const source of sources) {
    const spans = definitions.flatMap((d) => d.get(source)?.start() ?? []);
    for (const m of source.code.matchAll(/(?<![\w.])Color\s*\(/g)) {
      const at = m.index ?? 0;
      if (spans.some((s) => s.contains(at)) || isDeclared(source.code, at)) continue;
      const value = colorValue(source, at, expressionEnd(source, at), () => undefined);
      if (value) out.push({ hex: value.hex, file: source.rel });
    }
  }
  return out;
}
