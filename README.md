# Designlane

[![npm](https://img.shields.io/npm/v/designlane.svg)](https://www.npmjs.com/package/designlane)
[![CI](https://github.com/codual-ai/designlane/actions/workflows/ci.yml/badge.svg)](https://github.com/codual-ai/designlane/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

**Your design tools stay in step with your app's code.** Run `designlane` in your iOS, Android or React Native repo
and it reads the colours and text styles your code names, so your design tool's variables and text styles update with
every push.

https://github.com/user-attachments/assets/e6324208-a820-4d70-b27a-24a0337e082c

*An app's design system in Figma, synced from its code: each colour with its light and dark value and how the code
names it (`Theme.accent`).*

- **Always matches the app.** Your design file shows exactly what the code uses, nothing guessed.
- **You stay in control.** See every change before you apply it. Renamed tokens keep their variables, so designs
  never break.
- **Free and private by default.** No AI and no account needed: it runs in your GitHub Actions, and your code stays
  with you. Bring your own coding agent only if you want to.

> [!NOTE]
> Designlane works with **Figma** today, with **Penpot** and **Sketch** next. Tokens are written in the W3C design
> tokens format, which most design-token tools can read.

Designlane was called Designmap until 0.3.0: what it set up then keeps working (see the [changelog](CHANGELOG.md)).

## Get started (30 seconds)

Needs Node 22 or later. In your app's repo:

```sh
npx designlane .
```

That's it. You get four files:

```
designlane/
├── tokens.json   the design system the code names, as W3C design tokens: what your design tool syncs
├── DESIGN.md     the full report: every colour, text style, spacing and corner radius, with where each is used
├── catalog.html  one page with the colours, text styles and every component, to open or send to a designer
└── drift.md      where the UI code writes values the design system already has
```

Then keep your design file in step:

1. **Add the GitHub Action.** On every push it updates `designlane/tokens.json` and commits it when it changed
   ([workflow](figma-plugin/README.md#keeping-tokensjson-up-to-date)).
2. **Install the Figma plugin** and connect your repo, with a token that can only read it
   ([plugin](figma-plugin/README.md)).
3. **Apply.** After each push the plugin shows what changed in the code. Read the plan and press Apply.
4. **Changed something in Figma?** The plugin lists it, and opens a pull request with the exact code edit
   ([how](figma-plugin/README.md#changes-made-in-figma)).

**One tool, three platforms.** SwiftUI, Jetpack Compose and React Native, on macOS, Linux and Windows.

## See it in action

Real output, run on a small SwiftUI shop app:

![designlane run on a SwiftUI app: it finds 5 colours and 2 text styles and writes tokens.json and DESIGN.md](.github/assets/cli.gif)

Each colour in `tokens.json` records how the code refers to it and where it's declared, so the plugin can show it
and find it again after any rename, and exactly where each of its values is written: the file, line and characters
of its light and dark values (offsets in UTF-16 code units, each span exactly the text to replace, never a string's
quotes), what the span holds (`kind`: a `literal`, an `expression`, a `family-name` holding the weight too, a family's
`identifier`, or an asset's `components`), and each name on the way when the code reaches the value through another
(`via`). Each text style records the same for its family, size and weight:

```json
"Brand": {
  "$type": "color",
  "$value": { "colorSpace": "srgb", "components": [1, 0.102, 0.18], "hex": "#ff1a2e" },
  "$extensions": {
    "designlane": {
      "reference": "Color(\"Brand\")",
      "source": "Shop/Assets.xcassets/Brand.colorset/Contents.json",
      "modes": { "dark": { "colorSpace": "srgb", "components": [1, 0.333, 0.4], "hex": "#ff5566" } },
      "locations": {
        "light": { "file": "Shop/Assets.xcassets/Brand.colorset/Contents.json", "line": 6, "start": 92, "end": 160, "kind": "components" },
        "dark": { "file": "Shop/Assets.xcassets/Brand.colorset/Contents.json", "line": 14, "start": 352, "end": 420, "kind": "components" }
      }
    }
  }
}
```

In Figma, the plugin lists what's new, what changed and what the code no longer uses. Nothing changes in your file
until you press Apply; then your variables and text styles update in place, and a page in the file shows the design
system as swatches and type samples.

## What it does

| Capability | What you get |
|---|---|
| Colours | Every colour the code names, from asset catalogs, theme objects, colour resources and Tailwind, as Figma variables |
| Light and dark | A colour's light and dark values as one variable with two modes |
| Text styles | The app's type scale and named styles: family, size and weight, as Figma text styles |
| Spacing and corner radii | The scales the code names (`AppSpacing.large`, `spacing.md`), as Figma number variables for gaps and corners |
| A plan you apply | What's new, what changed and what the code no longer uses, each with how the code refers to it |
| Safe renames | A token renamed in the code, or a whole theme renamed, keeps its variable and every design using it |
| Several themes | An app whose users pick a theme gets a Figma collection for each, with Light and Dark modes |
| Your coding agent, for unusual setups | Your agent reads the app; Designlane checks every value against the code before syncing it |
| Two apps, one repo | An iPhone and an Android app in one repo each get their own design system |
| The full picture | `DESIGN.md` lists every value the code uses and the app's screens (for SwiftUI and Compose, how they open each other too) |
| Design context for agents | An agent can ask for the design system while it codes: `claude mcp add designlane -- npx designlane mcp .` |
| A component catalog | `catalog.html`: the colours light and dark, text styles, spacing, corner radii and every component, with its file, uses, parameters and the tokens it uses |
| Drift | `drift.md`: colours written as values (with the named colour to use), spacing and corners off the scale the code uses, text styles written in place, near-duplicate components |

## Component catalog

`designlane/catalog.html` is one page that opens offline in any browser, in light or dark: the app's colours (light
and dark, and each theme), text styles, the spacing and corner radii the code uses, and every component and screen.
Each component shows its kind (a button, a row, a card…), where it's declared, how often other code uses it, its
parameters as the code writes them (`title: String`), and the colours and text styles it uses. When two components
share a name, each use counts for the one declared nearest (the same file, else the same folder), and a use as near
both is shown as possibly either. Search and filter by kind at the top.

Your coding agent can add a picture of each component. With the MCP server connected, ask it to *"draw my components
for the Designlane catalog"*: it finds them with `find_components`, reads each with `get_component`, draws it in HTML
with the app's own colours, and saves it with `save_preview`, which updates the catalog. Pictures are plain HTML and
styles only, no scripts or links, and show in a sandbox; when a component's code changes, its card says the picture is
out of date. Use `--no-write` to see what Designlane finds without writing any file.

`designlane/drift.md` lists where the UI code skips the design system, each with its file and line, and the agent can
check its own changes with `check_drift`. Designlane names a colour or text style to use when one matches; for spacing
and corners it says which value the code uses often nearby, not yet which named step to use. Theme and
token files (`Theme.kt`, `AppColors.swift`, `theme/`) and previews are left out, as values belong there.

## Unusual setup? Let your coding agent read it

Designlane's own reading covers the common ways apps define colours and text styles. If your app builds its theme
some other way, have your coding agent do the reading, and Designlane checks it before anything reaches Figma:

```sh
claude -p "$(npx designlane prompt)" --allowedTools Read Glob Grep Write   # writes designlane/agent.json
npx designlane --from-agent designlane/agent.json                           # checks it, writes tokens.json
```

A colour is kept only when the code writes its exact value and uses its name; whatever isn't is listed and left out.
Any agent works: `designlane prompt` prints plain instructions.

## Change a token in the code

`designlane edit` makes a design change in the code, in the one place tokens.json says the value is written, and
writes it the way the code already does:

```sh
npx designlane edit Theme.brand light '#de2413' --dry-run
```

```diff
--- a/Shop/Theme.swift
+++ b/Shop/Theme.swift
@@ -2,1 +2,1 @@
-  static let brand = Color(red: 0.2, green: 0.4, blue: 0.9)
+  static let brand = Color(red: 0.87, green: 0.14, blue: 0.075)
```

Name the token by its key in tokens.json or how the code refers to it, and the property as `light`, `dark`,
`family`, `size` or `weight`. Without `--dry-run` it writes the file. The new value keeps the code's notation: hex
case and length, Compose's `0xFF…`, Swift's `/ 255` or its decimals, `rgb()`, an asset catalog's components (with more decimals only when the code's can't hold the new value), `22.sp`,
`.semibold` or `FontWeight.SemiBold`. A colour the code gives as another name (`link: colors.blue0`) gets its own value
in place of that name, so everything else using `colors.blue0` keeps it, when the value is written in the same file and
can stand on its own there.

When it can't be sure, it changes nothing and says why: the code changed since designlane last ran (run it again), the
colour is a named or computed one (`.white`, `Brand.copy(alpha = 0.5f)`), the weight is part of a font's name
(`Inter-Bold`), the change would also change another token (one written in the same place, or one whose name leads
there), a value can't be copied in place of a name safely (it's in another file, or Swift's `.init(…)`), or a text
style's value comes from a style it builds on. `--tokens` is read relative to `--dir`.

## Use it as a library

`designlane/read` answers questions about an app's code from your own tool, offline and with the same answer every
time: no AI, no network, and none of the command line or the Figma sync is loaded.

```ts
import { readApp } from "designlane/read";

const app = await readApp("path/to/app");
app.tokensIn("Shop/Views/Card.swift");
// { colors: [{ token: { key: "brand", reference: "Color.brand" }, value: "#3366e6", span: { file, line, start, end } }, …],
//   typeStyles, fonts, spacing, radii }
const variant = await app.withChanges({ "Shop/Theme.swift": newText }); // the app is left as it was
variant.tokensIn("Shop/Views/Card.swift");
```

- `tokensIn(path, text?)` lists every colour, text style, font, spacing and corner radius one file uses, in the order
  they're written: the named token each one is, if it is one, its value, and exactly where it's written. Colours are
  lowercase `#rrggbb`, or `#rrggbbaa` when not fully opaque. Pass `text` to read a version of the file that isn't on
  disk. A color read through the theme the user picks (`theme.tintColor`) is `themed`, with its default theme's
  value; one from a theme declared in a library is `unresolved`, with no value.
- `stringsIn(path, text?)` lists the text one file shows people, with exactly where it's written: words written
  in the code (`literal`), and translated strings it names by key (`localized`), with their English text (or Xcode's
  base localization's) from its strings files (Xcode string catalogs and `.strings`, Android `strings.xml`, JSON
  locale files), or `null` when none has it.
- `layoutOf(screen)` gives a screen's or component's layout as a tree: its stacks, grids, lists, scroll views, tabs,
  navigation, forms, sections and toolbars, each `if` or `switch` as a `conditional` with a child per branch, each loop
  as a `repeat` of one item, a SwiftUI `#if` as a `conditional` too (a decision made when the app is built), the app's
  views it places as a `view-ref` naming the view (whose own layout is `layoutOf` that; of a Compose function's
  overloads, the one whose parameters take the call's arguments), and the text, buttons, images, inputs and spacers it
  shows. Wrappers that only style their content (padding, a background `Box`, a `View` with one child) give way to it.
  Each node has its span and an id from its path by kind (`stack-v/list/text.1`), which stays the same when nodes of
  other kinds are added around it, so two versions of a screen can be compared node by node. It's `undefined` for code
  that can't be read whole (a bracket or tag left open), never a tree of part of the screen.
- `screenParts(screen)` lists a screen's main parts, for picking one to change: stepping in through what holds the
  whole screen (a navigation, a scroll, a stack, what it writes inside a container of the app's, the one view it
  places, the biggest branch of an `if` over all of it), the nodes of the first one holding two or more, each with
  its id in the layout of `view` and a label to show ("Header", "Plans"). The label is a section's or toolbar's
  title, the placed view's name, the view property it's the first thing of, a short comment above it, what an `if`'s
  biggest branch or a loop's item is named, the first text it shows, or its kind, in that order. What only runs code
  or opens dialogs isn't a part. It's `[]` when nothing holds two or more parts, and `undefined` when a layout on the
  way is.
- `filesFor(screen)` lists the files that explain a screen or component, each with why: where it's declared, the
  views it places at any depth, the types holding its state (`CartViewModel`), the project's files a React Native
  screen imports, and where the tokens it uses are declared. For giving an agent or a variant generator what it needs
  to change a screen, and no more. It takes a layout's `ref` or a part's `view` too, in a view that adds that view.
- `withChanges(files)` gives a view of the app with some files changed (or `null` for deleted), reading only those
  files again; a view that changes a theme names its tokens by the new theme. Views can be made from views.
- `update(path, text)` changes the app itself, for a working tree being edited.
- `findFrameworks(root)` says which frameworks an app is built with from its file names and manifests, before it's
  read.

Reading a file takes a few milliseconds (about 20 ms for a 2,000-line one) and a view of a few changed files about
as long; `readApp` takes as long as a scan. The first `filesFor` parses the app's code once (about 100 ms for 400
screens), and each one after takes as long as reading the screen's files. Every result has a zod schema exported beside it.

## Supported

| | Today | Next |
|---|---|---|
| **Code** | SwiftUI, Jetpack Compose, React Native | more to come |
| **Design tools** | Figma | Penpot, Sketch |
| **Direction** | code to design; design to code, from Figma as a pull request ([plugin](figma-plugin/README.md#changes-made-in-figma)) or with `designlane edit` | |
| **Token formats** | W3C design tokens | |

## What it reads

The design system is what the code names: a colour declared with a name (`Theme.surface`, an asset, a colour
resource), a text style the code defines (a typography style, the app's own font helper), and a spacing or corner
radius scale (`enum AppSpacing { static let large: CGFloat = 16 }`, `object Radii { val card = 12.dp }`,
`export const spacing = { md: 12 }`). Values written in place in a screen's layout (`.padding(16)`) are listed in
`DESIGN.md`, so editing a screen doesn't change your design system.

A scale counts when it has two or more steps and code outside its own file uses one by name: a screen's own constants
(an enum nested in a view, `private` members, `rowHeight`) aren't the app's scale.

- **SwiftUI:** asset catalog colours, colours declared in code, the app's own font helpers and text styles.
- **Jetpack Compose:** the Material colour scheme (each role with its Light and Dark value), the type scale and named
  text styles, an app's own colour class and colour resources.
- **React Native:** theme objects (a light and a dark theme paired into one colour, a theme chosen per platform read as
  iOS's), Tailwind's colours and text classes (a `tailwind.config.js`, or a CSS `@theme`, as NativeWind and Uniwind
  use), and typography objects (a font file's name like `Inter-SemiBold` read as its family and weight).

`DESIGN.md` also lists the app's screens and, for SwiftUI and Compose, how they open each other: pushed, a sheet, a
dialog, full screen, a popover, a tab, a pane beside, or starting over.

### Apps with several themes

Some apps let people pick a theme, each with a light and a dark version: SwiftUI types conforming to one protocol of
colours (`OceanLight` and `OceanDark`, `DesertLight` and `DesertDark`), or React Native theme objects beyond one light
and dark pair (`themes.black`, a list of presets). The first theme the code declares, or the one named `light` and
`dark`, is the app's own colours, so reordering the themes in the code changes which one that is. Every other theme
gets its own colours in tokens.json, under `theme`, and its own Figma collection with Light and Dark modes, such as
**Shop · Desert (Designlane)**, with the same variable names, so designers can see every theme and design with any of
them. DESIGN.md lists each theme's colours.

### Two apps in one repo

A repo with both an iPhone and an Android app gets a design system for each, since the two often differ (a different
blue, the platform's own fonts): `designlane/tokens.ios.json` and `designlane/tokens.android.json`, with one `DESIGN.md`
covering both. Connect each design file to its app's path.

### A design system in its own repo

Some teams keep their theme in a separate library that the app imports. Designlane then tells you the theme is defined
outside the app. Add Designlane to the library's repo instead, and connect your design tool there.

## Prerequisites

| Requirement | Minimum | Check |
|---|---|---|
| Node.js | 22 | `node --version` |
| A GitHub token for the plugin | read-only access to the app's repo contents; to open pull requests from Figma, a second one with Contents and Pull requests set to Read and write | GitHub → Settings → Developer settings → Fine-grained tokens |

## Documentation

- [Figma plugin](figma-plugin/README.md): install, connect a repo, and what a sync does
- [Keeping tokens.json up to date](figma-plugin/README.md#keeping-tokensjson-up-to-date): the GitHub Action
- [Changelog](CHANGELOG.md)

## Status

Version 0.2. Designlane reads SwiftUI, Jetpack Compose and React Native apps, syncs to Figma, and turns changes made
in Figma into pull requests. Feedback and issues are welcome.

## License

[Apache 2.0](LICENSE)
