/**
 * A React Native app's views as the shared classifier reads them: every function or class component, what it holds
 * (lists, scrolling, safe areas), where it's placed, and which ones the app's navigation opens as screens (React
 * Navigation's `<Stack.Screen>`, its static `screens` config and an app's own navigator creators, Expo Router's route
 * files, a modal's whole content). Names are followed through the app's imports and exports (see rn-modules.ts).
 */

import path from "node:path";
import ts from "typescript";
import type { ViewFacts } from "../scan/classify.js";
import { accessPath, eachNode, type JsSource, lineOf, unwrapped } from "./js-sources.js";
import { Modules, memberOf, stemOf } from "./rn-modules.js";

/** A navigator's screen: `<Stack.Screen>`, `<Tab.Screen>`; not an app's own `<Screen>` wrapper. */
const SCREEN_TAG = /^\w+\.Screen$/;
/** React Native's modal and the modal library's, whose whole content is a page. */
const MODAL_TAG = /^(?:\w+\.)?(?:Modal|ReactNativeModal)$/;
/** A call making a navigator: React Navigation's `createNativeStackNavigator`, or an app's own
 * `createModalStackNavigator`. */
const NAVIGATOR_CALL = /^create\w*Navigator$/;
/** Higher-order components wrapping a component: `memo(X)`, `forwardRef(…)`, `withNavigation(X)`, `connect(…)(X)`. */
const WRAPPER = /^(?:memo|forwardRef|observer|inject|connect\w*|lazy)$|^with[A-Z]\w*$/;
/** How many names, files and wrappers one lookup follows before giving up. */
const MAX_STEPS = 256;
const LISTS = new Set(["FlatList", "SectionList", "FlashList", "VirtualizedList"]);
const SCROLLS = new Set(["ScrollView", "KeyboardAwareScrollView"]);

/** A component the app declares. */
interface Component {
  name: string;
  source: JsSource;
  node: ts.Node;
  /** Takes `children`, or draws a navigator: built to hold other views, so never a page itself. */
  holdsViews: boolean;
  pageElements: number;
}

/** The folders holding Expo Router's route files, whose `_layout` files are the layouts around them. */
export interface ExpoRoutes {
  folders: string[];
}

/** `packages`: what the project depends on, which imports name rather than its own files. */
export function rnViews(
  sources: JsSource[],
  expo?: ExpoRoutes,
  packages: Set<string> = new Set(),
): ViewFacts[] {
  const placed = placedNames(sources);
  const components = sources.flatMap((s) => componentsIn(s, placed));
  const finder = new Finder(new Modules(sources, packages), components);
  const presented = new Set<Component>();
  const layouts = new Set<Component>();
  for (const source of sources)
    for (const shown of screensIn(source, finder))
      for (const c of finder.find(shown, source)) presented.add(c);
  for (const source of sources.filter((s) => expo && routeFile(s.rel, expo.folders))) {
    const isLayout = /(?:^|\/)_layout\.[jt]sx?$/.test(source.rel);
    for (const c of finder.exported(source, "default")) (isLayout ? layouts : presented).add(c);
  }
  const placedIn = finder.placements();
  return components.map((c) => ({
    name: c.name,
    file: c.source.rel,
    line: lineOf(c.node),
    pageElements: c.pageElements,
    bodyLines: c.node.getText().split("\n").length,
    presented: presented.has(c),
    routed: false,
    childFiles: placedIn.get(c)?.size ?? 0,
    holdsViews: c.holdsViews || layouts.has(c),
  }));
}

/** A route file of Expo Router: under a routes folder, not an API route, middleware or the HTML shell. */
function routeFile(rel: string, folders: string[]): boolean {
  return (
    folders.some((f) => rel.startsWith(`${f}/`)) &&
    /\.[jt]sx?$/.test(rel) &&
    !/(?:^|\/)\+(?:html|middleware)\.[jt]sx?$|\+api\.[jt]sx?$/.test(rel)
  );
}

/** The names placed as JSX tags anywhere (`<HeaderRightActions />`). */
function placedNames(sources: JsSource[]): Set<string> {
  const names = new Set<string>();
  for (const source of sources)
    eachNode(source.file, (node) => {
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node))
        names.add(node.tagName.getText().split(".").at(-1) ?? "");
      return true;
    });
  return names;
}

