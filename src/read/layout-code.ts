/**
 * The elements SwiftUI and Compose code writes, read from its blanked code (comments and strings as spaces):
 * `VStack { … }` and `Column(…) { … }` with what their blocks hold, `if` and `switch` or `when` with each branch,
 * `ForEach`, `items` and `forEach` loops, and SwiftUI's view properties (`var header: some View`) in place.
 */

import type { BracketTree } from "../frameworks/source-text.js";
import type { Element } from "./layout-tree.js";
import { ReadingNotes } from "./reading-notes.js";

export interface CodeReading {
  language: "swift" | "kotlin";
  code: string;
  tree: BracketTree;
  /** SwiftUI's view properties and functions of the screen's own struct, by name: the block each one's body is. */
  views?: ReadonlyMap<string, [open: number, close: number]>;
}

/** How deep blocks are read; code nested deeper has no layout, so hostile code can't overflow the stack. */
const MAX_DEPTH = 100;
const WORD = /[A-Za-z_]\w*/y;
/** Compose lambdas passed by name that run code rather than hold elements: `onClick = { … }`, `key = { it.id }`. */
const ACTION = /^(?:on[A-Z]\w*|key|contentType|span|factory|update)$/;
/** Compose calls looping over a list's items, each writing what its lambda does. */
const KOTLIN_LOOPS = new Set(["items", "itemsIndexed", "forEach", "forEachIndexed", "repeat"]);
/** Compose's `LazyColumn` headers, each a section. */
const KOTLIN_SECTIONS = new Set(["stickyHeader"]);
/** Compose calls whose block runs code, shows nothing: `remember(ctx) { Intent(…) }`, `scope.launch { … }`. */
const KOTLIN_RUNS =
  /^(?:remember\w*|derivedStateOf|snapshotFlow|produceState|launch|async|withContext|runCatching)$/;
/** What comes before a `case` that's a pattern, not a branch: `if case`, `guard case`, `if let a, case`. */
const PATTERN_CASE = /(?:\b(?:if|guard|while|for)|,)\s*$/;
/** How much of the file's code view properties may be read in place, in all, as a multiple of its length: a property
 * placed in many places is read again at each, so this keeps properties placing properties linear. */
const MAX_INLINED = 50;
/** Statements that declare, rather than write, elements: read past to their line's end. */
const DECLARATIONS = new Set(["let", "var", "val", "guard", "typealias"]);
/** Modifiers whose block or call adds an element beside the one they modify. */
const SWIFT_ADDING = new Map<string, Element["kind"]>([
  ["toolbar", "toolbar"],
  ["searchable", "input"],
]);

interface Step {
  elements: Element[];
  next: number;
}

export class CodeElements {
  /** The view properties being read in place, so one placing itself stops. */
  private readonly inlining = new Set<string>();
  /** How much code view properties have had read in place. */
  private inlined = 0;
  /** The file's `#if`s, matched once. */
  private compiled: Map<number, number[]> | undefined;
  /** `notes` gets why a limit stopped the reading short (nesting too deep, too much read in place), and its issues. */
  constructor(
    private readonly r: CodeReading,
    readonly notes = new ReadingNotes(),
  ) {}

  /** The elements written between `from` and `to`, `depth` blocks in. */
  between(from: number, to: number, depth = 0): Element[] {
    const out: Element[] = [];
    if (depth > MAX_DEPTH) {
      this.notes.stop("too-deep", from);
      return out;
    }
    let j = from;
    while (j < to) {
      const step = this.step(j, to, depth);
      out.push(...step.elements);
      j = Math.max(step.next, j + 1);
    }
    return out;
  }

  /** The block opening at `open`, read between its braces. */
  private block(open: number, depth: number): Element[] {
    const close = this.close(open);
    return this.between(open + 1, close, depth + 1);
  }

  private close(open: number): number {
    return this.r.tree.closeOf.get(open) ?? this.r.code.length;
  }

