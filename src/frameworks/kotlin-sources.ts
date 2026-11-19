import { isTestPath } from "../scan/test-paths.js";
import type { CodeSpan } from "../scan/types.js";
import { kotlinCodeOnly, kotlinWithoutComments } from "./kotlin-source.js";
import type { ScanContext } from "./plugin.js";
import { type BracketTree, bracketTree, type Locator, locator } from "./source-text.js";

export interface KotlinSource {
  rel: string;
  text: string;
  /** The text with comments, strings and characters blanked out. */
  code: string;
  /** The text with only comments blanked: what the code says, strings included. */
  written: string;
  /** Uses Jetpack Compose (or Compose Multiplatform). */
  compose: boolean;
}

const COMPOSE_IMPORT = /\bimport\s+(?:androidx\.compose|org\.jetbrains\.compose)\./;

/** One Kotlin file's text as the readers read it. */
export function kotlinSource(rel: string, text: string): KotlinSource {
  const code = kotlinCodeOnly(text);
  return { rel, text, code, written: kotlinWithoutComments(text), compose: COMPOSE_IMPORT.test(code) };
}

/** Every non-test Kotlin file, read once, with comments and strings blanked out. */
export async function kotlinSources(ctx: ScanContext): Promise<KotlinSource[]> {
  const out: KotlinSource[] = [];
  for (const f of ctx.files.filter((f) => f.rel.endsWith(".kt") && !isTestPath(f.rel))) {
    const text = await ctx.read(f);
    if (text) out.push(kotlinSource(f.rel, text));
  }
  return out;
}

const trees = new WeakMap<KotlinSource, BracketTree>();

/** The source's brackets, matched once for every reader. */
export function treeOf(source: KotlinSource): BracketTree {
  let tree = trees.get(source);
  if (!tree) {
    tree = bracketTree(source.code);
    trees.set(source, tree);
  }
  return tree;
}

const locators = new WeakMap<KotlinSource, Locator>();

/** Where `start` to `end` of `source` is, its lines found once for every reader. */
export function spanIn(source: KotlinSource, start: number, end: number): CodeSpan {
  let span = locators.get(source);
  if (!span) {
    span = locator(source.rel, source.text);
    locators.set(source, span);
  }
  return span(start, end);
}

/** The module a file belongs to: its path before `/src/`, so an app's phone, TV and watch apps are told apart. */
export const moduleOf = (source: KotlinSource): string => source.rel.split("/src/")[0] ?? source.rel;

/** Of several things sharing a name, the one nearest `source`: in the same file, then in the same module, then the only
 * one; when several are elsewhere, none, since a link to another app's copy would be wrong. */
export function nearestTo<T>(
  items: T[],
  source: KotlinSource,
  sourceOf: (item: T) => KotlinSource,
): T | undefined {
  return (
    items.find((item) => sourceOf(item) === source) ??
    items.find((item) => moduleOf(sourceOf(item)) === moduleOf(source)) ??
    (items.length === 1 ? items[0] : undefined)
  );
}
