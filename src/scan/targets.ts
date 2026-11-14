/**
 * An app's own code beside its other targets: a watch app, widgets, app extensions, a TV, Wear or car module, and
 * the assets only previews show. Where the code writes a token twice, the app's own copy is the one a scan keeps.
 */

/** The names another target's folder ends with, matched as the whole name or its end so the app's own feature
 * folders (`TVShows`, `LinkPreview`, `ColorExtension`, `WatchParty`, `AppIntents`) aren't one: `ShopWatchKit
 * Extension`, `Shop Watch App`, `ShopWidgets`, `ShopIntents`, `ShareExtension`, `Shop.appex`. */
const APPLE_TARGET = new RegExp(
  `(?:${[
    String.raw`Watch(?:Kit)? ?(?:App|Extension)`,
    String.raw`(?:watch|tv)OS(?: ?App)?`,
    String.raw`Widgets?(?: ?Extension)?`,
    String.raw`Intents(?:UI)? ?Extension`,
    String.raw`.(?<!^App)Intents(?:UI)?`,
    String.raw`Notification(?:Content|Service)(?: ?Extension)?`,
    String.raw`(?:Share|Action|Keyboard|Today|Stickers?|iMessage|FileProvider|Broadcast(?:Upload)?) ?Extension`,
    String.raw`App ?Clip`,
    String.raw`\.appex`,
  ].join("|")})$`,
);
/** Preview-only assets: Xcode's `Preview Content` folder. */
const PREVIEWS = /^Preview ?Content$/;
/** An Android module that isn't the phone app, by its folder's name: `wear`, `tv`, `automotive`, `app-wear`. */
const ANDROID_MODULE = /^(?:wear(?:os)?|tv|automotive|watch)$|[-_](?:wear|tv|automotive|watch)$/i;

/** The folders on `rel`'s path that can name a target: all of them, or in a Gradle module (`app/src/main/…`) only
 * those above `src`, as the ones under it are packages (`com/shop/watch`) and source sets. */
function targetFolders(rel: string): string[] {
  const folders = rel.split("/").slice(0, -1);
  const src = folders.indexOf("src");
  return src < 0 ? folders : folders.slice(0, src);
}

const isTargetFolder = (folder: string) =>
  APPLE_TARGET.test(folder) || PREVIEWS.test(folder) || ANDROID_MODULE.test(folder);

/** Whether `rel` is in a folder of one of the app's other targets, by the folders on its path. */
export function isOtherTarget(rel: string): boolean {
  return targetFolders(rel).some(isTargetFolder);
}

/** `items` with those in the app's own code first, keeping the order within each. */
export function appFirst<T>(items: readonly T[], fileOf: (item: T) => string): T[] {
  const own: T[] = [];
  const others: T[] = [];
  for (const item of items) (isOtherTarget(fileOf(item)) ? others : own).push(item);
  return [...own, ...others];
}
