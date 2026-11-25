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

## When they disagree

Designlane and the agent don't always coincide, for multiple reasons. If the agent finds a real token that Designlane
missed, Designlane has a gap to close. If the agent lists a one-off as a token, the agent got it wrong, even when the
value really is in the code.

Sometimes Designlane can't confirm an agent's entry at all. Either the agent got it wrong, or the token is written in a
way Designlane can't read yet.

Even when they coincide, they can both be wrong, so we check those too. A token neither of them finds can't be caught
this way: those gaps come to light through issues, from people who read the code or use Designlane on their own app.

The second job works the same way: each one-off design value should be flagged in `drift.md`. Listing it as a token,
or not flagging it, is wrong.

Every wrong answer points at one thing to fix: a Designlane reader, one of its rules, its drift check, its check of an
agent's map, or the agent's instructions.

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
