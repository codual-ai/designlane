/** The app's components and screens as the catalog shows them: what each is, where it's declared and used, what it
 * takes, and which of the app's colours and text styles it uses. */

import { byCode, groupBy } from "../scan/counting.js";
import type { Category, FrameworkId, FrameworkScan, ScanResult, ScreenRef } from "../scan/types.js";
import { jsReader } from "./js-reader.js";
import { kotlinReader } from "./kotlin-reader.js";
import type { ComponentReader, Declaration, Placement } from "./reader.js";
import { type AppSources, codeFiles, type FrameworkSources } from "./sources.js";
import { swiftReader } from "./swift-reader.js";
import { tokenUsesReader } from "./token-uses.js";

export { CATEGORIES, type Category } from "../scan/types.js";

export interface ComponentInfo {
  /** The scan's id for the view. */
  id: string;
  name: string;
  framework: FrameworkId;
  file: string;
  line: number;
  kind: ScreenRef["kind"];
  category: Category;
  /** Whether an agent's map names it as one of the design system's components. */
  designSystem: boolean;
  /** How many places in other code place it, and the files they're in, most first. */
  uses: number;
  usedIn: string[];
  /** Places of its name as near another component of that name as this one, so either could be meant. */
  sharedUses: number;
  /** As the code writes them: `title: String`, `onClick: () -> Unit`. */
  params: string[];
  /** The keys of the colours and text styles its code refers to. */
  colors: string[];
  typeStyles: string[];
  /** Its declaration's code; empty when it couldn't be found. */
  source: string;
}

/** Each category by the end of a view's name: whole name parts, so `Tabletop` isn't a `Tab` nor `Labelled` a label. */
const CATEGORY_SUFFIXES: [RegExp, Category][] = [
  [/(?:Screen|Page|Scene|Route)$/, "screen"],
  [/(?:Button|CTA|Fab|FAB|Action)$/, "button"],
  [/(?:Row|Cell|Item|Tile)$/, "list"],
  [/(?:Card|Panel|Sheet|Banner)$/, "card"],
  [/(?:Header|Footer|Bar|Toolbar)$/, "header"],
  [/(?:Field|Input|Toggle|Switch|Picker|Checkbox|Slider|Stepper|Search)$/, "input"],
  [/(?:Label|Badge|Chip|Tag|Pill|Text|Title)$/, "label"],
  [/(?:Image|Avatar|Icon|Thumbnail|Logo|Photo)$/, "media"],
];

export const categoryOf = (name: string, kind: ScreenRef["kind"]): Category =>
  CATEGORY_SUFFIXES.find(([suffix]) => suffix.test(name))?.[1] ?? (kind === "screen" ? "screen" : "other");

/** A view's category: what an agent's map says, else its name's. */
const categoryOfView = (view: ScreenRef): Category => view.category ?? categoryOf(view.name, view.kind);

/** The reader of `sources`' views; with `previews`, a Compose preview the scan lists is a view too. */
export function readerOf(sources: FrameworkSources, options: { previews?: boolean } = {}): ComponentReader {
  if (sources.framework === "swiftui") return swiftReader(sources.files);
  if (sources.framework === "compose") return kotlinReader(sources.files, options);
  return jsReader(sources.files);
}

/** `source` cut to its first `maxLines` lines, ending in `…` when cut. */
export function firstLines(source: string, maxLines: number): string {
  const lines = source.split("\n");
  return lines.length > maxLines ? `${lines.slice(0, maxLines).join("\n")}\n…` : source;
}

interface ViewPlacements {
  own: Placement[];
  /** As near another view of the same name. */
  shared: Placement[];
}

/** How near a placement in `rel` is to a view declared in `file`: the same file, else the folders they share. */
export function nearness(file: string, rel: string): number {
  if (file === rel) return Number.POSITIVE_INFINITY;
  const declared = file.split("/");
  const placed = rel.split("/");
  let shared = 0;
  while (shared < declared.length - 1 && declared[shared] === placed[shared]) shared++;
  return shared;
}

/** Each view's placements, by id. A name shared by several views is credited to the one declared nearest; a
 * placement as near two of them is shared by both, since the code alone doesn't say which it means. */
function placementsByView(views: ScreenRef[], placements: Placement[]): Map<string, ViewPlacements> {
  const byName = groupBy(views, (v) => v.name);
  const out = new Map<string, ViewPlacements>(views.map((v) => [v.id, { own: [], shared: [] }]));
  for (const placement of placements) {
    const named = byName.get(placement.name) ?? [];
    const near = named.map((v) => nearness(v.file, placement.rel));
    const most = Math.max(...near);
    const nearest = named.filter((_, i) => near[i] === most);
    for (const view of nearest) out.get(view.id)?.[nearest.length === 1 ? "own" : "shared"].push(placement);
  }
  return out;
}

/** The places using a view: its placements outside its own declaration. */
function usesOf(
  view: ScreenRef,
  declaration: Declaration | undefined,
  placements: ViewPlacements | undefined,
) {
  const outside = (list: Placement[] = []) =>
    list.filter(
      (p) => !(declaration && p.rel === view.file && p.at >= declaration.start && p.at < declaration.end),
    );
  const own = outside(placements?.own);
  const byFile = [...groupBy(own, (p) => p.rel)].sort(
    (a, b) => b[1].length - a[1].length || byCode(a[0], b[0]),
  );
  return {
    uses: own.length,
    usedIn: byFile.map(([rel]) => rel),
    sharedUses: outside(placements?.shared).length,
  };
}

function frameworkComponents(scan: FrameworkScan, sources: FrameworkSources): ComponentInfo[] {
  const reader = readerOf(sources);
  const texts = new Map(codeFiles(sources).map((f) => [f.rel, f]));
  const placements = placementsByView(
    scan.screens,
    reader.placements(new Set(scan.screens.map((s) => s.name))),
  );
  const tokenUses = tokenUsesReader(scan.tokens, scan.framework, scan.platforms[0]);
  return scan.screens.map((view) => {
    const declaration = reader.declaration(view);
    const file = texts.get(view.file);
    const source = declaration && file ? file.text.slice(declaration.start, declaration.end) : "";
    const code = declaration && file ? file.code.slice(declaration.start, declaration.end) : "";
    return {
      id: view.id,
      name: view.name,
      framework: view.framework,
      file: view.file,
      line: view.line,
      kind: view.kind,
      category: categoryOfView(view),
      designSystem: view.designSystem === true,
      ...usesOf(view, declaration, placements.get(view.id)),
      params: declaration?.params ?? [],
      ...tokenUses(source, code),
      source,
    };
  });
}

/** Every view the scan found, components first, the design system's first of them, then by how often they're used. */
export function inventory(scan: ScanResult, sources: AppSources): ComponentInfo[] {
  const out: ComponentInfo[] = [];
  for (const framework of scan.frameworks) {
    const own = sources.get(framework.framework);
    if (own) out.push(...frameworkComponents(framework, own));
  }
  return out.sort(
    (a, b) =>
      Number(a.kind === "screen") - Number(b.kind === "screen") ||
      Number(b.designSystem) - Number(a.designSystem) ||
      b.uses - a.uses ||
      byCode(a.name, b.name) ||
      byCode(a.id, b.id),
  );
}