  private space(j: number, newlines = true): number {
    const { code } = this.r;
    let k = j;
    while (k < code.length && (newlines ? /\s/ : /[ \t]/).test(code[k] ?? "")) k++;
    return k;
  }

  private wordAt(j: number): string | undefined {
    WORD.lastIndex = j;
    return WORD.exec(this.r.code)?.[0];
  }

  /** Past the line `j` is on, skipping brackets, so a statement written over several lines is read past whole. */
  private lineEnd(j: number, to: number): number {
    const { code } = this.r;
    let k = j;
    while (k < to && code[k] !== "\n" && code[k] !== ";") k = this.past(k);
    return k;
  }

  /** Past the expression a `throw` throws (`IllegalStateException(m)`), which shows nothing: names, members and their
   * calls, so what follows on its line (`else Text(…)`) is still read. */
  private pastExpression(from: number): number {
    const { code } = this.r;
    let k = this.space(from, false);
    for (;;) {
      const word = this.wordAt(k);
      if (word) k += word.length;
      else if (code[k] === "(") k = this.close(k) + 1;
      else if (code[k] === "." && this.wordAt(k + 1)) k++;
      else return k;
    }
  }

  /** Past the character at `k`, or the whole bracket opening there. */
  private past(k: number): number {
    const c = this.r.code[k];
    return c === "(" || c === "{" ? this.close(k) + 1 : k + 1;
  }

  /** What's written at `j`: an element, a statement read past, or one character. */
  private step(j: number, to: number, depth: number): Step {
    const { code } = this.r;
    if (depth > MAX_DEPTH) {
      this.notes.stop("too-deep", j);
      return { elements: [], next: this.lineEnd(j, to) };
    }
    const c = code[j] ?? "";
    if (/\s/.test(c)) return { elements: [], next: j + 1 };
    if (c === "(" || c === "{") return { elements: [], next: this.close(j) + 1 };
    const word = this.wordAt(j);
    if (!word) return { elements: [], next: j + 1 };
    const before = code[j - 1] ?? "";
    // A member (`.padding`), an attribute or annotation (`@ViewBuilder`), or a compiler directive (`#if`).
    if (before === "." || before === "@" || /\w/.test(before)) return { elements: [], next: j + word.length };
    if (before === "#")
      return word === "if" && this.r.language === "swift"
        ? this.compiledIf(j, to, depth)
        : { elements: [], next: this.lineEnd(j, to) };
    if (word === "if") return this.conditional(j, to, depth);
    if (word === "switch" || word === "when") return this.choice(j, depth);
    if (word === "for" && this.r.language === "kotlin") return this.forLoop(j, to, depth);
    if (word === "throw") return { elements: [], next: this.pastExpression(j + word.length) };
    if (DECLARATIONS.has(word)) return { elements: [], next: this.lineEnd(j, to) };
    if (/^[A-Z]/.test(word)) return this.call(j, word, to, depth);
    return this.lowercase(j, to, depth);
  }

  /** One element or statement from `j`, a level in, for a branch written without braces (`if (a) Text(x)`). */
  private one(j: number, to: number, depth: number): Step {
    return this.step(this.space(j), to, depth + 1);
  }

  /** `if … { } else if … { } else { }`, each branch's elements; in Kotlin a branch may be one element unbraced. */
  private conditional(j: number, to: number, depth: number): Step {
    const branches: Element[][] = [];
    let k = j;
    for (;;) {
      k += 2; // `if`
      const { open, after } = this.condition(k, to);
      if (open === undefined) {
        const step = this.one(after, to, depth);
        branches.push(step.elements);
        k = step.next;
      } else {
        branches.push(this.block(open, depth));
        k = this.close(open) + 1;
      }
      const e = this.space(k);
      if (this.wordAt(e) !== "else") break;
      const f = this.space(e + 4);
      if (this.wordAt(f) === "if") {
        k = f;
        continue;
      }
      if (this.r.code[f] === "{") {
        branches.push(this.block(f, depth));
        k = this.close(f) + 1;
      } else {
        const step = this.one(f, to, depth);
        branches.push(step.elements);
        k = step.next;
      }
      break;
    }
    return {
      elements: [{ name: "", kind: "conditional", start: j, end: k, children: [], branches }],
      next: k,
    };
  }

