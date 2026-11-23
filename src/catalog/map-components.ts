/**
 * The components an agent's map names, checked with the catalog's readers: each is a view the scan read, declared
 * where the map says, and each parameter the map gives is one its declaration takes. A view borne out is marked as
 * the design system's, with the map's category; what isn't is left out, saying where and why.
 */

import { type MapComponent, type MapReading, placeOf, type Unconfirmed } from "../scan/agent-map.js";
import type { Category, ScreenRef } from "../scan/types.js";
import { readerOf } from "./components.js";
import { type ComponentReader, lineIndex } from "./reader.js";
import { type AppSources, codeFiles } from "./sources.js";

/** How many lines from a view's declaration the map's line may be: an annotation above it (`@Composable`), or the
 * line its body opens on. */
const MAX_LINES_AWAY = 2;

/** The words an agent may use for a category, and the catalog's for each. */
const CATEGORY_WORDS: Record<string, Category> = {
  button: "button",
  list: "list",
  row: "list",
  cell: "list",
  item: "list",
  card: "card",
  sheet: "card",
  header: "header",
  toolbar: "header",
  bar: "header",
  input: "input",
  field: "input",
  label: "label",
  badge: "label",
  chip: "label",
  text: "label",
  media: "media",
  screen: "screen",
  page: "screen",
  avatar: "media",
  image: "media",
  icon: "media",
};

/** The catalog's category for the word a map gives, `other` for one it has none for. */
export const categoryFromMap = (word: string): Category => {
  const key = word.toLowerCase();
  return Object.hasOwn(CATEGORY_WORDS, key) ? (CATEGORY_WORDS[key] ?? "other") : "other";
};

/** The last name in a component's reference: `PrimaryButton` in `DesignSystem.PrimaryButton`. */
const nameOf = (reference: string) => reference.split(".").at(-1) ?? reference;

/** A parameter's name as the code declares it: `title` in `title: String`, `let title: String` or `title = ""`. */
const PARAMETER_NAME =
  /^\s*(?:@[\w.]+(?:\([^)]*\))?\s*)*(?:(?:private|public|internal|let|var|val|override|vararg|noinline|crossinline|readonly)\s+)*\.{0,3}([A-Za-z_$][\w$]*)/;

/** `reading` with the map's components checked against the app's views: a confirmed one marked as the design
 * system's, counted, and each left out with where and why. */
export function confirmComponents(reading: MapReading, sources: AppSources): MapReading {
  const entries = Object.entries(reading.components);
  if (entries.length === 0) return reading;
  const [framework] = reading.scan.frameworks;
  const own = framework && sources.get(framework.framework);
  if (!framework || !own) return reading;
  const reader = readerOf(own);
  const files = new Map(codeFiles(own).map((f) => [f.rel, f]));
  // Each file's views by name, and its lines, found once: a map may name every view the app has.
  const byFileAndName = new Map<string, ScreenRef[]>();
  for (const s of framework.screens) {
    const key = `${s.file}|${s.name}`;
    const same = byFileAndName.get(key);
    if (same) same.push(s);
    else byFileAndName.set(key, [s]);
  }
  const lines = new Map<string, (offset: number) => number>();
  const lineOf = (file: string, offset: number) => {
    let index = lines.get(file);
    if (!index) {
      index = lineIndex(files.get(file)?.text ?? "");
      lines.set(file, index);
    }
    return index(offset);
  };
  const unconfirmed: Unconfirmed[] = [];
  const marked = new Map<string, ScreenRef>();
  for (const [reference, component] of entries) {
    const view = viewAt(byFileAndName, reader, lineOf, nameOf(reference), component);
    if (!view) {
      unconfirmed.push({
        reference,
        at: component.at,
        kind: "no-component",
        why: `no view named ${nameOf(reference)} is declared there`,
      });
      continue;
    }
    const declaration = reader.declaration(view);
    const code = declaration
      ? (files.get(view.file)?.code.slice(declaration.start, declaration.end) ?? "")
      : "";
    const taken = new Set([
      ...(declaration?.params ?? []).flatMap(parameterNames),
      ...(framework.framework === "swiftui" ? [...initLabels(code), ...wrappedProperties(code)] : []),
      ...(framework.framework === "react-native" ? propsRead(code) : []),
    ]);
    for (const parameter of component.parameters)
      if (!taken.has(parameter))
        unconfirmed.push({
          reference: `${reference}(${parameter})`,
          at: component.at,
          kind: "no-parameter",
          why: `${nameOf(reference)} takes no ${parameter}`,
        });
    // Its kind stays as the scan read it: a screen the map lists is still a screen.
    marked.set(view.id, {
      ...view,
      category: categoryFromMap(component.category),
      designSystem: true,
    });
  }
  const screens = framework.screens.map((s) => marked.get(s.id) ?? s);
  return {
    ...reading,
    scan: { ...reading.scan, frameworks: [{ ...framework, screens }] },
    confirmed: reading.confirmed + marked.size,
    unconfirmed: [...reading.unconfirmed, ...unconfirmed],
  };
}

