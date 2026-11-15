/** The other token values an edit would change too: those written in the same place, those whose names lead there,
 * and those the code works out from the token by its name. */

import type { CodeSpan } from "../scan/types.js";
import { IDENTIFIER, LAST_PART, namesWord, statementAt } from "./code-scan.js";
import { type EditableToken, type TokenValue, valueLabel } from "./edit-tokens.js";
import { type ReadSource, textOf } from "./read-source.js";

const overlaps = (a: CodeSpan, b: CodeSpan) => a.file === b.file && a.start < b.end && b.start < a.end;

/** The key of the token whose own value is written at `span`, when there's one. */
export function ownerOf(tokens: EditableToken[], span: CodeSpan): string | undefined {
  const owners = tokens.filter((token) =>
    token.values.some((v) => v.location && !v.location.via?.length && overlaps(v.location, span)),
  );
  const [only] = owners;
  return owners.length === 1 ? only?.key : undefined;
}

/** The other token values an edit at `span` would change too: those written there, and those whose names lead there. */
export function sharers(tokens: EditableToken[], value: TokenValue, span: CodeSpan): string[] {
  return tokens.flatMap((token) =>
    token.values
      .filter((other) => other !== value && other.location)
      .filter(({ location }) => [...(location?.via ?? []), location].some((s) => s && overlaps(s, span)))
      .map((other) => valueLabel(token.key, other.property)),
  );
}

/** The other token values the code works out from `token` by its name (`Faded = Brand.copy(alpha = 0.5f)`), which
 * an edit to it would change too: those written as an expression naming it, and those tokens.json doesn't say where
 * are written whose declaration names it. */
export async function dependents(
  tokens: EditableToken[],
  token: EditableToken,
  read: ReadSource,
): Promise<string[]> {
  const names = [...token.names, token.key.slice(token.key.lastIndexOf("/") + 1)].flatMap((name) => {
    const part = LAST_PART.exec(name)?.[1];
    return part && IDENTIFIER.test(part) ? [part] : [];
  });
  if (names.length === 0) return [];
  const found = await Promise.all(
    tokens
      .filter((other) => other !== token)
      .flatMap((other) =>
        other.values.map(async (value) => {
          const code = await codeOf(other, value, read);
          const label = valueLabel(other.key, value.property);
          if (code === undefined) return [];
          return code === null || names.some((name) => namesWord(code, name)) ? [label] : [];
        }),
      ),
  );
  return found.flat();
}

/** The code working out `value`: its expression, or its token's declaration when tokens.json doesn't say where it's
 * written, without the token's own name; undefined when it's a literal or there's no telling where it is, and null
 * when its file can't be read. */
async function codeOf(
  token: EditableToken,
  value: TokenValue,
  read: ReadSource,
): Promise<string | null | undefined> {
  const { location } = value;
  if (location && location.kind !== "expression") return undefined;
  const span = location ?? token.declared;
  if (!span) return undefined;
  const text = textOf(await read(span.file));
  if (text === undefined) return null;
  if (location) return text.slice(location.start, location.end);
  const statement = statementAt(text, span.line);
  const own = token.names
    .map((name) => LAST_PART.exec(name)?.[1] ?? "")
    .find((name) => name && statement.includes(name));
  return own ? statement.slice(statement.indexOf(own) + own.length) : statement;
}
