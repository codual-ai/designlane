/**
 * Spacing and corner radius scales declared in JavaScript: an object of numbers named for one, exported from a file
 * (`export const spacing = { sm: 8, md: 12 }`), since one a file keeps to itself is that file's own constants, or
 * inside a theme object exported there
 * (`const theme = { radii: { card: 12 } }`), reached by name: `spacing.md`, `theme.radii.card`, `space["2xl"]`.
 */

import ts from "typescript";
import { countUse, type ScaleCandidate, scaleKindOf, stepKindOf } from "../scan/scales.js";
import {
  accessPath,
  eachNode,
  type JsSource,
  literalLocation,
  objectIn,
  propertyName,
  renderPath,
  unwrapped,
} from "./js-sources.js";

/** How deep inside a theme object a scale is looked for: `theme.spacing`, `theme.layout.spacing`. */
const MAX_DEPTH = 3;

/** Every scale step the scripts declare, with the files using each by name. */
export function rnScaleCandidates(sources: JsSource[]): ScaleCandidate[] {
  const found: ScaleCandidate[] = [];
  for (const source of sources) {
    for (const statement of source.file.statements) {
      if (!ts.isVariableStatement(statement) || !exported(statement, source)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const name = declaration.name.text;
        const object = objectIn(declaration.initializer);
        if (object) read(source, [name], object, found, 0);
        // `export const ROW_PADDING_HORIZONTAL = 16`: a constant whose own name says what it is.
        else named(source, [], name, unwrapped(declaration.initializer), found);
      }
    }
  }
  countUses(found, sources);
  return found;
}

/** Whether a declaration is exported: `export const spacing`, or named in an `export { spacing }` or
 * `export default spacing` of its file. */
function exported(statement: ts.VariableStatement, source: JsSource): boolean {
  if (statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return true;
  const names = new Set(
    statement.declarationList.declarations.flatMap((d) => (ts.isIdentifier(d.name) ? [d.name.text] : [])),
  );
  return source.file.statements.some(
    (s) =>
      (ts.isExportDeclaration(s) &&
        !s.moduleSpecifier &&
        s.exportClause &&
        ts.isNamedExports(s.exportClause) &&
        s.exportClause.elements.some((e) => names.has((e.propertyName ?? e.name).text))) ||
      (ts.isExportAssignment(s) && ts.isIdentifier(s.expression) && names.has(s.expression.text)),
  );
}

/** The steps of `object`, reached by `path`, when its name holds a scale; otherwise the scales inside it. */
function read(
  source: JsSource,
  path: string[],
  object: ts.ObjectLiteralExpression,
  found: ScaleCandidate[],
  depth: number,
): void {
  const kind = scaleKindOf(path.at(-1) ?? "");
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = propertyName(property.name);
    if (name === undefined) continue;
    const value = unwrapped(property.initializer);
    if (kind) {
      const number = numberOf(value);
      const location = literalLocation(source, value);
      if (number === undefined || !location) continue;
      found.push({
        kind,
        scale: renderPath(path),
        step: {
          name,
          value: number,
          reference: renderPath([...path, name]),
          source: source.rel,
          line: location.line,
          location,
        },
        usedIn: new Map(),
      });
    } else if (depth < MAX_DEPTH) {
      const inner = objectIn(value);
      if (inner) read(source, [...path, name], inner, found, depth + 1);
      // `export const Layout = { headerPadding: 12 }`: a property whose own name says what it is.
      else named(source, path, name, value, found);
    }
  }
}

/** A step for a number whose own name says it's a spacing or a corner radius, kept on its own when another file
 * uses it: `ROW_PADDING_HORIZONTAL`, `Layout.headerPadding`. */
function named(
  source: JsSource,
  path: string[],
  name: string,
  value: ts.Expression,
  found: ScaleCandidate[],
): void {
  const kind = stepKindOf(name);
  const number = kind && numberOf(value);
  const location = number === undefined || !kind ? undefined : literalLocation(source, value);
  if (!kind || number === undefined || !location) return;
  found.push({
    kind,
    scale: path.length > 0 ? renderPath(path) : source.rel,
    named: true,
    step: {
      name,
      value: number,
      reference: renderPath([...path, name]),
      source: source.rel,
      line: location.line,
      location,
    },
    usedIn: new Map(),
  });
}

