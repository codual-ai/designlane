/** The reader behind `swift-expressions.ts`: a precedence-climbing reader over tokens, bounded by the bracket it
 * starts in. */

import { directiveAt } from "./swift-directives.js";
import type { Argument, Expression } from "./swift-expression-types.js";
import {
  ACCESSORS,
  CASTING,
  DIRECTIVES,
  EFFECT_KEYWORDS,
  isAssignment,
  isAttachedMark,
  PROPERTY_OBSERVERS,
  precedenceOf,
  STATEMENT_KEYWORDS,
  TERNARY,
} from "./swift-operators.js";
import { newReadState, type ReadState, TokenCursor } from "./swift-token-cursor.js";
import { CLOSES, closeOf, type SwiftTokens, stringValue, type Token } from "./swift-tokens.js";
import { genericEnd, typeEnd } from "./swift-type-spans.js";

/** Nesting deeper than this is read as one opaque span, so hostile input can't exhaust the stack or make reads that
 * start inside one another add up. Real font and colour calls nest about five deep. */
const MAX_DEPTH = 16;

export interface ReaderOptions {
  /** False where a `{` after the expression opens a body (`if x {`, `var accent: Color {`) rather than passing a
   * trailing closure. */
  trailingClosures?: boolean;
  /** The state of the read this reader is part of, for the readers it starts for arguments. */
  read?: ReadState;
}

/** Reads expressions from tokens, from `at` up to (not including) `limit`. */
export class Reader extends TokenCursor {
  private readonly trailingClosuresAllowed: boolean;

  constructor(file: SwiftTokens, at: number, limit: number, options: ReaderOptions = {}) {
    super(file, at, limit, options.read ?? newReadState());
    this.trailingClosuresAllowed = options.trailingClosures ?? true;
  }

  expression(minimum = 0): Expression | undefined {
    this.read.depth++;
    try {
      if (this.read.depth > MAX_DEPTH) return this.peek() && this.opaqueFrom(this.at);
      const start = this.at;
      let left = this.unary();
      while (left) {
        const next = this.peek();
        if (!next) break;
        if (next.text === "?" && next.spaceBefore) {
          // A spaced `?` is always a ternary, read by whichever level is low enough to hold it.
          if (minimum > TERNARY) break;
          left = this.ternary(left);
        } else if ((next.text === "as" || next.text === "is") && minimum <= CASTING) left = this.cast(left);
        else if (
          next.kind === "operator" &&
          !isAssignment(next.text) &&
          next.spaceBefore === this.spaceAfter(this.at)
        ) {
          const precedence = precedenceOf(next.text);
          // A custom operator's precedence isn't known, so the expression stops before it rather than guess.
          if (precedence === undefined || precedence < minimum) break;
          const operator = this.at;
          this.advance();
          // `??` groups to the right: `a ?? b ?? c` is `a ?? (b ?? c)`.
          const right = this.expression(next.text === "??" ? precedence : precedence + 1);
          if (!right) {
            // `colors[1...]`: an operator with nothing after it applies to what came before.
            this.moveTo(operator + 1);
            left = { kind: "postfix", operator: next.text, operand: left, start: left.start, end: next.end };
            break;
          }
          left = { kind: "binary", operator: next.text, left, right, start: left.start, end: right.end };
        } else break;
      }
      if (this.stopped) return this.opaqueBetweenTokens(start, Math.max(this.at, start + 1));
      return left;
    } finally {
      this.read.depth--;
    }
  }

  /** Prefix operators, read in a loop so a long run of them can't exhaust the stack. */
  private unary(): Expression | undefined {
    while (EFFECT_KEYWORDS.has(this.peek()?.text ?? "")) {
      this.advance();
      if (isAttachedMark(this.peek())) this.advance();
    }
    const prefixes: Token[] = [];
    for (
      let t = this.peek();
      t?.kind === "operator" && t.text !== "?" && !this.spaceAfter(this.at);
      t = this.peek()
    ) {
      prefixes.push(t);
      this.advance();
    }
    const primary = this.primary();
    if (!primary) return undefined;
    let e = this.postfix(primary);
    for (const op of prefixes.reverse())
      e = { kind: "prefix", operator: op.text, operand: e, start: op.start, end: e.end };
    return e;
  }

