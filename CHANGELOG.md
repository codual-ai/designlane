# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- Constants named for a spacing or a corner radius are named in `scales`, each when code in another file uses it,
  whatever their container is called: in Compose (`val ThumbnailCornerRadius = 3.dp`, `DEFAULT_PADDING`,
  `object MailDimens { val SnackbarOuterMargin = 12.dp }`, and shapes, `RoundedCornerShape(12.dp)`), SwiftUI
  (`enum UIConstants { static let urlBarMargin: CGFloat = 10 }`, and `extension CGFloat` members, used as
  `.padding(.statusColumnsSpacing)` too, but not a view's own), and React Native (`export const ROW_RADIUS = 10`,
  `Layout.headerPadding`). Not one declared in a function or as private, nor a time, a score or a fraction.
- A coding agent's map of the design system: `designlane --from-agent` reads an `agent.json` of version 1, which gives
  each color (with its dark value and its themes), text style, spacing and corner radius with the file and line it's
  written on. Designlane reads each value there with its own readers, following a color written as another's name
  (`primary = Purple40`), and keeps only those the code bears out, saying where and why for the rest. The map's tokens
  then are the app's design system: of each kind the map gives, Designlane's own named tokens give way to it. What's
  left out is summed up a line per kind of reason, and `designlane/agent-check.json` lists every entry with its place,
  a stable `kind` and why, for the agent to fix its map by. An `agent.json` without a version is read as before.

### Fixed

- A Compose app with a theme per object (`BrandColorScheme`, `AuroraColorScheme`, each with its light and dark
  scheme) gets its Material roles from the theme the code names as its default (`AppTheme.DEFAULT to …`,
  `getOrDefault(theme, …)`, `else -> …`), or one named default, not the fullest; and each theme's light scheme pairs
  with its own dark one.

## 0.5.0 - 2026-11-22

### Added

- `designlane doctor [dir]` lists the screens whose layout Designlane can't read, with where, and sums up what it may
  read wrong: `--all` lists every issue with where it is, `--screen <name>` shows one screen's issues, parts and
  layout, and `--json` prints the issues for scripts. It reads offline and sends nothing.
- `app.layoutIssues(screen)` in `designlane/read`: why a screen's layout can't be read whole (`unreadable`, with its
  reason, the view and where), and what may be wrong in one that was (`issues`), with `UNREADABLE_REASONS`,
  `LAYOUT_ISSUE_KINDS` and `LayoutIssuesSchema`. Their values stay the same from release to release.
- `app.skipped` says what the scan left out: whether it stopped at its limit of files, and the folders it couldn't
  open. `designlane doctor` warns about them.

### Changed

- `layoutOf` and `screenParts` know more of each framework's elements: SwiftUI's shapes, progress views, gradients,
  `GroupBox` and image loaders (`KFImage`, `WebImage`, `LazyImage`); Compose's dividers, progress indicators, menu and
  drawer items, segmented buttons and `Layout`; React Native's `ActivityIndicator`, SVG shapes, icons and a context's
  `.Provider`, which passes through to what it holds. Snackbars and tooltips are left out, like dialogs. A type's
  members that are values (`DispatchQueue.main`, `Date.now`) and assignments (`rows += Row { … }`) are no longer read
  as elements.
- `layoutOf` reads a Compose function the scan lists that's annotated as a preview (`@Composable @Preview fun …`),
  which had no layout: a preview, or a real composable given `@Preview` too.

### Fixed

- `stringsIn` keeps the spaces React shows in JSX text: `<Text>{price} / {period}</Text>` is " / ", not "/", and
  `<Text>  Your cart </Text>` keeps its spaces. Only whitespace with a line break in it, at a line's start or end, is
  left out, as React leaves it out.

## 0.4.0 - 2026-11-21

### Added

- `designlane/read`, a library entry for reading an app's code from another tool: `readApp(root)` reads the app once;
  `app.tokensIn(path, text?)` lists every colour, text style, font, spacing and corner radius one file uses, named
  token or value written in place, each with its exact span; `app.withChanges(files)` gives a copy-on-write view with
  some files changed, reading only those again; `app.update(path, text)` changes the app itself; and
  `findFrameworks(root)` tells an app's frameworks from file names and manifests alone. Offline and deterministic,
  with a zod schema for every result, and none of the command line, MCP server or Figma sync loaded.
