import { themesOutside } from "./compose-external-theme.js";
import { composeTokens } from "./compose-tokens.js";
import { composeViews, navigationNotRead } from "./compose-views.js";
import { kotlinSources } from "./kotlin-sources.js";
import type { FrameworkPlugin } from "./plugin.js";

/** Jetpack Compose (and Compose Multiplatform): its views, the links between its screens, and its design tokens. */
export const compose: FrameworkPlugin = {
  id: "compose",
  platforms: ["android"],
  async scan(ctx) {
    const sources = await kotlinSources(ctx);
    if (!sources.some((s) => s.compose)) return undefined;
    const { views, links, starts, placements, unresolvedLinks } = composeViews(sources);
    const unread = navigationNotRead(sources);
    return {
      views,
      links,
      starts,
      placements,
      unresolvedLinks,
      tokens: await composeTokens(ctx, sources),
      themesOutside: themesOutside(sources),
      ...(unread.length > 0 && { navigationNotRead: unread }),
    };
  },
  tokens: async (ctx) => composeTokens(ctx, await kotlinSources(ctx)),
};
