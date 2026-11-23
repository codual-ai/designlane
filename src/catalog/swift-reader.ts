/** The catalog's reading of SwiftUI views: a view struct's stored properties are its parameters. */

import { bracketTree } from "../frameworks/source-text.js";
import { type StructDecl, structs } from "../frameworks/swift-source.js";
import type { SwiftSource } from "../frameworks/swiftui-sources.js";
import {
  type CallSyntax,
  type ComponentReader,
  callPlacements,
  type Declaration,
  indexed,
  lineIndex,
  onLine,
  perSource,
  type Range,
} from "./reader.js";

/** A stored or computed property, read up to its type: attributes, a few modifiers, `let` or `var`, name, type, and
 * what follows (`=` for a value, `{` for a computed one). Modifiers are bounded, so a long run of words stays linear. */
const PROPERTY =
  /(?<![\w.@])((?:@\w+(?:\([^()\n]*\))?\s+)*)((?:\w+(?:\(set\))?\s+){0,4}?)\b(let|var)\s+(\w+)\s*(?::([^=\n{;]*))?(=|\{)?/dg;
/** Wrappers holding a view's own state, which the code using the view doesn't pass. */
const OWN_STATE =
  /@(?:State|StateObject|Environment|EnvironmentObject|FocusState|Namespace|AppStorage|SceneStorage|Query|FetchRequest|GestureState|ScaledMetric)\b/;
/** Wrappers whose value the code using the view passes in, shown with the parameter. */
const PASSED_WRAPPER = /@(?:Binding|ObservedObject|Bindable)\b/;
const NOT_A_PARAMETER = /\b(?:private|fileprivate|static|class)\b/;
/** A capitalised name being built (`Row(`, `Row {`, `Row<T>(`, `Row.init(`), possibly a view placed in another; and
 * the keywords that make it a declaration instead (`extension Row {`). */
const SWIFT_CALLS: CallSyntax = {
  call: /(?<![\w.])([A-Z]\w*)(?:<[^<>\n]{0,80}>)?(?:\.init)?\s*[({]/g,
  declared: /\b(?:struct|class|extension|enum|protocol|actor|typealias)\s+$/,
  declarationChars: 20,
};

// Shared by every reader of the same sources: the catalog and the drift report.
const declared = perSource((source: SwiftSource) => structs(source.code));
/** `PreviewProvider` structs; `#Preview` blocks are blanked in the code already. */
const previewsOf = perSource((source: SwiftSource): Range[] =>
  declared(source)
    .filter((s) => s.conformances.includes("PreviewProvider"))
    .map((s) => [s.start, s.close + 1]),
);

export function swiftReader(files: SwiftSource[]): ComponentReader {
  const enclosingOf = perSource((source: SwiftSource) => bracketTree(source.code).enclosing);
  const byFile = new Map(files.map((f) => [f.rel, f]));
  const linesOf = perSource((source: SwiftSource) => lineIndex(source.text));
  // Each file's structs by name, so finding one view's costs its name's, not the file's whole list.
  const namedIn = perSource((source: SwiftSource) => indexed(declared(source), (s) => s.name));
  return {
    declaration(view) {
      const source = byFile.get(view.file);
      if (!source) return undefined;
      const candidates = namedIn(source).get(view.name) ?? [];
      const found = onLine(candidates, view, linesOf(source), (s) => [s.start, s.open]);
      return found && declarationOf(source, found, enclosingOf(source));
    },
    placements(names) {
      return files.flatMap((source) => callPlacements(source, previewsOf(source), names, SWIFT_CALLS));
    },
    previews(rel) {
      const source = byFile.get(rel);
      return source ? previewsOf(source) : [];
    },
  };
}

function declarationOf(source: SwiftSource, decl: StructDecl, enclosing: Int32Array): Declaration {
  const body = source.code.slice(decl.open + 1, decl.close);
  const params: string[] = [];
  for (const m of body.matchAll(PROPERTY)) {
    const keyword = decl.open + 1 + (m.indices?.[3]?.[0] ?? 0);
    if (enclosing[keyword] !== decl.open) continue;
    const parameter = parameterOf(m);
    if (parameter) params.push(parameter);
  }
  return { start: decl.start, end: decl.close + 1, params };
}

/** The property as a parameter the code using the view passes, or undefined when it isn't one: private, static,
 * computed, the view's own state, or a `let` already given its value. */
function parameterOf(m: RegExpExecArray): string | undefined {
  const [, attributes = "", modifiers = "", keyword, name = "", type = "", after] = m;
  if (NOT_A_PARAMETER.test(modifiers) || OWN_STATE.test(attributes) || after === "{") return undefined;
  if (keyword === "let" && after === "=") return undefined;
  const wrapper = attributes.match(PASSED_WRAPPER)?.[0];
  const typed = type.trim() ? `${name}: ${type.trim().replace(/\s+/g, " ")}` : name;
  return wrapper ? `${wrapper} ${typed}` : typed;
}
