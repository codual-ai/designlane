/** A small Shop app in a GitHub repo, its Figma file synced from it, and a designer's changes there: what the
 * design-to-code tests start from. */

import type { ToWindow } from "../../figma-plugin/src/messages.js";
import { type ColorSpec, type Files, type StyleSpec, tokensFile } from "./edits.js";
import { fakeGitHub } from "./fake-github.js";
import { plugin, recolor, restyle, type StyleChange } from "./figma-plugin.js";

export const THEME = "src/theme.ts";
export const SHOP: Files = {
  [THEME]: [
    "export const light = { brand: '#FF1A2E', ink: '#112233' };",
    "export const dark = { brand: '#FF5566', ink: '#EEEEEE' };",
    "export const desert = { brand: '#DF915E' };",
    "export const type = { body: { fontFamily: 'SF Pro', fontSize: 17, fontWeight: '400' } };",
  ].join("\n"),
};

const at = (text: string) => ({ file: THEME, text, kind: "literal" as const });

const COLORS: ColorSpec[] = [
  {
    key: "brand",
    reference: "theme.brand",
    light: "#ff1a2e",
    dark: "#ff5566",
    at: { light: at("#FF1A2E"), dark: at("#FF5566") },
  },
  { key: "ink", reference: "theme.ink", light: "#112233", dark: "#eeeeee", at: { light: at("#112233") } },
];
const STYLES: StyleSpec[] = [
  {
    key: "body",
    reference: "type.body",
    family: "SF Pro",
    size: 17,
    weight: 400,
    at: { fontFamily: at("SF Pro"), fontSize: at("17"), fontWeight: at("400") },
  },
];

/** The Shop's tokens.json, its Desert theme keyed `desert` and named `Desert`, as the code names it; `brandLight` for
 * code whose brand colour was changed in place, written as long. */
export function shopTokens({ files = SHOP, brandLight }: { files?: Files; brandLight?: string } = {}) {
  const tokens = tokensFile(files, {
    colors: COLORS.map((color) =>
      color.key === "brand" && brandLight ? { ...color, light: brandLight } : color,
    ),
    styles: STYLES,
    themes: {
      desert: [{ key: "brand", reference: "theme.brand", light: "#df915e", at: { light: at("#DF915E") } }],
    },
  });
  const desert = tokens.theme.desert;
  if (desert) desert.$extensions.designmap.name = "Desert";
  return tokens;
}

export const TOKENS_PATH = "designmap/tokens.json";
export const READ_TOKEN = "github_pat_read";
export const WRITE_TOKEN = "github_pat_write";

/** The Shop in `octo/app`, its tokens.json at `tokensPath`, and a Figma file connected to it and synced. */
export async function syncedShop({ root = "", files = SHOP } = {}) {
  const prefix = root ? `${root}/` : "";
  const tokensPath = `${prefix}${TOKENS_PATH}`;
  const json = JSON.stringify(shopTokens({ files }), null, 2);
  const github = fakeGitHub({
    files: {
      [tokensPath]: json,
      ...Object.fromEntries(Object.entries(files).map(([path, text]) => [prefix + path, text])),
    },
  });
  const app = plugin();
  let plans = 0;
  await app.session({
    type: "connect",
    id: ++plans,
    repo: "octo/app",
    branch: "main",
    path: tokensPath,
    token: READ_TOKEN,
  });
  await app.session({ type: "apply", id: plans });
  const fake = app.fake;

  /** Checks the repo again, and the plan's changes made in Figma. */
  async function check() {
    await app.session({ type: "fetch", id: ++plans });
    const message = app.last();
    if (message?.type !== "plan") throw new Error(`expected a plan, got ${JSON.stringify(message)}`);
    return message.summary.figmaChanges;
  }

  return {
    app,
    github,
    json,
    tokensPath,
    /** The id of the plan on screen. */
    plan: () => plans,
    check,
    /** A designer setting a colour variable's Light or Dark value. */
    recolor: (name: string, mode: "Light" | "Dark", hex: string, collectionName?: string) =>
      recolor(fake, name, mode, hex, collectionName),
    /** A designer setting a text style's family, style or size. */
    restyle: (name: string, change: StyleChange) => restyle(fake, name, change),
    /** What the plugin sent last, for the plan on screen. */
    last: (): ToWindow | undefined => app.last(),
    async planEdits(changes: string[]) {
      await app.session({ type: "planEdits", id: plans, changes });
      return app.last();
    },
    async openPullRequest(changes: string[], token?: string) {
      await app.session({
        type: "openPullRequest",
        id: plans,
        changes,
        ...(token === undefined ? {} : { token }),
      });
      return app.last();
    },
  };
}
