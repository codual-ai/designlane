/**
 * Reads a Swift expression into its structure: calls with their labelled arguments, member chains
 * (`.title.bold()`), ternaries, `??` fallbacks and arithmetic. Anything it doesn't model, such as closures,
 * collection literals or key paths, is kept as an opaque span, so the reader never guesses. Each read is
 * bounded in moves and nesting, so hostile input stays fast.
 */

import { Reader } from "./swift-expression-reader.js";
import type { Argument, Expression } from "./swift-expression-types.js";
import { TYPE_QUALIFIERS } from "./swift-operators.js";
import { closeOf, type SwiftTokens, type Token, tokenIndexAt } from "./swift-tokens.js";

export type { Argument, Expression } from "./swift-expression-types.js";

/** The expression starting at the first token at or after `offset`, read no further than its enclosing bracket. A read
 * costs at most a fixed number of moves, so to read many calls in one file (every `.font(…)`), read each one's
 * arguments with `argumentsAt`, which stays inside its brackets. */
export function expressionAt(file: SwiftTokens, offset: number): Expression | undefined {
  const index = tokenIndexAt(file, offset);
  if (index === file.tokens.length) return undefined;
  const enclosing = file.enclosing[index] ?? -1;
  const limit = enclosing === -1 ? file.tokens.length : closeOf(file, enclosing);
  return new Reader(file, index, limit, { trailingClosures: !bodyFollows(file, index) }).expression();
}

/** The arguments of the call whose `(` starts at `offset`, or undefined when they can't all be read. */
export function argumentsAt(file: SwiftTokens, offset: number): Argument[] | undefined {
  const index = tokenIndexAt(file, offset);
  // An unclosed `(` has no argument list to finish.
  if (file.tokens[index]?.text !== "(" || file.match[index] === -1) return undefined;
  return new Reader(file, index, file.tokens.length).argumentList(index);
}

/** One link of a member chain, `.weight(.bold)`, and where it's written, from its `.`. */
export interface ChainLink {
  name: string;
  args?: Argument[];
  start: number;
  end: number;
}

/** A member chain from its root: `Font.system(size: 17).weight(.bold)` is `Font`, then `system(…)`, then
 * `weight(…)`; `.title.bold()` has no root. */
export function chain(expression: Expression): { root?: Expression; links: ChainLink[] } {
  const links: ChainLink[] = [];
  let at: Expression | undefined = expression;
  while (at) {
    if (at.kind === "call" && at.callee.kind === "member") {
      const base: Expression | undefined = at.callee.base;
      links.unshift({ name: at.callee.name, args: at.args, start: at.callee.dot, end: at.end });
      at = base;
    } else if (at.kind === "member") {
      links.unshift({ name: at.name, start: at.dot, end: at.end });
      at = at.base;
    } else return { root: at, links };
  }
  return { links };
}

/** Every expression inside `expression`, itself first. */
export function* subexpressions(expression: Expression): Generator<Expression> {
  const pending: Expression[] = [expression];
  for (let next = pending.pop(); next; next = pending.pop()) {
    yield next;
    pending.push(...[...children(next)].reverse());
  }
}

function* children(e: Expression): Generator<Expression> {
  if (e.kind === "member" && e.base) yield e.base;
  if (e.kind === "call") yield e.callee;
  if (e.kind === "subscript") yield e.base;
  if (e.kind === "call" || e.kind === "subscript") for (const a of e.args) yield a.value;
  if (e.kind === "ternary") yield* [e.condition, e.then, e.otherwise];
  if (e.kind === "binary") yield* [e.left, e.right];
  if (e.kind === "prefix" || e.kind === "postfix") yield e.operand;
}

/** Keywords whose `{` opens a body: a condition's, a type declaration's, or a `catch`'s. */
const BODY_KEYWORDS = new Set([
  "if",
  "guard",
  "while",
  "for",
  "switch",
  "catch",
  "extension",
  "struct",
  "class",
  "enum",
  "protocol",
  "actor",
]);
const CASE_LABELS = new Set(["case", "default"]);
/** How far back to look for the statement an expression starts in. */
const MAX_STATEMENT_TOKENS = 256;

/** Whether a `{` after the expression at `index` opens a body rather than passing a trailing closure: in a condition
 * (`if x {`, `if case … {`), a type declaration (`extension Color {`), a `catch`, or after a property's or function's
 * type (`var body: some View {`, `-> Color {`), but not after a `case` label. Inside parentheses a trailing closure
 * is allowed again. Walks back over whole bracketed groups, stopping at the statement's start. */
function bodyFollows(file: SwiftTokens, index: number): boolean {
  const { tokens } = file;
  const typeAt = TYPE_QUALIFIERS.has(tokens[index - 1]?.text ?? "") ? index - 2 : index - 1;
  const before = tokens[typeAt]?.text;
  const open = tokens[file.enclosing[index] ?? -1]?.text;
  if (before === "->") return true;
  const annotated = before === ":" && open !== "(" && open !== "[";
  let caseLabel = false;
  let ternary = false;
  let i = index - 1;
  for (let steps = 0; i >= 0 && steps < MAX_STATEMENT_TOKENS; steps++) {
    const token = tokens[i];
    const directive = tokens[i - 1]?.text === "#" && !token?.spaceBefore;
    if (!token || directive || ["{", "}", ";", "(", "["].includes(token.text)) break;
    // A line break ends the statement unless the line breaks mid-expression (`a &&`, `f(a,`) or goes on (`.b`).
    const next = tokens[i + 1];
    if (next?.newlineBefore && !continuesLine(token, next)) break;
    if (token.text === ")" || token.text === "]") {
      const group = file.match[i] ?? -1;
      if (group === -1) break;
      i = group - 1;
      continue;
    }
    // `a ? b : Button("x") {`: that `:` is a ternary's, not a type annotation's.
    if (token.text === "?" && token.spaceBefore) ternary = true;
    // A `case` is a label unless a condition comes before it in the same statement: `if case .some(let c) = x {`.
    if (token.kind === "name" && CASE_LABELS.has(token.text)) caseLabel = true;
    else if (token.kind === "name" && BODY_KEYWORDS.has(token.text)) return true;
    i--;
  }
  return !caseLabel && !ternary && annotated;
}

const continuesLine = (last: Token, next: Token) =>
  (last.kind === "name" && BODY_KEYWORDS.has(last.text)) ||
  last.kind === "operator" ||
  last.text === "," ||
  next.text === "," ||
  last.text === "." ||
  last.text === ":" ||
  next.kind === "operator" ||
  next.text === ".";