- Spacing and corner radius scales the code names sync to Figma as number variables, scoped to gaps and to corners:
  a Swift type of that name (`enum AppSpacing`, `Theme.CornerRadius`), a Kotlin object or data class
  (`object Radii { val card = 12.dp }`, `LocalSpacing.current.medium`), or an exported JavaScript object
  (`export const space = { md: 8 }`, `theme.radii.card`). Each step in tokens.json records how the code refers to
  it, its uses and where its value is written, so a changed value updates its variable and a renamed step keeps it.
  A scale needs two steps and a use outside its own file; steps marked deprecated, and sizes (`rowHeight`), are left
  out. Values written in place stay in DESIGN.md only, as before. A Figma file an older version synced with bare spacing
  variables (`spacing/16`) has each renamed to the named step with its value.
- DESIGN.md and catalog.html show the named scales with each step's reference and uses, then the values written in
  place.

- `tokensIn` names a color the app's themes declare when the code reads it through the theme the user picks
  (`theme.tintColor`), with its default theme's value and `themed: true`; and a color or text style read from a theme
  declared in a library (`CompanyTheme.colors.primary`) as `unresolved`, named as the code writes it, with no value.
- `app.stringsIn(path, text?)` lists the text one file shows people, each with its exact span: words written in the
  code, and translated strings named by key, with their default-language text from the app's strings files, or
  `null` when none has it.
- `app.layoutOf(screen)` gives a screen's layout as a tree of containers, conditionals, loops, placed views and the
  elements it shows, each with its span and an id from its path by kind that stays the same when other kinds of
  nodes are added around it, for comparing two versions of a screen.
- `app.screenParts(screen)` lists a screen's main parts, for picking one to change, each with its id in its view's
  layout, a label to show ("Header", "Plans") and its span; following the one view a screen places and the biggest
  branch of an `if` over all of it.
- `layoutOf` reads a SwiftUI `#if` as a `conditional` with a branch per clause, rather than both sides as shown, and
  places the Compose overload whose parameters take a call's arguments, rather than the first of that name.
- `app.filesFor(screen)` lists the files that explain a screen or component, each with why: its declaration, the
  views it places at any depth, the types holding its state, the project's files a React Native screen imports, and
  where the tokens it uses are declared. Views answer for their changes, following a view in a file they add, and
  taking such a view's id.

### Changed

- A React Native or Tailwind text style that sets no font family or weight takes them from the text around it, so
  they're no longer written as the platform's font and the regular weight (`SF Pro`, 400): tokens.json, Figma and
  DESIGN.md leave them out, and the scan records them under `inherits`. A style in Figma keeps the font it has. A
  text style a coding agent gives without a weight is no longer taken for the regular one.
- Scans read Swift and Kotlin a little faster: a file with no `#Preview` isn't searched for one, and comments and
  strings are blanked in runs rather than one character at a time.

### Fixed

- A Swift colour given its opacity keeps it: `UIColor(0x000000, alpha: 0.05)` and `UIColor(hex: "#3366CC", alpha: 0.3)`
  were read as opaque, and so was a colour with `.withAlphaComponent(0.7)` (which sets the opacity) or `.opacity(0.5)` (which multiplies it) after it. A colour whose opacity is an expression (`alpha: 0.5 * fade`) is left out, not read as opaque. A colour with opacity chained after it records no place its value is written, so an edit
  refuses it rather than changing the colour without its opacity.

## 0.3.1 - 2026-11-16

### Fixed

- The GitHub Action is named "Designlane Sync" so it can be listed on the GitHub Marketplace, where "Designlane" is
  reserved. Nothing else changes.

## 0.3.0 - 2026-11-15

### Changed

- Renamed to Designlane: the npm package and its command are `designlane`, the repo is `codual-ai/designlane`, the
  Action and the Figma plugin are named Designlane, and the output folder is `designlane/`. New files carry their
  data under `$extensions.designlane`, the plugin's pull requests come from `designlane/figma-…` branches, and the
  MCP server is named `designlane`. The library's `OUTPUT_DIR` is now `"designlane"`.
- The copyright holder in NOTICE is now Hyperion Arc Inc.

### What to do

Nothing is required: everything set up under the old name keeps working.

- **Your app's files stay where they are.** An app with a tokens file in `designmap/` and none in `designlane/` keeps
  writing there, from the CLI, the MCP server and the Action, so nothing is moved or copied; `designlane edit` and the plugin
  find `designmap/tokens.json` too. tokens.json files with `$extensions.designmap` read as before, and so do component
  pictures saved under the old name.
- **Figma files synced before carry on.** The plugin keeps its id and the data it stores on variables, styles,
  collections and its page, so nothing is synced again; a collection or page named "(Designmap)" keeps its name until
  you rename it. A connection to `designlane/tokens.json` in an app that still has `designmap/tokens.json` connects to
  that one.
