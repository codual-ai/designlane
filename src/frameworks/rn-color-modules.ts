/** The module-level objects and imports of a React Native app's files, which its theme colours are followed through. */

import path from "node:path";
import ts from "typescript";
import { defaultExport, fileName, type JsSource, objectIn, platformChoice, unwrapped } from "./js-sources.js";

/** How many aliases (`primary: palette.blue500`) or spread objects are followed. */
export const MAX_HOPS = 5;

/** Each file's module-level objects and imports, to follow a spread or an alias into the file defining it. */
export class Modules {
  private readonly byRel: Map<string, JsSource>;
  private readonly objects = new Map<JsSource, Map<string, ts.ObjectLiteralExpression>>();
  /** For each file, the name its default export's paths start with: its variable's, or the file's own. */
  private readonly defaultName = new Map<JsSource, string>();
  /** A name holding the object another name holds on iOS, by `file#name`: `black` is `blackIOS`. */
  private readonly choices = new Map<string, string>();
  private readonly imports = new Map<JsSource, Map<string, { from: string; name: string }>>();

  constructor(sources: JsSource[]) {
    this.byRel = new Map(sources.map((s) => [s.rel, s]));
    for (const source of sources) {
      const objects = new Map<string, ts.ObjectLiteralExpression>();
      const imports = new Map<string, { from: string; name: string }>();
      for (const statement of source.file.statements) {
        if (ts.isVariableStatement(statement)) {
          for (const d of statement.declarationList.declarations) {
            if (!ts.isIdentifier(d.name) || !d.initializer) continue;
            const value = objectIn(d.initializer);
            if (value) objects.set(d.name.text, value);
            // `const black = Platform.OS === "ios" ? blackIOS : blackAndroid`: iOS's theme, as the design shows it.
            const chosen = platformChoice(d.initializer)?.ios;
            const picked = chosen && unwrapped(chosen);
            if (picked && ts.isIdentifier(picked))
              this.choices.set(`${source.rel}#${d.name.text}`, picked.text);
            const inPlace = picked && objectIn(picked);
            if (inPlace) objects.set(d.name.text, inPlace);
          }
        } else if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
          const from = statement.moduleSpecifier.text;
          const clause = statement.importClause;
          if (clause?.name) imports.set(clause.name.text, { from, name: "default" });
          const bindings = clause?.namedBindings;
          if (bindings && ts.isNamedImports(bindings))
            for (const e of bindings.elements)
              imports.set(e.name.text, { from, name: e.propertyName?.text ?? e.name.text });
        }
        const exported = defaultExport(statement);
        if (exported) {
          const inner = unwrapped(exported);
          this.defaultName.set(source, ts.isIdentifier(inner) ? inner.text : fileName(source));
        }
      }
      this.objects.set(source, objects);
      this.imports.set(source, imports);
    }
  }

  /** The object literal `name` holds in `source`, or that it imports from another file of the project. */
  object(
    source: JsSource,
    name: string,
    hops = 0,
  ): { object: ts.ObjectLiteralExpression; source: JsSource } | undefined {
    const own = this.objects.get(source)?.get(name);
    if (own) return { object: own, source };
    const chosen = this.choices.get(`${source.rel}#${name}`);
    if (chosen && hops < MAX_HOPS) return this.object(source, chosen, hops + 1);
    const target = this.imported(source, name);
    return target && hops < MAX_HOPS ? this.object(target.source, target.root, hops + 1) : undefined;
  }

  /** The file and root name a local name is imported from: `import appColors from "./palette"`. */
  imported(source: JsSource, name: string): { source: JsSource; root: string } | undefined {
    const binding = this.imports.get(source)?.get(name);
    const target = binding && this.moduleAt(binding.from, source);
    if (!binding || !target) return undefined;
    const root = binding.name === "default" ? this.defaultName.get(target) : binding.name;
    return root ? { source: target, root } : undefined;
  }

  private moduleAt(specifier: string, from: JsSource): JsSource | undefined {
    if (!specifier.startsWith(".")) return undefined;
    const base = path.posix.join(path.posix.dirname(from.rel), specifier);
    for (const ext of ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.js"]) {
      const found = this.byRel.get(base + ext);
      if (found) return found;
    }
    return undefined;
  }
}
