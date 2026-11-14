/** What the Swift expression reader produces. Every expression knows its span in the source. */

interface Span {
  start: number;
  end: number;
}

export type Expression = Span &
  (
    | { kind: "name"; name: string }
    /** `token` is where the literal itself is written; the span grows to take in parentheses, `(17)`. */
    | { kind: "number"; value: number; token: Span }
    | { kind: "string"; value: string; interpolated: boolean; token: Span }
    /** `base.name`, or `.name` with no base: an implicit member like `.headline`. `dot` is where its `.` is. */
    | { kind: "member"; base?: Expression; name: string; dot: number }
    | { kind: "call"; callee: Expression; args: Argument[] }
    | { kind: "subscript"; base: Expression; args: Argument[] }
    | { kind: "ternary"; condition: Expression; then: Expression; otherwise: Expression }
    | { kind: "binary"; operator: string; left: Expression; right: Expression }
    | { kind: "prefix"; operator: string; operand: Expression }
    /** `x!` or `x?`. */
    | { kind: "postfix"; operator: string; operand: Expression }
    /** Code the reader keeps whole without modelling: a closure, a collection literal, a key path, a type. */
    | { kind: "opaque" }
  );

export interface Argument {
  label?: string;
  value: Expression;
}
