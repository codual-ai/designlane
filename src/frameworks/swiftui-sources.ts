import { isTestPath } from "../scan/test-paths.js";
import type { ScanContext } from "./plugin.js";
import { codeOnly, withoutPreviews } from "./swift-source.js";
import { type SwiftTokens, swiftTokens } from "./swift-tokens.js";

/** Lines longer than this are generated data, not hand-written declarations, and aren't matched line by line. */
const MAX_LINE = 1000;

export interface SwiftSource {
  rel: string;
  text: string;
  /** The text with comments, strings and previews blanked out. */
  code: string;
  /** `text` split into lines once, since several readers go line by line. */
  lines: string[];
  swiftUI: boolean;
}

const tokenized = new WeakMap<SwiftSource, SwiftTokens>();

/** `source` read into tokens once, for every reader that needs them. */
export function tokensOf(source: SwiftSource): SwiftTokens {
  let tokens = tokenized.get(source);
  if (!tokens) {
    tokens = swiftTokens(source.text);
    tokenized.set(source, tokens);
  }
  return tokens;
}

/** One Swift file's text as the readers read it. */
export function swiftSource(rel: string, text: string): SwiftSource {
  const code = withoutPreviews(codeOnly(text));
  return { rel, text, code, lines: text.split("\n"), swiftUI: /\bimport\s+SwiftUI\b/.test(code) };
}

/** Every non-test Swift file, read once, with comments, strings and previews blanked out. */
export async function swiftSources(ctx: ScanContext): Promise<SwiftSource[]> {
  const out: SwiftSource[] = [];
  for (const f of ctx.files.filter((f) => f.rel.endsWith(".swift") && !isTestPath(f.rel))) {
    const text = await ctx.read(f);
    if (text) out.push(swiftSource(f.rel, text));
  }
  // A module that re-exports SwiftUI makes it available to every file without an import.
  if (out.some((s) => /@_exported\s+import\s+SwiftUI\b/.test(s.code))) for (const s of out) s.swiftUI = true;
  return out;
}

/** Matches of `pattern` anywhere in the file, for calls written over several lines, skipping any that start inside a
 * comment or string. `pattern` must not be able to run away on long input. */
export function* matchesInCode({ text, code }: SwiftSource, pattern: RegExp) {
  for (const m of text.matchAll(pattern)) if (code[m.index ?? 0] !== " ") yield m;
}

/** Matches of `pattern` one line at a time, with that line, skipping any that start inside a comment or string. */
export function* matchesPerLine({ lines, code }: SwiftSource, pattern: RegExp) {
  let offset = 0;
  for (const line of lines) {
    if (line.length <= MAX_LINE) {
      for (const m of line.matchAll(pattern)) {
        if (code[offset + (m.index ?? 0)] !== " ") yield { m, line };
      }
    }
    offset += line.length + 1;
  }
}
