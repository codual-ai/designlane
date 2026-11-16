/** A tokens.json in Designlane's format, with just the tokens a test needs; spacing, radii and unnamed colours are
 * as files written before Designlane left them to DESIGN.md hold them. */

interface ColorToken {
  key: string;
  hex: string;
  /** False for a colour the code writes without a name. */
  named?: boolean;
  dark?: string;
}

interface StyleToken {
  key: string;
  size?: number;
  weight?: number;
}

export function tokensJson({
  colors = [],
  spacing = [],
  radii = [],
  partial = false,
  app,
  platform,
  styles = [],
  themes = [],
}: {
  colors?: ColorToken[];
  spacing?: number[];
  radii?: number[];
  /** The scan couldn't read the whole app. */
  partial?: boolean;
  /** The app's name, as the scan records it. */
  app?: string;
  /** The platform the app's code is for, as the scan records it. */
  platform?: "ios" | "android";
  styles?: StyleToken[];
  /** The app's other themes, each with its own colours. */
  themes?: { name: string; colors: ColorToken[] }[];
}) {
  const colorValue = (hex: string) => ({ colorSpace: "srgb", components: [0, 0, 0], hex });
  const colorGroup = (list: ColorToken[]) =>
    Object.fromEntries(
      list.map((color) => [
        color.key,
        {
          $type: "color",
          $value: colorValue(color.hex),
          $extensions: {
            designlane: {
              ...(color.named !== false && { reference: `Theme.${color.key}` }),
              source: "Theme.swift",
              uses: 1,
              ...(color.dark && { modes: { dark: colorValue(color.dark) } }),
            },
          },
        },
      ]),
    );
  return JSON.stringify({
    $description: "test",
    ...((partial || app || platform) && {
      $extensions: {
        designlane: { ...(app && { app }), ...(partial && { partial: true }), ...(platform && { platform }) },
      },
    }),
    ...(colors.length > 0 && { color: colorGroup(colors) }),
    ...(themes.length > 0 && {
      theme: Object.fromEntries(
        themes.map((theme) => [
          theme.name,
          { $extensions: { designlane: { name: theme.name } }, color: colorGroup(theme.colors) },
        ]),
      ),
    }),
    ...(spacing.length > 0 && {
      spacing: Object.fromEntries(
        spacing.map((value) => [`space-${value}`, { $type: "dimension", $value: { value, unit: "px" } }]),
      ),
    }),
    ...(radii.length > 0 && {
      radius: Object.fromEntries(
        radii.map((value) => [`radius-${value}`, { $type: "dimension", $value: { value, unit: "px" } }]),
      ),
    }),
    ...(styles.length > 0 && {
      typography: Object.fromEntries(
        styles.map((style) => [
          style.key,
          {
            $extensions: { designlane: { name: style.key, reference: `Font.${style.key}`, uses: 1 } },
            fontFamily: { $type: "fontFamily", $value: "SF Pro" },
            ...(style.size !== undefined && {
              fontSize: { $type: "dimension", $value: { value: style.size, unit: "px" } },
            }),
            ...(style.weight !== undefined && { fontWeight: { $type: "fontWeight", $value: style.weight } }),
          },
        ]),
      ),
    }),
  });
}
