/**
 * An app's tokens with some files changed: only the changed files are read again (with the files their tokens'
 * values are reached through, and the app's manifests), and their tokens take the place of the ones they declared.
 * Keys stay those of the unchanged tokens, so a view and its base name the same token the same way.
 */

import type { FrameworkPlugin, ScanContext } from "../frameworks/plugin.js";
import type { SourceFile } from "../scan/files.js";
import type { ColorTheme, ColorToken, DesignTokens, TypeStyle } from "../scan/types.js";

/** Files a framework's token reading needs beside the changed ones: manifests and Tailwind's configs. */
const MANIFEST = /(?:^|\/)(?:package\.json|tailwind\.config\.[cm]?[jt]s)$/;

/** The files a token's values are written in or reached through. */
const filesOfColor = (c: ColorToken) =>
  [c.locations?.light, c.locations?.dark].flatMap((l) =>
    l ? [l.file, ...(l.via ?? []).map((v) => v.file)] : [],
  );
const filesOfStyle = (s: TypeStyle) =>
  [s.locations?.fontFamily, s.locations?.fontSize, s.locations?.fontWeight].flatMap((l) =>
    l ? [l.file, ...(l.via ?? []).map((v) => v.file)] : [],
  );

/** Whether a token is one a change to `files` may redefine: declared in one of them, or with a value written in or
 * reached through one (`colors.primary = palette.blue`, with `palette` changed). */
const touchedBy = (files: ReadonlySet<string>) => ({
  color: (c: ColorToken) => files.has(c.source) || filesOfColor(c).some((f) => files.has(f)),
  style: (s: TypeStyle) => filesOfStyle(s).some((f) => files.has(f)),
});

/** Every file holding a token's value, which a change to may redefine the app's tokens. */
export function tokenFiles(tokens: DesignTokens): Set<string> {
  const colors = [...tokens.colors, ...(tokens.themes ?? []).flatMap((t) => t.colors)];
  return new Set([
    ...colors.flatMap((c) => [c.source, ...filesOfColor(c)]),
    ...tokens.typeStyles.flatMap(filesOfStyle),
  ]);
}

/** `base` with `from`'s tokens put in, each in the place the one it replaces had (matched by reference), new ones
 * last; base tokens `dropped` says are gone are left out. */
function merged<T extends { reference?: string; name: string }>(
  base: T[],
  from: T[],
  dropped: (t: T) => boolean,
): T[] {
  const id = (t: T) => t.reference ?? t.name;
  const fresh = new Map(from.map((t) => [id(t), t]));
  const kept = base.flatMap((t) => {
    const replacement = fresh.get(id(t));
    if (replacement) fresh.delete(id(t));
    return replacement ? [replacement] : dropped(t) ? [] : [t];
  });
  return [...kept, ...fresh.values()];
}

function mergedThemes(
  base: ColorTheme[],
  from: ColorTheme[],
  dropped: (c: ColorToken) => boolean,
): ColorTheme[] {
  const names = [...new Set([...base.map((t) => t.name), ...from.map((t) => t.name)])];
  return names
    .map((name) => ({
      name,
      colors: merged(
        base.find((t) => t.name === name)?.colors ?? [],
        from.find((t) => t.name === name)?.colors ?? [],
        dropped,
      ),
    }))
    .filter((t) => t.colors.length > 0);
}

/**
 * `base`'s tokens after `changed` (each path's new text, or null when it's deleted), read by `plugin` from `ctx`'s
 * files (with `read` giving each one's text in the view), plus `alwaysRead` (files every reading of the tokens needs,
 * such as a hex helper). Undefined when nothing changed declares or reaches a token, so the view keeps `base`.
 */
export async function changedTokens(
  plugin: FrameworkPlugin,
  base: DesignTokens,
  changed: ReadonlyMap<string, string | null>,
  ctx: Omit<ScanContext, "files"> & { files: SourceFile[] },
  declares: (rel: string) => boolean,
  alwaysRead: ReadonlySet<string>,
): Promise<DesignTokens | undefined> {
  const paths = new Set([...changed.keys()].filter(declares));
  if (paths.size === 0) return undefined;
  const touched = touchedBy(paths);
  const colors = [...base.colors, ...(base.themes ?? []).flatMap((t) => t.colors)].filter(touched.color);
  const styles = base.typeStyles.filter(touched.style);
  // The files declaring a touched token are read again too, so its value is worked out from the view's text.
  const declaring = new Set([...paths, ...colors.map((c) => c.source), ...styles.flatMap(filesOfStyle)]);
  const wanted = new Set([...declaring, ...colors.flatMap(filesOfColor), ...alwaysRead]);
  const found = await plugin.tokens({
    ...ctx,
    files: ctx.files.filter((f) => wanted.has(f.rel) || MANIFEST.test(f.rel)),
  });
  const fresh = {
    colors: found.colors.filter((c) => c.reference && declaring.has(c.source)),
    styles: found.typeStyles.filter((s) => s.reference && filesOfStyle(s).some((f) => declaring.has(f))),
    themes: (found.themes ?? []).map((t) => ({
      ...t,
      colors: t.colors.filter((c) => declaring.has(c.source)),
    })),
  };
  const gone = touchedBy(declaring);
  const nothing = !colors.length && !styles.length && !fresh.colors.length && !fresh.styles.length;
  const newFonts = found.fonts.some((f) => !base.fonts.includes(f));
  if (nothing && !newFonts && fresh.themes.every((t) => !t.colors.length)) return undefined;
  const typeStyles = merged(base.typeStyles, fresh.styles, gone.style);
  // A family only a dropped style used leaves with it; one the code still writes elsewhere stays.
  const dropped = new Set(base.typeStyles.filter(gone.style).map((s) => s.family));
  const kept = (family: string) => !dropped.has(family) || typeStyles.some((s) => s.family === family);
  return {
    ...base,
    colors: merged(base.colors, fresh.colors, gone.color),
    typeStyles,
    ...(base.themes || fresh.themes.length
      ? { themes: mergedThemes(base.themes ?? [], fresh.themes, gone.color) }
      : {}),
    fonts: [...new Set([...found.fonts, ...base.fonts.filter(kept)])],
  };
}