- **Open pull requests opened from Figma** on `designmap/figma-…` branches still show as "Pull request open".
- **Update the Action reference** to `codual-ai/designlane@v0.3.0`. `codual-ai/designmap@v0.2.x` keeps working through
  GitHub's redirect, but only `designlane` gets new versions.
- **Use the `designlane` command** (`npx designlane`, `designlane prompt`, `designlane edit`) and re-add the MCP server
  as `claude mcp add designlane -- npx designlane mcp .`. The `designmap` package stays at 0.2.1.

## 0.2.1 - 2026-11-15

### Fixed

- The GitHub Action can be listed on the GitHub Marketplace: a description within its 125-character limit, and an
  icon and colour.
- The README no longer links a video that isn't there.

## 0.2.0 - 2026-11-14

### Added

- Where each token's values are written, in tokens.json under `$extensions.designmap.locations` (files without it
  read as before): for a colour, its light and dark values (file, line, the characters of exactly the text to replace
  in UTF-16 code units, and `kind`, what that text is: a literal without its quotes, an expression, a font name
  holding the weight, a family's identifier, or an asset's `components`),
  from Swift code, asset catalogs, theme sets, Compose constants, Material schemes and colour classes, Android
  `values` and `values-night` resources, React Native theme objects and palettes, Tailwind configs and CSS `@theme`;
  for a text style, its family, size and weight, from Swift font helpers, Compose typography and named styles,
  Android text appearances, and React Native typography objects and named font sizes. A value the code reaches
  through other names (`link: colors.blue0`, `@color/blue600`, a parent style, a spread style) records each name on
  the way, under `via`. A value worked out from another (`Brand.copy(alpha = 0.5f)`), or set where a helper is used,
  records none, as does a style made from a helper (`.small.bold()`), whose values are the helper's, and a family
  built as a template. Also on the scan's `ColorToken` and `TypeStyle` as `locations`.
- Design to code from Figma: the plugin lists each synced colour (Light and Dark, in every theme) and text style
  (size, weight, font) a designer changed in Figma, as "Changed in Figma, not in code", told apart from a code change
  Figma hasn't taken by the value the two last had alike, kept on each variable and style (renames don't count). The
  changes ticked get their code edits planned with `planEdit` against the connected branch's latest commit, each shown
  as file, line, before and after, or why it can't be made; those ticked then open a pull request: one commit on a new
  `designmap/figma-<date>-<hash>` branch, titled "Design changes from Figma: <n> values", listing each change. It needs
  a second fine-grained token with Contents and Pull requests set to Read and write, asked for the first time and kept
  on this computer per repo; the read-only token stays for syncing.
  Apply keeps the values changed in Figma as they are, applying everything else, until the code has them. A change
  already in an open Designmap pull request into the connected branch, found by a marker in its description, shows
  "Pull request open" with its link instead of a box to tick (if the read-only token can't list pull requests, the
  changes show as before with a note). A value the code changed too shows both values, "Code: … · Yours: …", with
  **Keep the code's**, which Apply sets, or **Use mine**, which is planned from the code's value now. Any other
  change not in a pull request has **Set back to the code's value**, which Apply sets too, so a designer can drop a
  change, including one from a picked tokens.json.
- `designmap edit <token> <property> <value>`: changes a colour's light or dark value, or a text style's family, size
  or weight, in the code where tokens.json says it's written, written the way the code writes it (hex case and
  length, `0xFF…` ARGB, `Color(red:green:blue:)` with the same decimals or `/ 255`, `rgb()`, asset catalog
  components, `22.sp`, `.semibold`, `FontWeight.SemiBold`, `"600"`), and prints the diff; `--dry-run` writes
  nothing. A colour reached through a name gets its own value in place of the name, so the name's other users keep
  theirs, when that value is in the same file and stands on its own there. It refuses, with the reason, whatever it can't change safely: a value the code changed since the scan, a
  named or computed colour, a font's name holding its weight, a change that would also change another token (written
  in the same place or reaching it through names), a value that can't be copied in place of a name safely, or a
  text style's value from a style it builds on. `planEdit` and `applyEdit` are exported for other tools.

### Changed

- Library: `SyncTheme` has the theme's `key` in tokens.json, which a code edit names its colours by.
- A colour or text style written in both the app and another of its targets (a watch app, a widget, an app
  extension, a Wear, TV or car module, preview assets) is read from the app's own copy, which also takes the plain
  key in tokens.json.

## 0.1.0 - 2026-11-14

### Added

