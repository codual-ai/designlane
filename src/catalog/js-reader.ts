/** The catalog's reading of React Native components: their props, and the JSX placing them. */

import ts from "typescript";
import { eachNode, type JsSource, lineOf } from "../frameworks/js-sources.js";
import { componentFunction } from "../frameworks/rn-views.js";
import { type ComponentReader, indexed, type Placement, perSource } from "./reader.js";

interface Candidate {
  name: string;
  node: ts.Node;
  props: ts.ParameterDeclaration | ts.TypeNode | undefined;
}

export function jsReader(files: JsSource[]): ComponentReader {
  const byFile = new Map(files.map((f) => [f.rel, f]));
  const declaredIn = perSource((source: JsSource) => {
    const candidates = candidatesIn(source.file);
    // By line and by name, so finding one view's costs a lookup, not a pass over the file's components.
    return { byLine: indexed(candidates, (c) => lineOf(c.node)), byName: indexed(candidates, (c) => c.name) };
  });
  return {
    declaration(view) {
      const source = byFile.get(view.file);
      if (!source) return undefined;
      const { byLine, byName } = declaredIn(source);
      const match =
        byLine.get(view.line)?.find((c) => c.name === view.name || !c.name) ?? byName.get(view.name)?.[0];
      if (!match) return undefined;
      return {
        start: match.node.getStart(),
        end: match.node.getEnd(),
        params: propsOf(match.props, source.file),
      };
    },
    placements(names) {
      const out: Placement[] = [];
      for (const source of files) {
        eachNode(source.file, (node) => {
          if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
            const name = ts.isIdentifier(node.tagName) ? node.tagName.text : "";
            if (names.has(name)) out.push({ name, rel: source.rel, at: node.getStart() });
          }
          return true;
        });
      }
      return out;
    },
    previews: () => [],
  };
}

/** Functions, function-valued variables, classes and default exports, any of which a scan's component can be. */
function candidatesIn(file: ts.SourceFile): Candidate[] {
  const out: Candidate[] = [];
  eachNode(file, (node) => {
    if (ts.isFunctionDeclaration(node))
      out.push({ name: node.name?.text ?? "", node, props: node.parameters[0] });
    else if (ts.isClassDeclaration(node))
      out.push({
        name: node.name?.text ?? "",
        node,
        props: node.heritageClauses?.[0]?.types[0]?.typeArguments?.[0],
      });
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const fn = componentFunction(node.initializer);
      if (fn) out.push({ name: node.name.text, node, props: fn.parameters[0] });
    } else if (ts.isExportAssignment(node)) {
      const fn = componentFunction(node.expression);
      if (fn) out.push({ name: "", node: fn, props: fn.parameters[0] });
    }
    return true;
  });
  return out;
}

/** The props as the code declares them: a props type's members (`title: string`), else the names destructured,
 * else the parameter as written. */
function propsOf(props: Candidate["props"], file: ts.SourceFile): string[] {
  if (!props) return [];
  const type = ts.isParameter(props) ? props.type : props;
  const members = type && membersOf(type, file);
  if (members)
    return members.map((m) =>
      m
        .getText()
        .replace(/[;,]\s*$/, "")
        .replace(/\s+/g, " "),
    );
  if (!ts.isParameter(props)) return [];
  if (ts.isObjectBindingPattern(props.name))
    return props.name.elements.map(
      (e) => `${e.dotDotDotToken ? "..." : ""}${(e.propertyName ?? e.name).getText()}`,
    );
  return [props.getText()];
}

/** A type literal's members, written in place or named by an interface or type in the same file. */
function membersOf(type: ts.TypeNode, file: ts.SourceFile): readonly ts.TypeElement[] | undefined {
  if (ts.isTypeLiteralNode(type)) return type.members;
  if (!ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName)) return undefined;
  const name = type.typeName.text;
  for (const statement of file.statements) {
    if (ts.isInterfaceDeclaration(statement) && statement.name.text === name) return statement.members;
    if (
      ts.isTypeAliasDeclaration(statement) &&
      statement.name.text === name &&
      ts.isTypeLiteralNode(statement.type)
    )
      return statement.type.members;
  }
  return undefined;
}