/** The name a file's anonymous or lowercase default export goes by: its file's, or its folder's for an `index`. */
export const fileComponentName = (source: Pick<JsSource, "rel">) => {
  const base = path.basename(source.rel).replace(/\.[^.]+$/, "");
  const name = base === "index" ? path.basename(path.dirname(source.rel)) : base;
  return name.replace(/(?:^|[-_[\]().+])(\w)/g, (_, c: string) => c.toUpperCase()).replace(/\W/g, "");
};

/** The components `source` declares: capitalised functions, variables and classes whose code draws JSX or that the
 * app places as JSX (one that only sets its screen's header and returns `null`), and its default export however it's
 * written (`export default () => …`, `export default function profile()`). Components inside others count too. */
function componentsIn(source: JsSource, placed: Set<string>): Component[] {
  const candidates: { name: string; node: ts.Node; params?: ts.NodeArray<ts.ParameterDeclaration> }[] = [];
  const add = (
    name: string,
    node: ts.Node,
    params?: ts.NodeArray<ts.ParameterDeclaration>,
    isDefault = false,
  ) => {
    const named = isDefault && !/^[A-Z]/.test(name) ? fileComponentName(source) : name;
    if (/^[A-Z]/.test(named)) candidates.push({ name: named, node, ...(params ? { params } : {}) });
  };
  eachNode(source.file, (node) => {
    if (ts.isFunctionDeclaration(node)) add(node.name?.text ?? "", node, node.parameters, isDefault(node));
    else if (ts.isClassDeclaration(node) && isComponentClass(node))
      add(node.name?.text ?? "", node, undefined, isDefault(node));
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const fn = componentFunction(node.initializer);
      if (fn) add(node.name.text, node, fn.parameters);
    } else if (ts.isExportAssignment(node)) {
      // `export default () => …`, also wrapped: `export default observer(() => …)`.
      const fn = componentFunction(node.expression);
      const name = fn && ts.isFunctionExpression(fn) && fn.name ? fn.name.text : "";
      if (fn) add(name, fn, fn.parameters, true);
    }
    return true;
  });
  const nested = new Set(candidates.map((c) => c.node));
  return candidates.flatMap(({ name, node, params }) => {
    const first = params?.[0]?.name;
    const props = first && ts.isIdentifier(first) ? first.text : "this.props";
    const read = readComponent(node, props, nested);
    // A component that only sets its screen's header and returns `null` is still placed as JSX.
    if (!read.jsx && !placed.has(name)) return [];
    const destructured =
      first &&
      ts.isObjectBindingPattern(first) &&
      first.elements.some((e) => (e.propertyName ?? e.name).getText() === "children");
    return [
      {
        name,
        source,
        node,
        holdsViews: Boolean(destructured) || read.children || read.navigator,
        pageElements: read.kinds.size,
      },
    ];
  });
}

const isDefault = (node: ts.FunctionDeclaration | ts.ClassDeclaration) =>
  node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false;

/** The function a component's variable holds: itself, or one a higher-order component wraps (`memo(…)`,
 * `withNavigation(…)`, `connect(…)(…)`); never one a call like `items.map(…)` is given. */
export function componentFunction(node: ts.Expression): ts.SignatureDeclaration | undefined {
  const value = unwrapped(node);
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return value;
  if (!ts.isCallExpression(value)) return undefined;
  const callee = unwrapped(value.expression);
  const wraps = ts.isCallExpression(callee) || WRAPPER.test(accessPath(callee)?.at(-1) ?? "");
  if (!wraps) return undefined;
  for (const arg of value.arguments) {
    const fn = componentFunction(arg);
    if (fn) return fn;
  }
  return undefined;
}

function isComponentClass(node: ts.ClassDeclaration): boolean {
  const base = node.heritageClauses?.[0]?.types[0]?.expression;
  return /^(?:Component|PureComponent)$/.test(base ? (accessPath(base)?.at(-1) ?? "") : "");
}

/** What a component's code shows, read in one walk: whether it draws JSX or a navigator (`<Tab.Navigator>`, which
 * holds screens rather than being one), reads its props' `children`, and the page-like kinds it draws (a list,
 * scrolling, a safe area, a header it sets, tabs), each once and not those of a component declared inside it. */
