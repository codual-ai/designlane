/** Where a React Native app uses its named colours, and the colours it writes without a name. */

import ts from "typescript";
import type { ColorFindings } from "../scan/palette.js";
import { CSS_NAMES, colorOf } from "./css-color.js";
import { accessPath, eachNode, type JsSource, propertyName, renderPath, shadowed } from "./js-sources.js";
import { STYLE_COLOR } from "./rn-color-entries.js";

/** A name a theme is reached through: `theme`, `colors`, `palette`, or one ending so (`appTheme`, `darkColors`). */
const THEME_WORD = /^(?:theme|colou?rs?|palette)$|[a-z](?:Theme|Colou?rs?|Palette)$/;

/** What the app names, to tell its colours' uses from other code. */
export interface Known {
  /** Every colour's name, for crediting `theme.colors.surface` to `surface`. */
  names: Set<string>;
  /** Module-level colour constants by name, with the files declaring them, used by name alone
   * (`backgroundColor: brand`) in those files or ones importing them. */
  constants: Map<string, Set<string>>;
  /** Where the code names its colours, which aren't uses. */
  definitions: Set<ts.Node>;
  /** The names of the objects holding colours (`colors`, `palette`, `light`), lowercased. */
  holders: Set<string>;
}

/** Each use of a named colour, each colour written without a name, and each CSS colour name in a style. */
export function collectUses(source: JsSource, known: Known, found: ColorFindings) {
  eachNode(source.file, (node) => {
    if (known.definitions.has(node)) return false;
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      !isInnerOfChain(node)
    ) {
      const parts = accessPath(node);
      const last = parts?.[parts.length - 1] ?? "";
      const name =
        parts && parts.length > 1 && /^\d+$/.test(last) ? `${parts[parts.length - 2]}-${last}` : last;
      // `theme.text` is the theme's colour; `styles.text` and `post.text` aren't.
      const themed = parts
        ?.slice(0, -1)
        .some((part) => THEME_WORD.test(part) || known.holders.has(part.toLowerCase()));
      if (parts && themed && known.names.has(name)) {
        found.references.push({ name, reference: renderPath(parts) });
        return false;
      }
    }
    if (ts.isIdentifier(node) && isConstantUse(node, source, known) && isValueUse(node) && !shadowed(node)) {
      found.references.push({ name: node.text, reference: node.text });
      return false;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const hex = colorOf(node.text);
      if (hex && !isDefinition(node)) found.literals.push({ hex, file: source.rel });
      else if (CSS_NAMES[node.text.toLowerCase()] && inStyleColor(node))
        found.system.push(node.text.toLowerCase());
      return false;
    }
    return true;
  });
}

/** Whether `node` is the left part of a longer chain (`theme` or `theme.colors` in `theme.colors.surface`). */
const isInnerOfChain = (node: ts.Node) =>
  (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) &&
  node.parent.expression === node;

/** An identifier read as a value: not a declaration's name, a property's name, or an import. */
function isValueUse(node: ts.Identifier): boolean {
  const { parent } = node;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isPropertyAccessExpression(parent)) && parent.name === node)
    return false;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isExportSpecifier(parent)) return false;
  if ((ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent)) && parent.name === node)
    return false;
  return !ts.isShorthandPropertyAssignment(parent) || parent.objectAssignmentInitializer === node;
}

const importedNames = new WeakMap<JsSource, Set<string>>();

/** A colour constant's name read where it's the constant: in its own file, or one importing that name. */
function isConstantUse(node: ts.Identifier, source: JsSource, known: Known): boolean {
  const files = known.constants.get(node.text);
  if (!files) return false;
  if (files.has(source.rel)) return true;
  let names = importedNames.get(source);
  if (!names) {
    names = new Set(
      source.file.statements.flatMap((s) => {
        if (!ts.isImportDeclaration(s) || !s.importClause) return [];
        const bindings = s.importClause.namedBindings;
        return [
          ...(s.importClause.name ? [s.importClause.name.text] : []),
          ...(bindings && ts.isNamedImports(bindings) ? bindings.elements.map((e) => e.name.text) : []),
        ];
      }),
    );
    importedNames.set(source, names);
  }
  return names.has(node.text);
}

/** A module-level constant's own value, `const brand = "#3366e6" as const`, already a named colour. */
function isDefinition(node: ts.Node): boolean {
  let declaration = node.parent;
  while (
    ts.isParenthesizedExpression(declaration) ||
    ts.isAsExpression(declaration) ||
    ts.isSatisfiesExpression(declaration) ||
    ts.isTypeAssertionExpression(declaration)
  )
    declaration = declaration.parent;
  return (
    ts.isVariableDeclaration(declaration) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    ts.isVariableStatement(declaration.parent.parent) &&
    ts.isSourceFile(declaration.parent.parent.parent)
  );
}

/** A string set as a style's colour: `{ color: "white" }` or `<Icon color="white" />`. */
function inStyleColor(node: ts.Node): boolean {
  const { parent } = node;
  if (ts.isPropertyAssignment(parent)) return STYLE_COLOR.has(propertyName(parent.name) ?? "");
  if (ts.isJsxAttribute(parent)) {
    const name = parent.name.getText();
    return /colou?r$/i.test(name) || STYLE_COLOR.has(name);
  }
  return false;
}
