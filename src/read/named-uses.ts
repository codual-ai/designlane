/** Where one file names the app's tokens: each dotted name, implicit member and string call the index knows, with
 * the span of exactly the name. */

import type { Locator } from "../frameworks/source-text.js";
import { callKey, type Named, type TokenIndex } from "./token-index.js";

/** A dotted name, with any leading `.` (an implicit member, `.ink`) and index (`gray[100]`). */
const PATH = /(?<![\w$])(\.)?([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*|\[\d+\]){0,12})/g;
/** Where a path's next part starts: after a `.` or `?.`, or at a `[`. */
const PART = /[A-Za-z_$][\w$]*|\[\d+\]/g;
/** A call given one string, matched in the text as written: `Color("Brand")`, `UIColor(named: "Brand")`. */
const STRING_CALL = /\b([A-Za-z_][\w.]{0,100})\(\s{0,20}(?:named:\s{0,20})?"([^"\n]{1,200})"\s{0,20}\)/g;

export interface NamedUse {
  named: Named;
  start: number;
  end: number;
}

interface Part {
  text: string;
  start: number;
  end: number;
}

const joined = (parts: Part[]) =>
  parts.reduce((out, p) => (out && !p.text.startsWith("[") ? `${out}.${p.text}` : `${out}${p.text}`), "");

/** The longest run of `parts` the index names, earliest first: `Theme.brand` of `Theme.brand.opacity(0.5)`. */
function longestNamed(
  index: TokenIndex,
  parts: Part[],
): { named: Named[]; start: number; end: number } | undefined {
  for (let length = parts.length; length >= 1; length--)
    for (let first = 0; first + length <= parts.length; first++) {
      const run = parts.slice(first, first + length);
      const named = index.paths.get(joined(run));
      if (named) return { named, start: run[0]?.start ?? 0, end: run.at(-1)?.end ?? 0 };
    }
  return undefined;
}

/** Of the tokens a name may mean, the one meant: the only one, else the default theme's. */
const meant = (named: Named[]) => (named.length === 1 ? named[0] : named.find((n) => !n.token.theme));

/** Every use of a named token in a file, by where its name is written in `code` (comments and strings blanked) or, for
 * a string call, in `text`. A token's own declaration isn't a use of it. */
export function namedUses(
  index: TokenIndex,
  rel: string,
  text: string,
  code: string,
  at: Locator,
): NamedUse[] {
  const out: NamedUse[] = [];
  const own = (named: Named, start: number) =>
    named.declared?.file === rel && named.declared.line === at(start, start).line;
  const push = (candidates: Named[] | undefined, start: number, end: number) => {
    const named = candidates && meant(candidates);
    if (named && !own(named, start)) out.push({ named, start, end });
  };
  for (const m of code.matchAll(PATH)) {
    const offset = (m.index ?? 0) + (m[1] ? 1 : 0);
    const path = m[2] ?? "";
    const parts = [...path.matchAll(PART)].map((p) => ({
      text: p[0],
      start: offset + (p.index ?? 0),
      end: offset + (p.index ?? 0) + p[0].length,
    }));
    const found = longestNamed(index, parts);
    if (found) push(found.named, found.start, found.end);
    else if (m[1] && parts[0]) push(index.members.get(parts[0].text), offset - 1, parts[0].end);
  }
  for (const m of text.matchAll(STRING_CALL)) {
    const start = m.index ?? 0;
    if (code[start] === " ") continue;
    push(index.calls.get(callKey(m[1] ?? "", m[2] ?? "")), start, start + m[0].length);
  }
  return out;
}