  private primary(): Expression | undefined {
    const token = this.peek();
    if (!token || CLOSES.has(token.text) || token.text === "," || token.text === ":") return undefined;
    if (token.kind === "name" && STATEMENT_KEYWORDS.has(token.text)) return undefined;
    const at = this.at;
    if (token.kind === "name" && (token.text === "if" || token.text === "switch")) return this.branching(at);
    this.advance();
    if (token.kind === "name") return { kind: "name", name: token.text, start: token.start, end: token.end };
    const literal = { start: token.start, end: token.end };
    if (token.kind === "number") {
      const value = Number(token.text.replace(/_/g, ""));
      // A hexadecimal float (`0x1p3`) isn't read; it stays whole rather than becoming a wrong number.
      if (!Number.isFinite(value)) return this.opaqueBetweenTokens(at, this.at);
      return { kind: "number", value, token: literal, ...literal };
    }
    if (token.kind === "string")
      return { kind: "string", ...stringValue(token.text), token: literal, ...literal };
    if (token.text === "." && this.peek()?.kind === "name") {
      const name = this.take();
      return { kind: "member", name: name.text, dot: token.start, start: token.start, end: name.end };
    }
    if (token.text === "#" && this.peek()?.kind === "name" && !this.peek()?.spaceBefore) {
      // `#if` and the like start a directive, not an expression.
      if (DIRECTIVES.has(this.peek()?.text ?? "")) {
        this.moveTo(at);
        return undefined;
      }
      const name = this.take();
      return { kind: "name", name: `#${name.text}`, start: token.start, end: name.end };
    }
    if (token.text === "(") return this.parenthesized(at);
    if (token.text === "\\") {
      // A key path, `\Font.body`: a reference to a member, not its value.
      while (
        this.peek() &&
        !this.peek()?.spaceBefore &&
        (this.peek()?.kind === "name" || this.peek()?.text === ".")
      )
        this.advance();
      return this.opaqueBetweenTokens(at, this.at);
    }
    return this.opaqueFrom(at);
  }

  /** `(x)` is `x`; a tuple `(a, b)` is kept whole. */
  private parenthesized(open: number): Expression {
    const args = this.arguments(open, ")");
    const [only] = args;
    const span = { start: this.file.tokens[open]?.start ?? 0, end: this.previousEnd() };
    return args.length === 1 && only && only.label === undefined
      ? { ...only.value, ...span }
      : { kind: "opaque", ...span };
  }

  private postfix(expression: Expression): Expression {
    let e = expression;
    // Only one run of trailing closures follows a call: `x {} {}` is a call and then a stray block.
    let closures = false;
    for (let token = this.peek(); token; token = this.peek()) {
      const sameLine = !token.newlineBefore;
      const directive = directiveAt(this.file, this.at, this.limit);
      if (directive.kind === "alternatives") {
        this.read.unreadable = true;
        break;
      }
      if (directive.kind === "skip") {
        this.moveTo(directive.to);
        continue;
      }
      const generics = token.text.startsWith("<") && (e.kind === "name" || e.kind === "member");
      const genericsEnd = generics ? genericEnd(this.file, this.at, this.limit) : undefined;
      if (genericsEnd !== undefined) {
        // `Array<Color>`: the type's name stands for it, its generic arguments kept within its span.
        this.moveTo(genericsEnd);
        e = { ...e, end: this.previousEnd() };
      } else if (
        token.text === "." &&
        (this.peekAt(1)?.kind === "name" || this.peekAt(1)?.kind === "number")
      ) {
        this.advance();
        const name = this.take();
        e = { kind: "member", base: e, name: name.text, dot: token.start, start: e.start, end: name.end };
        closures = false;
      } else if (token.text === "(" && sameLine && !token.spaceBefore) {
        const open = this.at;
        this.advance();
        const args = this.arguments(open, ")");
        e = { kind: "call", callee: e, args, start: e.start, end: this.previousEnd() };
      } else if (token.text === "[" && sameLine && !token.spaceBefore) {
        const open = this.at;
        this.advance();
        const args = this.arguments(open, "]");
        e = { kind: "subscript", base: e, args, start: e.start, end: this.previousEnd() };
      } else if (
        token.text === "{" &&
        sameLine &&
        this.trailingClosuresAllowed &&
        !closures &&
        !PROPERTY_OBSERVERS.has(this.peekAt(1)?.text ?? "") &&
        !(e.kind === "name" && ACCESSORS.has(e.name))
      ) {
        e = this.trailingClosures(e);
        closures = true;
      } else if (isAttachedMark(token)) {
        this.advance();
        e = { kind: "postfix", operator: token.text, operand: e, start: e.start, end: token.end };
      } else break;
    }
    return e;
  }

