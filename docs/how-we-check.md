# How we check Designlane

Designlane has two jobs:

1. **List the design system**: the app's tokens, in `tokens.json`.
2. **Flag where the code doesn't use it**: one-off design values, in `drift.md`, each with the token it could use.

This page says what counts as a token, what the right answer is for every value in the code, and how what we find
turns into fixes.

## What a token is

A **token** is a design value the code names and offers to the whole app: a color, text style, spacing step or corner
radius, declared in a shared place such as a theme, a palette, a token file, resources or a design-system module.

It passes three tests:

1. **It has a name**: `colors.primary`, not `#3366CC` written in a screen.
2. **It's one of the four kinds**: color, text style, spacing or corner radius.
3. **It belongs to the app, not to one screen or component**: that's decided by where it's declared. How the app uses
   it is evidence only where the place is unclear.

All three tiers count:

- **Primitive**: the raw palette or scale, such as `Blue40` or `space4`.
- **Semantic**: a role built on one, such as `primary = Blue40`.
- **Component**: a value the design system declares for one of its components, such as `Button.cornerRadius` in a
  design-system module.

A token counts even when nothing uses it yet: Designlane lists it and says it's unused.

## The three outcomes

Every design value in the code is one of three things, and each has a right answer:

| What it is | Example | What Designlane should do |
|---|---|---|
| **A token** | `colors.primary` in the theme | List it in `tokens.json` |
| **A one-off design value** | `.padding(6)` in a screen, or `private let avatarPadding = 6` | Flag it in `drift.md` |
| **Not a design value** | An animation's duration, a list's page size | Nothing |

A one-off isn't a token, but it may relate to one, and the flag says how:

| The one-off | What it probably is | What the flag suggests |
|---|---|---|
| The same value as a token | The token was skipped | Use that token |
| Close to a token (`#3367CC`, or `15` on a scale of 8, 16, 24) | A slip | The nearest token, for a person to decide |
| Like no token | A deliberate exception, or a token the design system lacks | Keep it, or make it a token; when the same value is on many screens, suggest it as one |

Designlane shows the evidence; a person decides which.

## Who says what

Three readings of an app can disagree:

- **Designlane alone**: what its own readers find in the code.
- **The coding agent's map**: what an agent lists as the design system (see the README). Its instructions,
  `designlane prompt`, use the definition above.
- **Designlane's check of the map**: each entry the agent lists is confirmed if the code bears it out, or refused with
  the reason.

None of them is the answer. What a value really is gets decided against the definition above, by reading where it's
declared and how the app uses it.

## Every case

Anything Designlane or the agent puts forward ends up in one of these cases:

| The agent lists it as a token | Designlane alone | What it really is | What it means | What we do |
|---|---|---|---|---|
| Yes | Lists it | A token | Both right | Nothing |
| Yes | Lists it | A one-off | Both wrong: they agree on something that isn't a token | Fix the rule both follow, and the prompt |
| Yes | Doesn't, but the check confirms it | A token | Designlane misses a real token | Fix Designlane's reader |
| Yes | Doesn't, but the check confirms it | A one-off | The agent is wrong; Designlane is right to leave it out, but the check only confirmed the value is there | Make the check refuse it, and tighten the prompt |
| Yes | Doesn't, and the check refuses it | A token | Designlane can't read how it's written | Fix Designlane's reader |
| Yes | Doesn't, and the check refuses it | A one-off | The agent is wrong, and the check rightly refuses it | Nothing; the prompt may need tightening |
| No | Lists it | A token | Designlane is right, and the agent missed it | Tighten the prompt |
| No | Lists it | A one-off | Designlane lists something that isn't a token | Fix Designlane's rule |
| No | Doesn't | A token | Nobody found it | Only a person reading the app, or someone reporting it, shows this |

And for the second job, every one-off design value:

| Designlane | What it means | What we do |
|---|---|---|
| Flags it in `drift.md` | Right | Nothing |
| Lists it as a token | Wrong: it's in the design system when it isn't one | Fix Designlane's rule |
| Neither | Missed: nobody is told about it | Fix Designlane's drift check |

Two cases are easy to overlook:

- **Both wrong.** When Designlane and the agent agree, nothing flags it, so agreements are checked too.
- **Nobody found it.** A token neither finds never becomes a candidate, so no check counts it. What we miss is always
  at least what we know about.

## How a case is decided

1. **Gather the candidates** from all three readings, including the entries the check refuses, and the one-offs
   `drift.md` flags.
2. **Decide each against the definition**, from where it's declared and how the app uses it. A second reading by an
   agent does this at scale; it decides each candidate twice, and where the two disagree, a person decides.
3. **Check the deciding against a person** on a sample before relying on it.
4. **Keep the decisions**, so the same candidate isn't decided again and only a change to Designlane changes the
   result.

## How it turns into fixes

Each case's "What we do" points at one place:

- **Designlane's readers, rules and drift check**: a pattern it gets wrong becomes a case in
  `tests/fixtures/patterns/needs-fix/` and an issue, for a contributor to fix (see CONTRIBUTING.md).
- **The check of an agent's map**: an entry it confirms or refuses wrongly becomes a test in
  `tests/unit/agent-map.test.ts`.
- **The prompt**: what agents often get wrong becomes a line in `designlane prompt`.

Patterns are what get fixed, not single apps: a fix is a rule that covers every app that writes its design system that
way.