/** The names a parameter as the code writes it gives, its modifiers aside (`readonly title: string`): `title` for `title: String`, each of `{ title, onPress }`. */
function parameterNames(parameter: string): string[] {
  const destructured = /^\s*\{([^}]*)\}/.exec(parameter)?.[1];
  if (destructured !== undefined)
    return destructured.split(",").flatMap((p) => /^\s*(?:\.{3})?([A-Za-z_$][\w$]*)/.exec(p)?.[1] ?? []);
  const name = PARAMETER_NAME.exec(parameter)?.[1];
  return name ? [name] : [];
}

/** The names a Swift view's initializers take, by the label a caller writes: `title` for `init(title: String)`,
 * `label` for `init(label text: String)`, `text` for `init(_ text: String)`. */
function initLabels(code: string): string[] {
  const names: string[] = [];
  for (const m of code.matchAll(/\binit\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    for (const parameter of topLevelParts(code, open)) {
      // Its attributes aside: `@ViewBuilder content: …`.
      const words = (parameter.split(":")[0]?.trim().split(/\s+/) ?? []).filter((w) => !w.startsWith("@"));
      const label = words[0] === "_" ? words[1] : words[0];
      if (label && /^[A-Za-z_]\w*$/.test(label)) names.push(label);
    }
  }
  return names;
}

/** A Swift view's wrapped properties its memberwise initializer takes: `@State public var viewModel`, `@Binding var
 * isOn`; not a private one, which a caller can't set. */
function wrappedProperties(code: string): string[] {
  return [...code.matchAll(/@\w+(?:\([^)]*\))?\s+(?:(?:public|internal|open)\s+)?var\s+([A-Za-z_]\w*)/g)].map(
    (m) => m[1] ?? "",
  );
}

/** The props a React Native component reads: `props.title`, `props?.title`, and the keys it destructures from its
 * props (`const { title, subtitle: label, onPress = noop } = props` gives `title`, `subtitle`, `onPress`). */
function propsRead(code: string): string[] {
  const names = [...code.matchAll(/\bprops\??\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1] ?? "");
  for (const m of code.matchAll(/\}\s*=\s*(?:this\.)?props\b/g)) {
    const open = openingBrace(code, m.index ?? 0);
    if (open === undefined) continue;
    for (const part of topLevelParts(code, open))
      names.push(/^\s*(?:\.{3})?([A-Za-z_$][\w$]*)/.exec(part)?.[1] ?? "");
  }
  return names.filter(Boolean);
}

/** The parts between the bracket at `open` and its close, split at its own commas: brackets inside balanced. */
function topLevelParts(code: string, open: number): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = open + 1;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{" || c === "<") depth++;
    // A function type's `->` and `=>` close nothing.
    else if (c === ">" && (code[i - 1] === "-" || code[i - 1] === "=")) continue;
    else if (c === ")" || c === "]" || c === "}" || c === ">") {
      if (--depth === 0) {
        parts.push(code.slice(from, i));
        return parts;
      }
    } else if (c === "," && depth === 1) {
      parts.push(code.slice(from, i));
      from = i + 1;
    }
  }
  return parts;
}

/** The `{` the `}` at `close` closes, read backwards over balanced braces. */
function openingBrace(code: string, close: number): number | undefined {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (code[i] === "}") depth++;
    else if (code[i] === "{" && --depth === 0) return i;
  }
  return undefined;
}

/** The view named `name` declared in the map's file whose declaration holds the map's line, from its first line to
 * where its body opens; else the nearest within a line or two of that (an annotation above it, `@Composable`). */
function viewAt(
  byFileAndName: Map<string, ScreenRef[]>,
  reader: ComponentReader,
  lineOf: (file: string, offset: number) => number,
  name: string,
  component: MapComponent,
): ScreenRef | undefined {
  const { file, line } = placeOf(component.at);
  const holding = (byFileAndName.get(`${file}|${name}`) ?? []).flatMap((s) => {
    const declaration = reader.declaration(s);
    const first = declaration ? Math.min(lineOf(file, declaration.start), s.line) : s.line;
    const within = line >= first && line <= s.line;
    if (!within && (line < first - MAX_LINES_AWAY || line > s.line + MAX_LINES_AWAY)) return [];
    return [{ view: s, away: within ? 0 : Math.min(Math.abs(first - line), Math.abs(s.line - line)) }];
  });
  return holding.sort((a, b) => a.away - b.away)[0]?.view;
}