  /** `x { … }` and `x { … } label: { … }`: closures passed after the call, kept whole. */
  private trailingClosures(callee: Expression): Expression {
    const args = callee.kind === "call" ? [...callee.args] : [];
    const base = callee.kind === "call" ? callee.callee : callee;
    let label: string | undefined;
    while (this.peek()?.text === "{") {
      args.push({ ...(label ? { label } : {}), value: this.opaqueFrom(this.at) });
      const next = this.peek();
      const labelled = next?.kind === "name" && !next.newlineBefore && this.peekAt(1)?.text === ":";
      if (!labelled || this.peekAt(2)?.text !== "{") break;
      label = next.text;
      this.advance(2);
    }
    return { kind: "call", callee: base, args, start: callee.start, end: this.previousEnd() };
  }

  /** The arguments of the call whose `(` is at `open`, or undefined when the read stopped before reading them all. */
  argumentList(open: number): Argument[] | undefined {
    const args = this.arguments(open, ")");
    return this.stopped ? undefined : args;
  }

  /** The labelled arguments between the bracket at `open` and its close, leaving the reader after the close. A
   * malformed argument is kept whole up to the next comma. */
  private arguments(open: number, closer: string): Argument[] {
    const close = Math.min(closeOf(this.file, open), this.limit);
    const inner = new Reader(this.file, open + 1, close, { read: this.read });
    const args: Argument[] = [];
    while (inner.at < close) {
      const label = inner.label();
      const from = inner.at;
      const value = inner.expression();
      const whole = value !== undefined && (!inner.peek() || inner.peek()?.text === ",");
      if (!whole) inner.skipToComma();
      args.push({
        ...(label ? { label } : {}),
        value: whole ? value : inner.opaqueBetweenTokens(from, inner.at),
      });
      if (inner.peek()?.text === ",") inner.advance();
      else break;
    }
    this.moveTo(this.file.tokens[close]?.text === closer ? close + 1 : close);
    return args;
  }

  private label(): string | undefined {
    const [name, colon] = [this.peek(), this.peekAt(1)];
    if (name?.kind !== "name" || colon?.text !== ":") return undefined;
    this.advance(2);
    return name.text;
  }

  private ternary(condition: Expression): Expression {
    this.advance();
    const then = this.expression(TERNARY);
    if (!then || this.peek()?.text !== ":") return this.opaqueSince(condition.start);
    this.advance();
    const otherwise = this.expression(TERNARY);
    if (!otherwise) return this.opaqueSince(condition.start);
    return { kind: "ternary", condition, then, otherwise, start: condition.start, end: otherwise.end };
  }

  /** `x as? UIFont`: the type is kept whole. */
  private cast(left: Expression): Expression {
    let operator = this.take().text;
    if (isAttachedMark(this.peek())) operator += this.take().text;
    const typeStart = this.at;
    this.moveTo(typeEnd(this.file, typeStart, this.limit));
    const right = this.opaqueBetweenTokens(typeStart, this.at);
    return { kind: "binary", operator, left, right, start: left.start, end: right.end };
  }
}