function readComponent(node: ts.Node, props: string, nested: Set<ts.Node>) {
  const found = { jsx: false, navigator: false, children: false, kinds: new Set<string>() };
  eachNode(node, (inner) => {
    if (inner !== node && nested.has(inner)) {
      found.jsx = true;
      return false;
    }
    if (ts.isJsxElement(inner) || ts.isJsxFragment(inner)) found.jsx = true;
    if (ts.isJsxOpeningElement(inner) || ts.isJsxSelfClosingElement(inner)) {
      found.jsx = true;
      const tag = inner.tagName.getText();
      const last = tag.split(".").at(-1) ?? "";
      if (/\.Navigator$/.test(tag)) found.navigator = true;
      if (LISTS.has(last)) found.kinds.add("list");
      if (SCROLLS.has(last)) found.kinds.add("scroll");
      if (last === "SafeAreaView") found.kinds.add("safe");
      if (/Tab\w*\.Navigator$/.test(tag) || last === "TabView") found.kinds.add("tabs");
    }
    if (
      ts.isPropertyAccessExpression(inner) &&
      inner.name.text === "children" &&
      inner.expression.getText() === props
    )
      found.children = true;
    if (ts.isCallExpression(inner)) {
      const callee = accessPath(inner.expression)?.join(".") ?? "";
      if (callee.endsWith("useSafeAreaInsets")) found.kinds.add("safe");
      if (callee.endsWith("navigation.setOptions")) found.kinds.add("header");
    }
    if (ts.isPropertyAssignment(inner) && inner.name.getText() === "headerTitle") found.kinds.add("header");
    return true;
  });
  return found;
}

/** The expressions naming what a file's navigation shows as screens, in one walk: navigators' screens, navigator
 * creators' configs, and modals' whole content. */
function screensIn(source: JsSource, finder: Finder): ts.Expression[] {
  const out: ts.Expression[] = [];
  eachNode(source.file, (node) => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) navigatorScreen(node, out);
    if (ts.isJsxElement(node)) modalContent(node, out);
    if (ts.isCallExpression(node)) configScreens(node, source, finder, out);
    return true;
  });
  return out;
}

/** What a `<Stack.Screen>` shows: `component={X}`, `getComponent={() => X}`, `children={…}` or a children function
 * between its tags. */
function navigatorScreen(node: ts.JsxSelfClosingElement | ts.JsxOpeningElement, out: ts.Expression[]) {
  if (!SCREEN_TAG.test(node.tagName.getText())) return;
  for (const attr of node.attributes.properties) {
    if (!ts.isJsxAttribute(attr) || !/^(?:component|getComponent|children)$/.test(attr.name.getText()))
      continue;
    const value = attr.initializer;
    if (value && ts.isJsxExpression(value) && value.expression) out.push(value.expression);
  }
  if (ts.isJsxOpeningElement(node))
    for (const child of node.parent.children)
      if (ts.isJsxExpression(child) && child.expression) out.push(child.expression);
}

/** What a navigator creator's config lists: `createNativeStackNavigator({ screens: { Home, Profile: { screen } } })`,
 * or an app's own `createModalStackNavigator({ [SCREENS.SETTINGS]: () => require("./Settings").default })`; also
 * through variables holding the config or its screens. */
function configScreens(node: ts.CallExpression, source: JsSource, finder: Finder, out: ts.Expression[]) {
  if (!NAVIGATOR_CALL.test(accessPath(node.expression)?.at(-1) ?? "")) return;
  const config = node.arguments[0] && finder.objectOf(node.arguments[0], source);
  if (!config) return;
  const screens = memberOf(config, "screens");
  const list = screens ? finder.objectOf(screens, source) : config;
  for (const p of list?.properties ?? []) {
    const value = ts.isPropertyAssignment(p)
      ? p.initializer
      : ts.isShorthandPropertyAssignment(p)
        ? p.name
        : undefined;
    if (!value) continue;
    const inner = unwrapped(value);
    out.push(ts.isObjectLiteralExpression(inner) ? (memberOf(inner, "screen") ?? inner) : value);
  }
}

/** What a modal shows whole: its one child, an element or an expression (`<Modal>{<Body />}</Modal>`). */
function modalContent(node: ts.JsxElement, out: ts.Expression[]) {
  if (!MODAL_TAG.test(node.openingElement.tagName.getText())) return;
  const children = node.children.filter((c) => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces));
  const only = children.length === 1 ? children[0] : undefined;
  if (only && (ts.isJsxElement(only) || ts.isJsxSelfClosingElement(only))) out.push(only);
  else if (only && ts.isJsxExpression(only) && only.expression) out.push(only.expression);
}

/** A lookup's budget, shared across the files it follows, so a loop of files exporting each other ends. */
interface Walk {
  steps: number;
}

const newWalk = (): Walk => ({ steps: 0 });

/** Follows the expression naming a screen to the components it is: through variables, functions returning them,
 * higher-order components, `require("./Screen").default`, `import()` and the app's imports and exports. */
