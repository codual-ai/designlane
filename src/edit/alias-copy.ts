/** The checks for copying a colour's value in place of the name a token reaches it through: that the copy names
 * nothing out of scope there, and that each name still leads where tokens.json says. */

import type { CodeSpan, ValueKind } from "../scan/types.js";
import { hasWord, IDENTIFIER, LAST_PART } from "./code-scan.js";
import type { ValueLocation } from "./edit-tokens.js";
import { QUOTES } from "./notation.js";
import { type ReadSource, textOf } from "./read-source.js";

/** A value's parts: white space, a string, a number (`0x3366CC`, `0.5f`), a word, or one other character. */
const PART = /\s+|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\d[\w.]*|[A-Za-z_$][\w$]*|[\s\S]/g;
/** A string that works a name into it: Swift's `\(alpha)`, Kotlin's and Dart's `$alpha`. */
const INTERPOLATES = /\\\(|\$/;

/** Whether a value copied elsewhere names nothing that may not be in scope there: it's a literal, or a call
 * (`Color(hex: 0x3366CC, opacity: 0.5)`) of numbers and strings, labelled or not, and members its arguments' types
 * have (`.sRGB`), not `Color(hex: 0x3366CC, opacity: alpha)`. */
export function namesNothing(text: string, kind: ValueKind): boolean {
  if (kind === "literal") return true;
  const parts = [...text.matchAll(PART)].map(([part]) => part).filter((part) => part.trim() !== "");
  let at = parts[0] === "#" ? 1 : 0;
  while (IDENTIFIER.test(parts[at] ?? "") && parts[at + 1] === ".") at += 2;
  at = IDENTIFIER.test(parts[at] ?? "") && parts[at + 1] === "(" ? at + 1 : 0;
  return parts.slice(at).every((part, i, rest) => {
    if (QUOTES.has(part[0] ?? "")) return !INTERPOLATES.test(part);
    if (!IDENTIFIER.test(part)) return part !== "`";
    const [before, after = "", next] = [rest[i - 1], rest[i + 1], rest[i + 2]];
    const isLabel = after === ":" || (after === "=" && next !== "=");
    const isMember = before === "." && (rest[i - 2] === "(" || rest[i - 2] === ",");
    return isLabel || isMember;
  });
}

/** Whether each name on the way to a colour still names the next: its last part (`blue0` of `colors.blue0`) is
 * declared on the line of the next name or the value, so a name changed since the scan isn't followed blindly.
 * Returns the first name that doesn't. */
export async function namesHold(location: ValueLocation, read: ReadSource): Promise<CodeSpan | undefined> {
  const chain = [...(location.via ?? []), location];
  for (const [i, name] of chain.slice(0, -1).entries()) {
    const next = chain[i + 1];
    const [nameText, nextText] = (await Promise.all([read(name.file), next && read(next.file)])).map(textOf);
    const part = LAST_PART.exec(nameText?.slice(name.start, name.end) ?? "")?.[1];
    if (!next || nextText === undefined || !part) return name;
    const declaration = nextText.slice(nextText.lastIndexOf("\n", next.start - 1) + 1, next.start);
    if (!hasWord(declaration, part)) return name;
  }
  return undefined;
}