  /** `#if os(iOS) … #elseif … #else … #endif`: a decision made when the app is built, each clause a branch. One that
   * only adds modifiers (`#if os(iOS) .padding() #endif`) writes no elements, so it's no decision in the layout; one
   * whose `#endif` is past the block being read (around some of a `switch`'s cases) is read as written. */
  private compiledIf(j: number, to: number, depth: number): Step {
    const directive = this.directives().get(j - 1);
    const end = directive?.at(-1);
    // An `#if` around more than this block holds (some of a `switch`'s cases), or left open: each side is read where
    // it's written.
    if (!directive || end === undefined || end >= to) {
      const next = this.lineEnd(j, to);
      this.notes.issue({ kind: "if-as-written", start: j - 1, end: next });
      return { elements: [], next };
    }
    const next = this.lineEnd(end + 1, to);
    const starts = [j, ...directive.slice(0, -1)].map((at) => this.lineEnd(at + 1, to));
    const branches = starts.map((from, i) => this.between(from, directive[i] ?? from, depth + 1));
    if (branches.every((b) => b.length === 0)) return { elements: [], next };
    return {
      elements: [{ name: "", kind: "conditional", start: j - 1, end: next, children: [], branches }],
      next,
    };
  }

  /** For each `#if` of the file, where its `#elseif`s, `#else` and `#endif` are written, matched once for the file. */
  private directives(): Map<number, number[]> {
    if (this.compiled) return this.compiled;
    const out = new Map<number, number[]>();
    const open: number[][] = [];
    const starts: number[] = [];
    for (const m of this.r.code.matchAll(/#(if|elseif|else|endif)\b/g)) {
      const at = m.index ?? 0;
      if (m[1] === "if") {
        starts.push(at);
        open.push([]);
        continue;
      }
      const clauses = open.at(-1);
      if (!clauses) continue;
      clauses.push(at);
      if (m[1] === "endif") {
        out.set(starts.pop() ?? 0, clauses);
        open.pop();
      }
    }
    this.compiled = out;
    return out;
  }

  /** After `if`, its condition: where its block opens, or, in Kotlin, where its unbraced branch starts. */
  private condition(k: number, to: number): { open?: number; after: number } {
    const { code } = this.r;
    if (this.r.language === "kotlin") {
      const paren = this.space(k);
      const after = code[paren] === "(" ? this.close(paren) + 1 : paren;
      const brace = this.space(after);
      return code[brace] === "{" ? { open: brace, after } : { after };
    }
    // Swift's condition runs to its block, past the brackets of calls and closures in it.
    let m = k;
    while (m < to && code[m] !== "{") m = code[m] === "(" ? this.close(m) + 1 : m + 1;
    return m < to ? { open: m, after: m } : { after: to };
  }

  /** `switch x { case …: … }` or `when (x) { a -> … }`, each case's elements. */
  private choice(j: number, depth: number): Step {
    const { code } = this.r;
    let open = j;
    while (open < code.length && code[open] !== "{" && code[open] !== "\n")
      open = code[open] === "(" ? this.close(open) + 1 : open + 1;
    if (code[open] !== "{") return { elements: [], next: open };
    const close = this.close(open);
    const branches =
      this.r.language === "swift" ? this.cases(open, close, depth) : this.arrows(open, close, depth);
    return {
      elements: [{ name: "", kind: "conditional", start: j, end: close + 1, children: [], branches }],
      next: close + 1,
    };
  }

  /** The offsets directly inside the block at `open` where `test` holds. */
  private topLevel(open: number, close: number, test: (k: number) => boolean): number[] {
    const out: number[] = [];
    for (let k = open + 1; k < close; k = this.past(k)) if (test(k)) out.push(k);
    return out;
  }

  private cases(open: number, close: number, depth: number): Element[][] {
    const { code } = this.r;
    const starts = this.topLevel(open, close, (k) => {
      if (/\w/.test(code[k - 1] ?? "")) return false;
      const word = this.wordAt(k);
      // Not the `case` of a pattern (`if case .x = y`, `guard let a, case …`).
      return (
        word === "default" || (word === "case" && !PATTERN_CASE.test(code.slice(Math.max(0, k - 40), k)))
      );
    });
    // An `#if` before the first case is around cases, not in one: each is read as written.
    for (const m of code.slice(open + 1, starts[0] ?? close).matchAll(/#if\b/g)) {
      const at = open + 1 + (m.index ?? 0);
      this.notes.issue({ kind: "if-as-written", start: at, end: this.lineEnd(at + 1, close) });
    }
    return starts.map((start, i) => {
      const end = starts[i + 1] ?? close;
      const colon = this.topLevel(start - 1, end, (k) => code[k] === ":" && code[k + 1] !== ":")[0] ?? end;
      return this.between(colon + 1, end, depth + 1);
    });
  }

  private arrows(open: number, close: number, depth: number): Element[][] {
    const { code } = this.r;
    const arrows = this.topLevel(open, close, (k) => code[k] === "-" && code[k + 1] === ">");
    return arrows.map((arrow) => {
      const k = this.space(arrow + 2);
      return code[k] === "{" ? this.block(k, depth) : this.one(k, close, depth).elements;
    });
  }

  /** Kotlin's `for (x in list) { … }`, a repeat of what its block writes. */
  private forLoop(j: number, to: number, depth: number): Step {
    const { code } = this.r;
    const paren = this.space(j + 3);
    if (code[paren] !== "(") return { elements: [], next: j + 3 };
    const k = this.space(this.close(paren) + 1);
    const item =
      code[k] === "{" ? { elements: this.block(k, depth), next: this.close(k) + 1 } : this.one(k, to, depth);
    return {
      elements: [
        { name: "", kind: "repeat", start: j, end: item.next, children: [], branches: [item.elements] },
      ],
      next: item.next,
    };
  }

  /** A capitalised name built: `VStack { … }`, `Column(modifier = …) { … }`, `Text(t).font(.title)`, `Color.red`. */
  private call(j: number, written: string, to: number, depth: number): Step {
    const { code, language } = this.r;
    let k = j + written.length;
    // A type named through another (`Theme.Card { … }`) goes by its own name.
    let name = written;
    for (let inner = this.dottedType(k); inner !== undefined; inner = this.dottedType(k)) {
      name = inner;
      k += 1 + inner.length;
    }
    // Type arguments: `ScrollViewReader<Content>`, `AnimatedContent<State>(…)`.
    if (code[k] === "<") {
      const close = code.slice(k, k + 100).indexOf(">");
      if (close !== -1) k += close + 1;
    }
    let args: [number, number] | undefined;
    if (code[k] === "(") {
      args = [k, this.close(k)];
      k = args[1] + 1;
    }
    const blocks: number[] = [];
    // A trailing block may start on the next line in Swift, and in Kotlin after a name not called.
    const trailing = this.space(k, language === "swift" || !args);
    if (code[trailing] === "{") {
      blocks.push(trailing);
      k = this.close(trailing) + 1;
      // SwiftUI's further trailing closures: `} label: { … }`.
      for (let more = this.labelled(k); more !== undefined; more = this.labelled(k)) {
        blocks.push(more);
        k = this.close(more) + 1;
      }
    }
    // A name neither called nor given a block isn't an element (a type, a constant), unless it's SwiftUI's view
    // constant (`Color.red`); a member called (`Analytics.track(…)`) is code run, not shown.
    if (!args && blocks.length === 0 && !this.viewConstant(k)) return { elements: [], next: k };
    const children: Element[] = [];
    if (args && language === "kotlin") children.push(...this.slots(args, depth));
    // `AnyView(Text(t))` holds the view it's given.
    if (args && language === "swift" && name === "AnyView")
      children.push(...this.between(args[0] + 1, args[1], depth + 1));
    for (const open of blocks) children.push(...this.block(open, depth));
    const added: Element[] = [];
    k = this.modifiers(k, to, depth, added);
    const element: Element = { name, start: j, end: k, children };
    if (name === "ForEach") return this.repeat(element, added);
    // `List(items) { item in … }` writes its block once per item; `List(selection: $s) { … }` once.
    if (name === "List" && language === "swift" && args && blocks.length > 0 && this.dataFirst(args))
      element.children = [{ ...element, kind: "repeat", children: [], branches: [children] }];
    if (language === "kotlin" && args && /\b(?:vertical|horizontal)Scroll\s*\(/.test(code.slice(...args)))
      element.kind = "scroll";
    return { elements: [element, ...added], next: k };
  }

  /** The capitalised name after a `.` at `k` (`Card` in `Theme.Card`), or undefined. */
  private dottedType(k: number): string | undefined {
    if (this.r.code[k] !== ".") return undefined;
    const inner = this.wordAt(k + 1);
    return inner !== undefined && /^[A-Z]/.test(inner) ? inner : undefined;
  }

  /** Whether a call's first argument is unlabelled, the data it lays out: `List(items)`, not `List(selection: $s)`. */
  private dataFirst([open, close]: [number, number]): boolean {
    const first = this.r.code.slice(open + 1, Math.min(close, open + 200));
    return /^\s*[\w$\\.[(]/.test(first) && !/^\s*\w+\s*:/.test(first);
  }

  /** Whether a SwiftUI name is a constant view, `Color.red`, at the `.` at `k`: a member not called. */
  private viewConstant(k: number): boolean {
    const { code } = this.r;
    if (this.r.language !== "swift" || code[k] !== ".") return false;
    const member = this.wordAt(k + 1);
    return member !== undefined && code[k + 1 + member.length] !== "(";
  }

  /** A loop's element: a repeat of what its block writes. */
  private repeat(element: Element, added: Element[]): Step {
    const loop: Element = { ...element, kind: "repeat", children: [], branches: [element.children] };
    return { elements: [loop, ...added], next: element.end };
  }

  /** A further trailing closure's block (`label: {`) at `k`, or undefined when there's none. */
  private labelled(k: number): number | undefined {
    if (this.r.language !== "swift") return undefined;
    const m = /^\s*\w+\s*:\s*\{/.exec(this.r.code.slice(k, k + 200));
    return m ? k + m[0].length - 1 : undefined;
  }

  /** The elements of a Compose call's lambdas passed by name, `topBar = { TopAppBar(…) }`, but for actions. */
  private slots([open, close]: [number, number], depth: number): Element[] {
    const { code, tree } = this.r;
    const out: Element[] = [];
    for (const m of code.slice(open, close).matchAll(/(?<!\w)(\w+)\s*=\s*\{/g)) {
      const at = open + (m.index ?? 0);
      const brace = at + m[0].length - 1;
      if (tree.enclosing[at] === open && !ACTION.test(m[1] ?? "")) out.push(...this.block(brace, depth));
    }
    return out;
  }

  /** Past a chain of modifiers (`.padding().toolbar { … }`), adding to `added` the elements a toolbar or a search
   * field puts beside it. */
  private modifiers(from: number, to: number, depth: number, added: Element[]): number {
    const { code } = this.r;
    let k = from;
    for (;;) {
      const dot = this.space(k);
      if (dot >= to || code[dot] !== "." || (code[dot + 1] === "." && code[dot + 2] === ".")) return k;
      const name = this.wordAt(dot + 1);
      if (!name) return k;
      let m = dot + 1 + name.length;
      if (code[m] === "(") m = this.close(m) + 1;
      // A modifier's block may start on the next line: `.toolbar⏎{ … }`.
      const brace = this.space(m, this.r.language === "swift");
      const block = code[brace] === "{" ? brace : undefined;
      if (block !== undefined) m = this.close(block) + 1;
      const adds = this.r.language === "swift" ? SWIFT_ADDING.get(name) : undefined;
      if (adds)
        added.push({
          name: "",
          kind: adds,
          start: dot,
          end: m,
          children: block !== undefined && adds === "toolbar" ? this.block(block, depth) : [],
        });
      k = m;
    }
  }

  /** A SwiftUI view property placed (`header`, `self.header`, `row(item)`), read in place with what its modifiers
   * add, or undefined when `j` isn't one or the file's budget for reading them is spent. */
  private viewProperty(j: number, to: number, depth: number): Step | undefined {
    const { code, views } = this.r;
    let name = this.wordAt(j) ?? "";
    let k = j + name.length;
    if (name === "self" && code[k] === ".") {
      name = this.wordAt(k + 1) ?? "";
      k += 1 + name.length;
    }
    const body = views?.get(name);
    if (!body || this.inlining.has(name)) return undefined;
    const size = body[1] - body[0];
    if (this.inlined + size > code.length * MAX_INLINED) {
      this.notes.stop("too-much-inlined", j);
      return undefined;
    }
    this.inlined += size;
    if (code[k] === "(") k = this.close(k) + 1;
    this.inlining.add(name);
    const elements = this.between(body[0] + 1, body[1], depth + 1);
    this.inlining.delete(name);
    const added: Element[] = [];
    const next = this.modifiers(k, to, depth, added);
    return { elements: [...elements, ...added], next };
  }

  /** A lowercase name: a SwiftUI view property, a Compose loop (`items(list) { … }`, `list.forEach { … }`), a lazy
   * list's item or header, a block shown when a value is there (`user?.let { … }`) or with one in scope
   * (`with(user) { … }`, `key(id) { … }`), or a statement read past. */
  private lowercase(j: number, to: number, depth: number): Step {
    const { code, language } = this.r;
    if (language === "swift") {
      const property = this.viewProperty(j, to, depth);
      if (property) return property;
    }
    let last = "";
    let optional = false;
    let k = j;
    for (;;) {
      const word = this.wordAt(k);
      if (!word) break;
      last = word;
      k += word.length;
      const dot = code[k] === "?" && code[k + 1] === "." ? k + 1 : k;
      if (code[dot] !== "." || !this.wordAt(dot + 1)) break;
      optional = dot !== k;
      k = dot + 1;
    }
    const callEnd = code[k] === "(" ? this.close(k) + 1 : k;
    const brace = this.space(callEnd, false);
    const block = code[brace] === "{" ? brace : undefined;
    const end = block === undefined ? callEnd : this.close(block) + 1;
    if (language !== "kotlin" || block === undefined) return { elements: [], next: end };
    if (KOTLIN_RUNS.test(last)) return { elements: [], next: end };
    const children = this.block(block, depth);
    if (KOTLIN_LOOPS.has(last)) return this.repeat({ name: "", start: j, end, children }, []);
    if (KOTLIN_SECTIONS.has(last))
      return { elements: [{ name: "", kind: "section", start: j, end, children }], next: end };
    if (optional && last === "let")
      return {
        elements: [{ name: "", kind: "conditional", start: j, end, children: [], branches: [children] }],
        next: end,
      };
    return { elements: children, next: end };
  }
}

/** Where a bracket of the code from `from` to `to` is left open or closes one it didn't open, `[` and `]` counted too:
 * the first that closes none, else the last left open, the likeliest to be the one written wrong (`Text("a"` inside a
 * struct, which leaves the struct's `{` open too). Undefined when every one is paired. */
export function unbalancedAt(
  { code, tree }: Pick<CodeReading, "code" | "tree">,
  from: number,
  to: number,
): number | undefined {
  const squares: number[] = [];
  let open: number | undefined;
  for (let k = from; k < to; k++) {
    const c = code[k];
    if ((c === "(" || c === "{") && !tree.closeOf.has(k)) open = k;
    else if ((c === ")" || c === "}") && !tree.openOf.has(k)) return k;
    else if (c === "[") squares.push(k);
    else if (c === "]" && squares.pop() === undefined) return k;
  }
  const square = squares.at(-1);
  return square !== undefined && (open === undefined || square > open) ? square : open;
}