/** A number written as it is: `12`, `0.5`; not `-4`, `8 * 2` or `"12px"`. */
function numberOf(node: ts.Expression): number | undefined {
  return ts.isNumericLiteral(node) ? Number(node.text) : undefined;
}

/** A component prop taking a spacing step by its name (`<Box padding="lg">`, `gap="md"`), or a radius one
 * (`borderRadius="card"`), as design-system components built on a scale take them. */
const SPACING_PROP = /^(?:padding|margin|gap|space|spacing|inset)\w*$/i;
const RADIUS_PROP = /^(?:borderRadius|radius|rounded|cornerRadius)\w*$/i;

/**
 * Counts each step's uses: an access whose path ends with the step's own (`spacing.md` is used by `theme.spacing.md`
 * and `t.spacing.md`, since a theme is often reached through a hook), each access counted once, at its full path; and
 * a component prop naming a step of its kind (`padding="lg"`).
 */
function countUses(found: ScaleCandidate[], sources: JsSource[]): void {
  if (found.length === 0) return;
  // Matched on the step's own name and its scale's last name, so `theme.spacing.md` and `useTheme().spacing.md` both
  // count; an app with two scales of one name counts a use toward each.
  const byTail = new Map<string, ScaleCandidate[]>();
  for (const candidate of found) {
    const tail = `${candidate.scale.split(/[.[]/).at(-1)}|${candidate.step.name}`;
    const same = byTail.get(tail) ?? [];
    byTail.set(tail, same);
    same.push(candidate);
  }
  const byStep = new Map<string, ScaleCandidate[]>();
  for (const candidate of found) {
    // A prop names a scale's step (`padding="lg"`); a constant's name in a string doesn't read it.
    if (candidate.named) continue;
    const key = `${candidate.kind}|${candidate.step.name}`;
    const same = byStep.get(key);
    if (same) same.push(candidate);
    else byStep.set(key, [candidate]);
  }
  // A constant exported on its own is used by its name where a file imports it from the constant's own file:
  // `import { CONTENT_SPACING } from "./constants"`. Indexed by that file and name, so each read is one lookup.
  const exportedAt = new Map<string, ScaleCandidate>();
  const exportedNames = new Map<string, ScaleCandidate[]>();
  for (const c of found) {
    if (!c.named || c.scale !== c.step.source) continue;
    exportedAt.set(`${withoutExtension(c.step.source)}|${c.step.name}`, c);
    const same = exportedNames.get(c.step.name);
    if (same) same.push(c);
    else exportedNames.set(c.step.name, [c]);
  }
  for (const source of sources) {
    const imported = exportedAt.size > 0 ? importedConstants(source, exportedAt, exportedNames) : new Map();
    eachNode(source.file, (node) => {
      if (ts.isIdentifier(node) && readsName(node)) {
        const target = imported.get(node.text);
        if (target) countUse(target.usedIn, source.rel);
        return true;
      }
      if (ts.isJsxAttribute(node)) {
        const prop = propOf(node);
        for (const candidate of prop ? (byStep.get(prop) ?? []) : []) countUse(candidate.usedIn, source.rel);
        return true;
      }
      if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return true;
      const step = stepName(node);
      const scale = step === undefined ? undefined : lastName(node.expression);
      if (step === undefined || scale === undefined) return true;
      for (const candidate of owners(byTail.get(`${scale}|${step}`) ?? [], node))
        countUse(candidate.usedIn, source.rel);
      return true;
    });
  }
}

/** The exported constants a file imports as they are, by the name it reads them by: the one in the file its import
 * names (`./theme` is `theme.ts`, then `theme/index.ts`), or, for a module not named by its path, the only one of the
 * name. One imported under another name (`ROW_RADIUS as RADIUS`) is read as that name, so it isn't one. */
