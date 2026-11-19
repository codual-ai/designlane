import type { ViewFacts } from "../scan/classify.js";
import type { FrameworkPlugin } from "./plugin.js";
import { lineNumbers } from "./source-text.js";
import { type StructDecl, structs } from "./swift-source.js";
import { hostedViews } from "./swiftui-hosting.js";
import { type SwiftLinks, swiftLinks } from "./swiftui-links.js";
import { type SwiftSource, swiftSources } from "./swiftui-sources.js";
import { swiftuiTokens } from "./swiftui-tokens.js";
import { type ViewUsage, viewUsages } from "./swiftui-usage.js";

/** Page-like elements in SwiftUI code. */
const PAGE_ELEMENTS = [
  /NavigationStack|NavigationView|NavigationSplitView/,
  /\.navigationTitle\(/,
  /\bList\s*[({]|\bForm\s*\{/,
  /\bScrollView\b/,
  /\bTabView\b/,
  /\.toolbar\s*\{/,
];

/** A view conforms to `View`, or to a protocol refining it whose name says so (the app's own `ThemeableView`, or a
 * library's `ConnectedView`, whose declaration isn't in the project) and draws a body; a non-view protocol that happens
 * to end in View (`LoginView` in a presenter pattern) has no body. */
const isView = (s: StructDecl, code: string) =>
  s.conformances.some((c) => c === "View" || c === "SwiftUI.View") ||
  (s.conformances.some((c) => /^\w+View$/.test(c)) && BODY.test(code.slice(s.open, s.close)));
const BODY = /\b(?:var\s+body\s*:|func\s+body\s*\()/;

function viewFacts(
  { rel, code }: SwiftSource,
  views: StructDecl[],
  lines: number[],
  usages: Map<string, ViewUsage>,
): ViewFacts[] {
  return views.map((view, i) => {
    const body = ownBody(code, views, i);
    const usage = usages.get(view.name);
    return {
      name: view.name,
      file: rel,
      line: lines[i] ?? 1,
      pageElements: PAGE_ELEMENTS.filter((pattern) => pattern.test(body)).length,
      bodyLines: body.split("\n").length,
      presented: usage?.presented ?? false,
      routed: usage?.routed ?? false,
      childFiles: usage?.childIn.size ?? 0,
      holdsViews: view.holdsViews,
    };
  });
}

/** The body of `views[index]` with any views declared inside it blanked out, so they don't count towards it. */
function ownBody(code: string, views: StructDecl[], index: number): string {
  const view = views[index];
  if (!view) return "";
  const body = code.slice(view.open, view.close + 1).split("");
  for (let k = index + 1; k < views.length; k++) {
    const inner = views[k];
    if (!inner || inner.start > view.close) break;
    body.fill(" ", inner.start - view.open, inner.close + 1 - view.open);
  }
  return body.join("");
}

export const swiftui: FrameworkPlugin = {
  id: "swiftui",
  platforms: ["ios"],

  async scan(ctx) {
    const sources = await swiftSources(ctx);
    const swiftUI = sources.filter((s) => s.swiftUI);
    if (swiftUI.length === 0) return undefined;
    return { ...viewsIn(swiftUI, sources), tokens: await swiftuiTokens(ctx, sources) };
  },
  tokens: async (ctx) => swiftuiTokens(ctx, await swiftSources(ctx)),
};

/** The views declared in the SwiftUI files, with how the app shows them (read from every Swift file), and the links
 * between its screens. */
function viewsIn(sources: SwiftSource[], everySource: SwiftSource[]): { views: ViewFacts[] } & SwiftLinks {
  const views = sources.map((s) => structs(s.code).filter((v) => isView(v, s.code)));
  const all = views.flat();
  const names = new Set(all.map((v) => v.name));
  const containers = new Set(all.filter((v) => v.holdsViews).map((v) => v.name));
  const { usages, presentations, placements } = viewUsages(sources, names, containers);
  // Hosted from UIKit: a page, or part of one, counted like being placed inside another view.
  for (const { name, file, asPage } of hostedViews(everySource, names, containers)) {
    const usage = usages.get(name) ?? { presented: false, routed: false, childIn: new Set<string>() };
    usages.set(name, usage);
    if (asPage) usage.presented = true;
    else usage.childIn.add(file);
  }
  const lines = sources.map((source, i) =>
    lineNumbers(
      source.code,
      (views[i] ?? []).map((v) => v.start),
    ),
  );
  const declared = sources.flatMap((source, i) =>
    (views[i] ?? []).map((view, k) => ({ view, rel: source.rel, line: lines[i]?.[k] ?? 1 })),
  );
  return {
    views: sources.flatMap((source, i) => viewFacts(source, views[i] ?? [], lines[i] ?? [], usages)),
    ...swiftLinks(presentations, placements, declared, everySource),
  };
}
