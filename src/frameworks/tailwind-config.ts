/** A Tailwind config's `theme`, read through the variables, `require(…)`s and imports its values are written in. */

import path from "node:path";
import ts from "typescript";
import { accessPath, type JsSource, propertyName, renderPath, unwrapped } from "./js-sources.js";

export const TAILWIND_CONFIG = /(?:^|\/)tailwind\.config\.[cm]?[jt]s$/;
/** How many variables, requires and imports a config value is followed through. */
export const MAX_HOPS = 8;

/** A value and the file it's written in, which its names are looked up in. */
export interface Located {
  node: ts.Expression;
  source: JsSource;
}

/** For each Tailwind config, the values its `theme` and `theme.extend` give `key` (`colors`, `fontSize`). */
export function themeGroups(sources: JsSource[], key: string) {
  const resolver = new Resolver(sources);
  return sources
    .filter((s) => TAILWIND_CONFIG.test(s.rel))
    .map((config) => {
      const root = resolver.exported(config);
      const theme = root && resolver.member(root, "theme");
      const extend = theme && resolver.member(theme, "extend");
      const groups = [theme && resolver.member(theme, key), extend && resolver.member(extend, key)].filter(
        (g): g is Located => g !== undefined,
      );
      return { config, groups, resolver };
    });
}

/** Follows a config's values through module-level variables, `require(…)` and default imports of local modules. */
export class Resolver {
  private readonly byRel: Map<string, JsSource>;

  constructor(sources: JsSource[]) {
    this.byRel = new Map(sources.map((s) => [s.rel, s]));
  }

  /** What a module exports: `module.exports = …` or `export default …`. */
  exported(source: JsSource, hops = 0): Located | undefined {
    for (const statement of source.file.statements) {
      if (ts.isExportAssignment(statement)) return this.value({ node: statement.expression, source }, hops);
      if (
        ts.isExpressionStatement(statement) &&
        ts.isBinaryExpression(statement.expression) &&
        statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        renderPath(accessPath(statement.expression.left) ?? []) === "module.exports"
      ) {
        return this.value({ node: statement.expression.right, source }, hops);
      }
    }
    return undefined;
  }

  /** `name`'s value in an object literal, also written as a variable of that name (`{ theme: { colors } }`). */
  member(at: Located, name: string): Located | undefined {
    const object = this.object(at);
    if (!object) return undefined;
    for (const property of object.node.properties) {
      if (ts.isPropertyAssignment(property) && propertyName(property.name) === name)
        return { node: property.initializer, source: object.source };
      if (ts.isShorthandPropertyAssignment(property) && property.name.text === name)
        return { node: property.name, source: object.source };
    }
    return undefined;
  }

  /** The object literal a value is, wherever it's written. */
  object(at: Located): { node: ts.ObjectLiteralExpression; source: JsSource } | undefined {
    const found = this.value(at, 0);
    const node = found && unwrapped(found.node);
    return found && node && ts.isObjectLiteralExpression(node) ? { node, source: found.source } : undefined;
  }

  /** A value's own expression, past variables, requires and imports; undefined past `MAX_HOPS`, so modules that
   * require each other end. */
  private value({ node, source }: Located, hops: number): Located | undefined {
    if (hops > MAX_HOPS) return undefined;
    const value = unwrapped(node);
    if (ts.isCallExpression(value) && renderPath(accessPath(value.expression) ?? []) === "require") {
      const target = this.moduleAt(value.arguments[0], source);
      return target && this.exported(target, hops + 1);
    }
    if (!ts.isIdentifier(value)) return { node: value, source };
    for (const statement of source.file.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const d of statement.declarationList.declarations)
          if (ts.isIdentifier(d.name) && d.name.text === value.text && d.initializer)
            return this.value({ node: d.initializer, source }, hops + 1);
      }
      if (
        ts.isImportDeclaration(statement) &&
        statement.importClause?.name?.text === value.text &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        const target = this.moduleAt(statement.moduleSpecifier, source);
        return target && this.exported(target, hops + 1);
      }
    }
    return undefined;
  }

  /** The project's module a relative path names, trying the script extensions and `index`. */
  private moduleAt(specifier: ts.Expression | undefined, from: JsSource): JsSource | undefined {
    if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith(".")) return undefined;
    const base = path.posix.join(path.posix.dirname(from.rel), specifier.text);
    for (const ext of ["", ".js", ".ts", ".cjs", ".mjs", ".jsx", ".tsx", "/index.js", "/index.ts"]) {
      const found = this.byRel.get(base + ext);
      if (found) return found;
    }
    return undefined;
  }
}
