import path from "node:path";
import { byNumber, mostCommon } from "../scan/counting.js";
import { palette } from "../scan/palette.js";
import { appFirst } from "../scan/targets.js";
import { typeScale } from "../scan/type-scale.js";
import type { DesignTokens } from "../scan/types.js";
import { type JsSource, jsSources } from "./js-sources.js";
import type { FrameworkPlugin, ScanContext } from "./plugin.js";
import { rnColors } from "./rn-colors.js";
import { namedFontSizes } from "./rn-font-sizes.js";
import { rnType } from "./rn-type.js";
import { rnViews } from "./rn-views.js";
import { tailwindColors } from "./tailwind-colors.js";
import { TAILWIND_CONFIG } from "./tailwind-config.js";
import { type TailwindType, tailwindType } from "./tailwind-type.js";

/** Packages a React Native app depends on: React Native itself, or Expo, which brings it. */
const RN_PACKAGES = ["react-native", "expo"];

/** The folders of the project's React Native apps: each `package.json` depending on React Native or Expo. */
export async function reactNativeRoots(ctx: ScanContext): Promise<string[]> {
  return (await packages(ctx)).filter((p) => p.reactNative).map((p) => p.root);
}

interface Package {
  root: string;
  reactNative: boolean;
  /** The packages it depends on. */
  depends: string[];
  /** Uses Expo Router, whose route files are the app's screens. */
  expoRouter: boolean;
}

/** Every package in the project, by its folder (`""` is the whole project), and whether it's a React Native app. */
async function packages(ctx: ScanContext): Promise<Package[]> {
  const found: Package[] = [];
  for (const file of ctx.files.filter((f) => f.rel === "package.json" || f.rel.endsWith("/package.json"))) {
    const text = await ctx.read(file);
    let manifest: Record<string, unknown> | undefined;
    try {
      manifest = text ? JSON.parse(text) : undefined;
    } catch {
      continue;
    }
    const depends = ["dependencies", "devDependencies", "peerDependencies"].some((field) => {
      const deps = manifest?.[field];
      return typeof deps === "object" && deps !== null && RN_PACKAGES.some((p) => p in deps);
    });
    const router = ["dependencies", "devDependencies"].some((field) => {
      const deps = manifest?.[field];
      return typeof deps === "object" && deps !== null && "expo-router" in deps;
    });
    const deps = ["dependencies", "devDependencies", "peerDependencies"].flatMap((field) => {
      const list = manifest?.[field];
      return typeof list === "object" && list !== null ? Object.keys(list) : [];
    });
    found.push({
      depends: deps,
      expoRouter: router,
      root: file.rel === "package.json" ? "" : file.rel.slice(0, -"/package.json".length),
      reactNative: depends,
    });
  }
  return found;
}

/**
 * Expo Router's route folders in each app using it: the one the app hands `ExpoRoot` (`require.context("./app/routes")`),
 * else Expo's own, `app/`, or `src/app/` when there's no `app/`.
 */
