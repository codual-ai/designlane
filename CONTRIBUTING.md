# Contributing to Designlane

Thanks for helping. Most contributions teach Designlane to read something it reads wrong today: an element it shows
as `other`, a theme it can't follow, a token it misses. Those are the most useful, and the easiest to start with.

## Set up

You need Node 22 or later and pnpm 10. `corepack enable` gives you the version the repo pins; on a Node without
Corepack, `npm install -g corepack` first, or `npm install -g pnpm@10`.

```sh
git clone https://github.com/codual-ai/designlane.git
cd designlane
pnpm install
pnpm check   # types, lint, every test, and the build: what CI runs
```

To try your change on an app, `pnpm designlane` builds it and runs it, with any of Designlane's commands:
`pnpm designlane <app folder> --no-write` to see what it reads, or `pnpm designlane doctor <app folder>` to see
what it couldn't.

## Your first fix, in about ten minutes

Designlane knows the common elements of each framework, and shows one it doesn't know as `other`. Teaching it one
is a good first fix, and there's one waiting: Compose's `FilledIconToggleButton`.

1. **See the case.** `tests/fixtures/patterns/needs-fix/compose/filled-icon-toggle-button/` holds a few lines of
   code using it, and `expected.txt`: what `designlane doctor` should print for it, a `button`. Today Designlane
   prints `other`, so the case is in `needs-fix/`.
2. **Fix it.** In `src/read/layout-tree.ts`, add `FilledIconToggleButton` to Compose's `button` names, beside
   `IconToggleButton`.
3. **Run `pnpm vitest run tests/unit/patterns.test.ts`.** It now says the bug is fixed and asks you to move the
   folder: move it to `tests/fixtures/patterns/compose/`, where it's checked from then on.
4. **Run `pnpm check`**, and open a pull request.

## Add a case

A case is the quickest way to show Designlane something it reads wrong, and you don't need to write a test:

1. Make a folder, `tests/fixtures/patterns/needs-fix/<framework>/<what-it-shows>/`, where `<framework>` is
   `swiftui`, `compose` or `react-native`.
2. Put a few lines of code in it, as a file of its own (`Card.swift`, `Card.kt`, `Card.tsx`), declaring one screen or
   component. Nothing private.
3. Run `pnpm pattern <the folder>`. It writes `expected.txt`: what `designlane doctor` prints for it today.
4. Change what's wrong in `expected.txt` to what it should be, and open a pull request.

The case waits in `needs-fix/`, and CI passes while it reads differently. Whoever fixes Designlane moves it out. A case
that already reads right goes straight into `tests/fixtures/patterns/<framework>/`, so it stays right. After a change
that improves what Designlane reads, `pnpm pattern --all` rewrites the passing cases' `expected.txt`, and the diff
shows what changed.

## Where things are

| Folder | What it does |
| --- | --- |
| `src/scan` | Finds the app's frameworks, screens and tokens, and checks a coding agent's map (`agent-map.ts`). |
| `src/frameworks` | One reader per framework: SwiftUI (`swift*`), Jetpack Compose (`compose*`, `kotlin*`), React Native (`rn*`, `js*`). Tokens, scales and screens are read here. |
| `src/read` | The read API (`readApp`): a screen's layout, parts, strings and tokens, and `layoutIssues`. |
| `src/catalog` | Each component's declaration, parameters and uses, for `catalog.html` and the agent map's components. |
| `src/edit` | `designlane edit`: changing a token's value in the one place the code writes it. |
| `src/output` | The files Designlane writes: `tokens.json`, `DESIGN.md`, `catalog.html`, `drift.md`. |
| `src/sync` | Matching tokens to what a Figma file already has. |
| `src/cli` | The commands: `designlane`, `doctor`, `edit`, `prompt`. |
| `figma-plugin` | The Figma plugin. |
| `tests/unit` | Tests, by area. `tests/helpers/temp.ts` makes a throwaway app from a few files. |

Designlane reads code by its structure, without compiling it, and never calls AI when it answers: the same code
always gives the same result.

## Making a fix

1. **Find the smallest code that reads wrong.** `pnpm designlane doctor <app folder> --screen <name>` points at the
   line. Cut it down to a few lines that still show the problem, with nothing private in them.
2. **Show what's wrong.** Add a case for it in `needs-fix/` (above), which your fix then moves out; or write a test
   next to the tests of the same area, building the app with `tempDir` from `tests/helpers/temp.ts`, and check it
   fails before your fix.
3. **Fix it as a rule.** A rule covers the pattern, not just your example: a guess that's usually right is worse than
   reading nothing, so when Designlane can't tell, it should say so rather than pick.
4. **Run `pnpm check`.** It must pass on every platform CI runs: macOS, Linux and Windows.

Common fixes:

- **An unknown element** (shown as `other`): add it to its framework's table in `src/read/layout-tree.ts`, with the
  kind it is, and a test of a screen using it.
- **A token it misses or reads wrong**: the framework's reader in `src/frameworks`, with a test in that framework's
  test file.
- **A coding agent's map entry it refuses wrongly**: `src/scan/map-values.ts` and `src/scan/agent-map.ts`, with a test
  in `tests/unit/agent-map.test.ts`. A wrong confirmation is worse than a wrong refusal, so test both.

## Pull requests

- One change per pull request, with its tests.
- Keep the title short and in the imperative: `fix: read a Compose theme's default`, `feat: …`, `docs: …`.
- Say what it changes and how you checked it. The template asks.
- Don't commit generated files (`dist/`) or anything from an app that isn't yours.

## What to expect

We reply to issues and pull requests within a few days. If a change needs work, the review says what and why. If
you're unsure where to start, look for issues labelled `good first issue`, or open an issue and ask.

## Reporting a problem

Open an issue with the template for it. The most useful report is a few lines of code that read wrong, with what
Designlane said and what you expected. For a security problem, follow [SECURITY.md](SECURITY.md) instead.

By contributing, you agree your contribution is licensed under the [Apache License 2.0](LICENSE), and that you'll
follow the [code of conduct](CODE_OF_CONDUCT.md).
