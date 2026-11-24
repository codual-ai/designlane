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
is a good first fix. Say a Compose screen uses Material's `FilledIconToggleButton`, and `designlane doctor` lists it
as an unknown element.

1. **Write the test.** In `tests/unit/read-layout.test.ts`, add:

   ```ts
   it("reads FilledIconToggleButton as a button", async () => {
     const { lines } = await layout(
       {
         "app/src/main/java/a/Bar.kt": kotlin(
           "@Composable fun Bar() = Row { FilledIconToggleButton(checked = true, onCheckedChange = {}) { Icon(icon, null) } }",
         ),
       },
       "Bar",
     );
     expect(lines).toContain("    stack-h/button button");
   });
   ```

2. **See it fail.** `pnpm vitest run tests/unit/read-layout.test.ts -t FilledIconToggleButton` shows it read as
   `stack-h/other other`.
3. **Fix it.** In `src/read/layout-tree.ts`, add `FilledIconToggleButton` to Compose's `button` names, beside
   `IconToggleButton`.
4. **See it pass**, run `pnpm check`, and open a pull request.

The same steps fit most fixes: a test of the smallest code that reads wrong, then the change that makes it right.

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
2. **Write a test that fails.** Add it next to the tests of the same area, building the app with `tempDir` from
   `tests/helpers/temp.ts`. Check that it fails before your fix, and says why in its name.
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