class Finder {
  private readonly byFile = new Map<JsSource, Map<string, Component>>();
  private readonly byNode = new Map<ts.Node, Component>();
  private readonly declarations = new Map<JsSource, Map<string, ts.Expression>>();
  /** Each file's default export written as a declaration or an anonymous function: `export default function …`. */
  private readonly defaults = new Map<JsSource, Component>();

  constructor(
    private readonly modules: Modules,
    components: Component[],
  ) {
    for (const c of components) {
      if (!this.defaults.has(c.source) && (isDefaultDeclaration(c.node) || inDefaultExport(c.node)))
        this.defaults.set(c.source, c);
      const own = this.byFile.get(c.source) ?? new Map<string, Component>();
      if (!own.has(c.name)) own.set(c.name, c);
      this.byFile.set(c.source, own);
      this.byNode.set(c.node, c);
    }
  }

  find(node: ts.Expression, source: JsSource): Component[] {
    return this.resolve(node, source, newWalk());
  }

  exported(source: JsSource, name: string): Component[] {
    return this.exportOf(source, name, newWalk());
  }

  /** The object literal an expression is, also through a variable holding it. */
  objectOf(node: ts.Expression, source: JsSource, hops = 0): ts.ObjectLiteralExpression | undefined {
    const value = unwrapped(node);
    if (ts.isObjectLiteralExpression(value)) return value;
    if (!ts.isIdentifier(value) || hops > MAX_STEPS) return undefined;
    const init = this.declared(source, value.text);
    return init ? this.objectOf(init, source, hops + 1) : undefined;
  }

