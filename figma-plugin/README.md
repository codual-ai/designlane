# Designmap for Figma

Keeps a Figma file's variables and text styles in sync with an app's code.

1. Keep the app's `designmap/tokens.json` up to date with CI (below), or run `designmap ./YourApp` yourself.
2. Run `pnpm build:plugin`.
3. In Figma: **Plugins → Development → Import plugin from manifest…** and pick `figma-plugin/manifest.json`.
4. Run **Designmap** and connect the app's GitHub repo, with a fine-grained token that can only read this repo's
   contents, and its pull requests if you open some from Figma (below). The token stays on your computer.
5. From then on, opening Designmap shows what changed in the code. Read the plan and press **Apply**.

You can also pick a `tokens.json` file instead of connecting a repo.

A repo with both an iPhone and an Android app gets a tokens file for each, `designmap/tokens.ios.json` and
`designmap/tokens.android.json`: connect each Figma file to its app's path.

## Keeping tokens.json up to date

Add this workflow to the app's repo as `.github/workflows/design-tokens.yml`. On every push to `main` it writes
`designmap/tokens.json` from the code, and commits it when it changed. A `main` protected from direct pushes refuses
that commit; allow GitHub Actions to push, or run the workflow on another branch.

```yaml
name: Design tokens
on:
  push:
    branches: [main]
permissions:
  contents: write
jobs:
  tokens:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: codual-ai/designmap@v0.1.0
        with:
          app: . # the app's folder, if it isn't the repo's root
```

## What a sync does

The plugin creates a variable collection named after the app, such as **Shop (Designmap)**, and text styles. Each
one records the token's identity, so the next sync finds it under any name, and shows how the code refers to it
(`Theme.surface`) as a variable's iOS code syntax and in its description.

An app with several themes gets a collection for each theme beside its default one, such as **Shop · Desert
(Designmap)**, with Light and Dark modes and the same variable names as the app's own collection, so you can see
every theme and design with any of them. Each theme is synced on its own, its changes named with it in the plan
(`Desert: color/tint`), and a theme the code drops has its variables deprecated. The design system page shows the
default theme.

It also draws the design system on a page of the same name: a swatch for each colour, linked to its variable, in
Light and, when it differs, Dark; and a sample of each text style, largest first. The
page is redrawn on every Apply. Only Designmap's own frame changes, where you last moved it, so anything you add to
the page outside that frame stays; anything added inside it is replaced.

On each sync:

- **New** tokens are created, named from the code.
- **Changed** values are updated in place. Renames a designer made are kept.
- Tokens **renamed in the code** keep their variable or text style when nothing else changed, and so does every
  token of a theme the code renamed.
- Tokens **no longer in the code** are marked deprecated, never deleted, since designs may still use them: variables
  are hidden from publishing, and text styles say so in their description (Figma can't hide a style). They come back
  if the code does.
- When the collection has no room for a Dark mode on your Figma plan, dark values are left out with a note, and each
  Apply tries to add the Dark mode again.
- Text styles whose font this file doesn't have are left out, and named in the plan.
- Variables and styles a designer made are left alone, and so are descriptions and publishing choices a designer set.

## Changes made in Figma

When a designer changes a synced colour (Light or Dark, in any theme's collection) or a text style's size, weight or
font in Figma, the plan lists it apart from the code's changes: **Changed in Figma, not in code: color/brand #ff1a2e →
#de2413**. Designmap tells these from code changes Figma hasn't taken yet by the value the file and the code last had
alike, which it keeps on each variable and style. A file synced before this starts keeping it on its next check.
Renaming a variable or style isn't a change; only values are. Apply keeps these values as you changed them, and still
applies everything else, until the code has them; to get them into the code, open a pull request:

1. Tick the changes to keep and press **Plan code edits**. Designmap reads tokens.json and the code from the connected
   branch's latest commit, and shows each edit as file, line and the text before and after, written the way the code
   already writes it. An edit it can't make safely says why in plain words and can't be ticked: where tokens.json
   doesn't say where the value is written, a value shared with another token, a file over 512 KB or not UTF-8 text,
   and the other reasons `designmap edit` gives.
2. Press **Open pull request**. Designmap makes one commit with the ticked edits on a new branch
   (`designmap/figma-2026-11-14-1a2b3c4`) from that commit, and opens a pull request titled "Design changes from Figma:
   2 values" that lists each change and where it's written. The window links to it.

Once the pull request is merged and tokens.json written again, the code has the values and they leave the list.
Until then, each check finds Designmap's open pull requests into the connected branch (read with the read-only token,
from a marker in each one's description naming the values and this tokens file), and a change already in one shows **Pull request open** with its link
instead of a box to tick. If the token can't read pull requests, the changes show as before, with a note saying so.

When the code changed the same value too since the two last agreed, the list shows both, **Code: #1565c0 · Yours:
#de2413**, and two choices. **Keep the code's** lets Apply set it to the code's value. **Use mine** lets it be ticked
and planned like any other change, the edit going from the code's value now to yours. Until you choose, Apply keeps
yours.

Opening a pull request needs more than the read-only token you connected with. The first time, Designmap asks for a
second fine-grained token, for this repo only, with **Contents** and **Pull requests** both set to **Read and write**,
and links to GitHub's form for one. It's kept on this computer for that repo, like the first, and both are only ever
sent to `api.github.com`. If GitHub refuses it, Designmap forgets it and asks again. Syncing keeps using the read-only
token. Connecting a repo is needed: a picked tokens.json can't open a pull request.