function importedConstants(
  source: JsSource,
  exportedAt: Map<string, ScaleCandidate>,
  exportedNames: Map<string, ScaleCandidate[]>,
): Map<string, ScaleCandidate> {
  const constants = new Map<string, ScaleCandidate>();
  for (const statement of source.file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const file = fileOf(source.rel, statement.moduleSpecifier.text);
    for (const element of bindings.elements) {
      if (element.propertyName) continue;
      const name = element.name.text;
      const only = exportedNames.get(name);
      const constant =
        file === undefined
          ? only?.length === 1
            ? only[0]
            : undefined
          : (exportedAt.get(`${file}|${name}`) ?? exportedAt.get(`${file}/index|${name}`));
      if (constant) constants.set(name, constant);
    }
  }
  return constants;
}

/** The file a relative import names, without its extension: `src/constants` for `./constants` in `src/Row.tsx`. */
function fileOf(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const parts = importer.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  return withoutExtension(parts.join("/"));
}

const withoutExtension = (file: string) => file.replace(/\.[cm]?[jt]sx?$/, "");

/** Whether an identifier reads a value, not names one: not an import's, a declaration's, a key's, a type's or a
 * class's property, a JSX attribute's name or a member's. */
function readsName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isJsxAttribute(parent)) return false;
  if (ts.isPropertyAssignment(parent)) return parent.initializer === node;
  // `const { ROW_PADDING: local } = obj` names a key and a local, and reads neither.
  if (ts.isBindingElement(parent)) return false;
  if (
    ts.isVariableDeclaration(parent) ||
    ts.isParameter(parent) ||
    ts.isPropertySignature(parent) ||
    ts.isPropertyDeclaration(parent)
  )
    return parent.name !== node;
  if (ts.isPropertyAccessExpression(parent)) return parent.expression === node;
  return true;
}

/** Of the steps an access could name, the ones it does: the only one, or when scales share a name, those whose whole
 * path it ends with (`theme.spacing.md`, not `compact.spacing.md`); none when it can't tell them apart. */
function owners(
  candidates: ScaleCandidate[],
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): ScaleCandidate[] {
  if (candidates.length < 2) return candidates;
  const path = renderPath(accessPath(node) ?? []);
  return candidates.filter((c) => path === c.step.reference || path.endsWith(`.${c.step.reference}`));
}

/** `spacing|lg` for `padding="lg"`, `radius|card` for `borderRadius={"card"}`: the kind of step a prop takes and
 * the step it names, or none for any other prop. */
function propOf(node: ts.JsxAttribute): string | undefined {
  const name = ts.isIdentifier(node.name) ? node.name.text : undefined;
  const kind = name && (RADIUS_PROP.test(name) ? "radius" : SPACING_PROP.test(name) ? "spacing" : undefined);
  const initializer = node.initializer;
  if (!kind || !initializer) return undefined;
  const value = ts.isJsxExpression(initializer) ? initializer.expression : initializer;
  return value && ts.isStringLiteral(unwrapped(value))
    ? `${kind}|${(unwrapped(value) as ts.StringLiteral).text}`
    : undefined;
}

/** The name an access reaches: `md` in `spacing.md`, `2xl` in `space["2xl"]`. */
function stepName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return ts.isIdentifier(node.name) ? node.name.text : undefined;
  const key = unwrapped(node.argumentExpression);
  return ts.isStringLiteral(key) || ts.isNumericLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)
    ? key.text
    : undefined;
}

/** The last name of what an access is made on: `spacing` in `theme.spacing` or `useTheme().spacing`, the name itself
 * for `spacing`. */
function lastName(node: ts.Expression): string | undefined {
  const inner = unwrapped(node);
  if (ts.isIdentifier(inner)) return inner.text;
  if (ts.isPropertyAccessExpression(inner)) return ts.isIdentifier(inner.name) ? inner.name.text : undefined;
  if (ts.isElementAccessExpression(inner)) return accessPath(inner)?.at(-1);
  return undefined;
}