  /** For each component, the files placing it (`<Name`), by what each file's tags name, its own file aside. */
  placements(): Map<Component, Set<string>> {
    const out = new Map<Component, Set<string>>();
    for (const source of this.modules.sources) {
      const cache = new Map<string, Component[]>();
      eachNode(source.file, (node) => {
        if (!(ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node))) return true;
        const tag = node.tagName.getText();
        if (!/^[A-Z]/.test(tag.split(".").at(-1) ?? "")) return true;
        let found = cache.get(tag);
        if (!found) {
          found = this.resolve(node.tagName as ts.Expression, source, newWalk());
          cache.set(tag, found);
        }
        for (const c of found) {
          if (stemOf(c.source.rel) === stemOf(source.rel)) continue;
          // A file's platform variants (`List.ios.tsx`, `List.android.tsx`) are one place.
          const files = out.get(c) ?? new Set<string>();
          files.add(stemOf(source.rel));
          out.set(c, files);
        }
        return true;
      });
    }
    return out;
  }

  private resolve(node: ts.Expression, source: JsSource, walk: Walk): Component[] {
    if (++walk.steps > MAX_STEPS) return [];
    const value = unwrapped(node);
    const own = this.byNode.get(value);
    if (own) return [own];
    if (ts.isIdentifier(value)) return this.local(source, value.text, walk);
    if (ts.isPropertyAccessExpression(value)) return this.member(value, source, walk);
    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
      const returned = ts.isBlock(value.body)
        ? value.body.statements.find(ts.isReturnStatement)?.expression
        : value.body;
      return returned ? this.resolve(returned, source, walk) : [];
    }
    if (ts.isJsxElement(value))
      return this.resolve(value.openingElement.tagName as ts.Expression, source, walk);
    if (ts.isJsxSelfClosingElement(value)) return this.resolve(value.tagName as ts.Expression, source, walk);
    if (ts.isConditionalExpression(value))
      return [...this.resolve(value.whenTrue, source, walk), ...this.resolve(value.whenFalse, source, walk)];
    if (ts.isCallExpression(value)) return this.call(value, source, walk);
    return [];
  }

  /** `require("./X")`, `import("./X")`, or the component a wrapping call is given. */
  private call(value: ts.CallExpression, source: JsSource, walk: Walk): Component[] {
    const first = value.arguments[0] && unwrapped(value.arguments[0]);
    const callee = unwrapped(value.expression);
    const isImport = callee.kind === ts.SyntaxKind.ImportKeyword || accessPath(callee)?.at(-1) === "require";
    if (isImport && first && ts.isStringLiteral(first))
      return this.modules.resolve(first.text, source).flatMap((f) => this.exportOf(f, "default", walk));
    // Any other call a screen is named through wraps the component it's given (`useHaveServerDataGate(X)`,
    // `fadeIn(<ObsEdit />)`).
    return value.arguments.flatMap((a) => this.resolve(a, source, walk));
  }

  /** `require("./X").default`, `Screens.Home` from `import * as Screens`. */
  private member(value: ts.PropertyAccessExpression, source: JsSource, walk: Walk): Component[] {
    if (value.name.text === "default") return this.resolve(value.expression, source, walk);
    const left = unwrapped(value.expression);
    const imported = ts.isIdentifier(left) ? this.modules.namesOf(source).imports.get(left.text) : undefined;
    if (imported?.name === "*")
      return this.modules
        .resolve(imported.from, source)
        .flatMap((f) => this.exportOf(f, value.name.text, walk));
    return [];
  }

  /** A name in `source`: its own component, a variable or function it declares, or what it imports by that name. */
  private local(source: JsSource, name: string, walk: Walk): Component[] {
    if (++walk.steps > MAX_STEPS) return [];
    const own = this.byFile.get(source)?.get(name);
    if (own) return [this.unwrapRender(own, walk)];
    const declared = this.declared(source, name);
    if (declared) return this.resolve(declared, source, walk);
    const imported = this.modules.namesOf(source).imports.get(name);
    if (!imported || imported.name === "*") return [];
    return this.modules.resolve(imported.from, source).flatMap((f) => this.exportOf(f, imported.name, walk));
  }

  /** A component that only renders another through a function (`() => fadeIn(<ObsEdit />)`) shows that one. */
  private unwrapRender(component: Component, walk: Walk): Component {
    const init = ts.isVariableDeclaration(component.node) ? component.node.initializer : undefined;
    const fn = init && unwrapped(init);
    if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) || ts.isBlock(fn.body))
      return component;
    const body = unwrapped(fn.body);
    if (!ts.isCallExpression(body) || WRAPPER.test(accessPath(body.expression)?.at(-1) ?? ""))
      return component;
    const inner = this.call(body, component.source, walk);
    return inner.length === 1 && inner[0] ? inner[0] : component;
  }

  /** The value a module-level variable holds, or what a module-level function (a loader) returns; each file's read
   * once. */
  private declared(source: JsSource, name: string): ts.Expression | undefined {
    let own = this.declarations.get(source);
    if (!own) {
      own = new Map();
      for (const s of source.file.statements) {
        if (ts.isVariableStatement(s)) {
          for (const d of s.declarationList.declarations)
            if (ts.isIdentifier(d.name) && d.initializer && !own.has(d.name.text))
              own.set(d.name.text, d.initializer);
        } else if (ts.isFunctionDeclaration(s) && s.name && s.body && !own.has(s.name.text)) {
          const returned = s.body.statements.find(ts.isReturnStatement)?.expression;
          if (returned) own.set(s.name.text, returned);
        }
      }
      this.declarations.set(source, own);
    }
    return own.get(name);
  }

  /** What a file exports under a name, `default` included: a declaration of its own, a name it re-exports
   * (`export { X as default } from "./x"`), an expression it default-exports, or a module it re-exports all of. */
  private exportOf(source: JsSource, name: string, walk: Walk): Component[] {
    if (++walk.steps > MAX_STEPS) return [];
    // A default export declared in place (`export default function welcome()`) goes by its file's name.
    const declared = name === "default" ? this.defaults.get(source) : undefined;
    if (declared) return [declared];
    const names = this.modules.namesOf(source);
    const exported = names.exports.get(name);
    if (exported && "local" in exported) {
      const own = this.byFile.get(source)?.get(exported.local);
      return own ? [this.unwrapRender(own, walk)] : this.local(source, exported.local, walk);
    }
    if (exported)
      return this.modules
        .resolve(exported.from, source)
        .flatMap((f) => this.exportOf(f, exported.name, walk));
    if (name === "default") {
      const anonymous = this.defaults.get(source);
      if (anonymous) return [anonymous];
      return names.defaultExpression ? this.resolve(names.defaultExpression, source, walk) : [];
    }
    return names.stars.flatMap((from) =>
      this.modules.resolve(from, source).flatMap((f) => this.exportOf(f, name, walk)),
    );
  }
}

/** Whether a function is what `export default` gives, directly or through wrapping calls. */
function inDefaultExport(node: ts.Node): boolean {
  let at = node.parent;
  while (ts.isCallExpression(at) || ts.isParenthesizedExpression(at)) at = at.parent;
  return ts.isExportAssignment(at);
}

const isDefaultDeclaration = (node: ts.Node) =>
  (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && isDefault(node);