- `designmap/catalog.html`: one offline page, light and dark, with the app's colours (and each theme's), text styles,
  the spacing and corner radii the code uses, and every component and screen with its kind, file, uses, parameters
  and the colours and text styles it uses, searchable and filterable by kind.
- Pictures of components drawn by a coding agent: the MCP tools `find_components`, `get_component` and
  `save_preview`. Pictures are HTML and styles only (no scripts, event handlers or external URLs), saved in
  `designmap/previews/`, shown in a sandbox, and marked out of date when the component's code changes.
- `designmap/drift.md` and the MCP tool `check_drift`: colours written as values (with the named colour to use when
  one matches), spacing and corner values off the scale the code uses, text styles written in place that a named one
  matches, and near-duplicate components (same-named copies too), each with where it is. Theme and token files and
  previews are left out.
- `--no-write`: print what was found, and write no file.

- A coding agent can read an app whose setup Designmap's own reading misses: `designmap prompt` prints the
  instructions (for example `claude -p "$(npx designmap prompt)"`), and `designmap --from-agent designmap/agent.json`
  adds the colours and text styles the agent found that the code bears out (a value it writes, a name it uses),
  leaving out and naming the rest.

- Apps with several themes: each theme beside the default one is read with its own colours, Light and Dark, and
  written under `theme` in tokens.json, keyed by its name (old files without it read as before). The Figma plugin
  makes a collection for each, "Shop · Desert (Designmap)", matching, renaming and deprecating a theme's
  variables only within it, and DESIGN.md lists each theme's colours. SwiftUI: types conforming to one protocol of
  colours, paired light and dark by name or a `scheme` member (types with neither stay plain colours), each
  colour known by the protocol's member (`ColorSet.tintColor`); the first theme declared is the default. React
  Native: the themes beside a light and dark one that were left out before (`themes.black`, presets, a
  `darkContrastTheme` in its own file). The CLI names them.
- SwiftUI colours declared with `.init(hex:)` (`let ink: Color = .init(hex: 0x112233)`).
- Android text styles kept in XML resources (`TextAppearance.*` styles and those inheriting one, followed up to
  Material's own), with their size, family and weight.
- React Native font sizes an app names on its own (`variables.fontSizeLarge`, `FONT_SIZE_SMALL`), as text styles
  holding a size.

- React Native colours of a theme chosen by platform (`Platform.OS === "ios" ? blackIOS : blackAndroid`,
  `Platform.select`, in the file or imported) read as iOS's, as a design shows them.

- React Native screens: components React Navigation's screens show (`component`, `getComponent`, a children
  function, static `screens`, an app's own stack creators, through requires and imports), Expo Router's route files
  (layouts as containers), a modal's whole content, and the shared classifier's signs (lists, scrolling, safe areas).

- React Native text styles, spacing and corner radii: named typography objects with how often the code reaches
  them, styles written in place (spread named styles included), constants and default exports followed, font file
  names read as family and weight, and Tailwind's text, spacing and rounded classes at its sizes or a config's.

- React Native colours: theme objects (light and dark paired, aliases followed, one light and one dark theme kept of
  several), Tailwind configs and CSS `@theme` colours with the class names using them, and colours written into
  styles. Their tokens name each colour as the code does, in Figma's web code slot. A React Native app's native code
  isn't read as an app of its own.

### Changed

- Library: `writeOutputs` also writes catalog.html and drift.md, and returns their paths as `catalog` and `drift`.

- A sync follows a theme the code renamed (`MainTheme.colors.error` becoming `BoltTheme.colors.error`) with its
  values unchanged: each variable and text style keeps its name and everything using it, however many changed.

- tokens.json holds only the colours and text styles the code names, the design system a sync keeps. Colours and
  text styles written in place, and spacing and corner radii, are listed in DESIGN.md only, so editing a screen's
  layout no longer shows up as design-system changes in Figma. A Figma file synced before this sees those
  spacing, radius, unnamed colour and in-place text style variables marked deprecated on its next sync.

- A repo with both an iPhone and an Android app gets a tokens file for each, `tokens.ios.json` and
  `tokens.android.json`, instead of being refused. A tokens file Designmap wrote in the other layout is removed, and
  the CLI says so.
- Library: `toDesignTokens(scan, framework)` takes the framework to write when a scan has two, and throws for one the
  scan doesn't have; `writeOutputs` returns `tokens` as a list and the files it `removed`. `APP_TOKENS_FILES` and
  `TOKENS_FILE` name the files.

### Removed

- The scan's `otherThemes` and the note naming them: those themes are read now.