function expoRouteFolders(all: Package[], sources: JsSource[]): string[] {
  return all
    .filter((p) => p.reactNative && p.expoRouter)
    .map((p) => {
      const inPackage = sources.filter((s) => within(s.rel, [p.root]));
      // The context handed to `ExpoRoot`, in a file importing Expo Router; not one an icon loader makes.
      for (const s of inPackage.filter((f) => /from\s+["']expo-router["']/.test(f.text))) {
        const m = s.text.match(/require\.context\(\s*["']([^"']+)["']/);
        if (m?.[1]) return path.posix.join(path.posix.dirname(s.rel), m[1]);
      }
      const app = p.root ? `${p.root}/app` : "app";
      return inPackage.some((s) => s.rel.startsWith(`${app}/`))
        ? app
        : p.root
          ? `${p.root}/src/app`
          : "src/app";
    });
}

/** Tool configs (`app.config.ts`, `babel.config.js`) aren't the app's styles; a Tailwind config is read on its own. */
const TOOL_CONFIG = /(?:^|\/)[\w-]+\.config\.[cm]?[jt]s$/;

/** Whether `rel` is in one of `roots` (`""` is the whole project). */
export const within = (rel: string, roots: string[]) =>
  roots.some((root) => root === "" || rel.startsWith(`${root}/`));

const ranked = (values: number[]) => mostCommon(values, byNumber).map(({ value }) => value);

/** The app's own scripts: inside its React Native packages, not in a package of its own that isn't React Native (a
 * web embed, a server), nor a tool's config (Tailwind's is kept). */
async function appScripts(ctx: ScanContext) {
  const all = await packages(ctx);
  const roots = all.filter((p) => p.reactNative).map((p) => p.root);
  const scripts = await jsSources(ctx);
  // A package whose code imports React Native is the app's (a local native module, which the app provides it to).
  const others = all
    .filter((p) => !p.reactNative && p.root !== "" && roots.some((r) => within(`${p.root}/`, [r])))
    .map((p) => p.root)
    .filter((o) => !scripts.some((s) => s.reactNative && within(s.rel, [o])));
  // Where a colour or style is declared twice, the app's own copy comes first, over a widget's.
  const sources = appFirst(
    scripts.filter(
      (s) =>
        within(s.rel, roots) &&
        !within(s.rel, others) &&
        (!TOOL_CONFIG.test(s.rel) || TAILWIND_CONFIG.test(s.rel)),
    ),
    (s) => s.rel,
  );
  return { all, roots, sources };
}

/** The design tokens the app's scripts declare. */
async function appTokens(ctx: ScanContext, sources: JsSource[]): Promise<DesignTokens> {
  const tailwind = await tailwindColors(ctx, sources);
  const theme = rnColors(sources, tailwind.files);
  const type = rnType(sources, tailwind.files);
  const fontSizes = namedFontSizes(sources.filter((s) => !tailwind.files.has(s.rel)));
  // Tailwind's classes only in an app using Tailwind: elsewhere `p-4` is just a string.
  const classes: TailwindType =
    tailwind.used || tailwind.named.length > 0
      ? tailwindType(sources, tailwind.fonts)
      : { uses: [], spacing: [], radii: [] };
  const scale = typeScale({ uses: [...type.uses, ...classes.uses], helperFonts: type.helperFonts });
  // A JavaScript copy of a CSS theme's colours (`colors.charcoal[100]` beside `--color-charcoal-100`) is one colour.
  const inTailwind = new Set(tailwind.named.map((c) => `${c.name}|${c.light}`));
  return {
    ...palette({
      ...theme,
      named: [...tailwind.named, ...theme.named.filter((c) => !inTailwind.has(`${c.name}|${c.light}`))],
      references: [...theme.references, ...tailwind.references],
    }),
    typeStyles: [...type.named, ...fontSizes, ...scale.typeStyles].sort(
      (a, b) => b.uses - a.uses || a.name.localeCompare(b.name),
    ),
    fonts: scale.fonts,
    spacing: ranked([...type.spacing, ...classes.spacing]),
    radii: ranked([...type.radii, ...classes.radii]),
  };
}

/** React Native (and Expo): its colours, text styles, spacing and radii, from theme objects, Tailwind and styles. */
export const reactNative: FrameworkPlugin = {
  id: "react-native",
  platforms: ["react-native"],
  async scan(ctx) {
    const { all, roots, sources } = await appScripts(ctx);
    if (roots.length === 0 || !sources.some((s) => s.reactNative)) return undefined;
    const folders = expoRouteFolders(all, sources);
    return {
      views: rnViews(sources, { folders }, new Set(all.flatMap((p) => p.depends))),
      tokens: await appTokens(ctx, sources),
    };
  },
  tokens: async (ctx) => appTokens(ctx, (await appScripts(ctx)).sources),
};
