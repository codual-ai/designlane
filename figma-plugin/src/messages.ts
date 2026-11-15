/** What the plugin's window and its Figma side say to each other, checked on arrival since either end only sees an
 * untyped message. */

import { z } from "zod";
import { EDIT_PROPERTIES } from "../../src/edit/edit-tokens.js";

const names = z.array(z.string());

const id = z.number().int().nonnegative();

/** A value a designer changed in Figma that the code doesn't have: `from` the code's, `to` Figma's. */
const FigmaChange = z.object({
  /** The variable or style, and which of its values: what the designer ticks. */
  id: z.string(),
  /** Its name in Figma, after its theme's (`Desert: color/tint`). */
  name: z.string(),
  /** Its key in tokens.json, which a code edit names it by. */
  token: z.string(),
  property: z.enum(EDIT_PROPERTIES),
  from: z.string(),
  to: z.string(),
  /** The code changed it too since the two last agreed, so it can't be opened as an edit. */
  inCodeToo: z.boolean(),
});
export type FigmaChange = z.infer<typeof FigmaChange>;

/** The code edit for a Figma change, or why there's none; `change` is the change's id. */
const PlannedEdit = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    change: z.string(),
    file: z.string(),
    line: z.number(),
    before: z.string(),
    after: z.string(),
  }),
  z.object({ ok: z.literal(false), change: z.string(), reason: z.string() }),
]);
export type PlannedEdit = z.infer<typeof PlannedEdit>;

const PlanSummary = z.object({
  create: names,
  update: names,
  restore: names,
  rename: z.array(z.object({ from: z.string(), to: z.string() })),
  deprecate: names,
  /** Styles whose font this file doesn't have, so the sync leaves them out. */
  missingFonts: names,
  unchanged: z.number(),
  /** The scan didn't read the whole app, so nothing is deprecated. */
  partial: z.boolean(),
  /** Too many tokens changed at once to guess renames. */
  renamesSkipped: z.boolean(),
  /** The collection couldn't take a Dark mode, so dark values are left out; Apply tries again. */
  darkLeftOut: z.boolean(),
  /** Whether Apply has anything to do. */
  applicable: z.boolean(),
  /** What a designer changed in Figma that the code doesn't have, which Apply would set back. */
  figmaChanges: z.array(FigmaChange),
});
export type PlanSummary = z.infer<typeof PlanSummary>;

/** Where in a GitHub repo the plugin reads tokens.json from; the token that reads it never reaches the window. */
export const RepoSource = z.object({ repo: z.string(), branch: z.string(), path: z.string() });
export type RepoSource = z.infer<typeof RepoSource>;

/** `id` ties a plan to the request that made it, so an Apply only ever applies the plan the designer is looking at. */
const ToPlugin = z.discriminatedUnion("type", [
  /** The window has opened: say which repo is connected, and plan from it if one is. */
  z.object({ type: z.literal("ready"), id }),
  z.object({ type: z.literal("connect"), id, ...RepoSource.shape, token: z.string() }),
  /** Plan from the connected repo's tokens.json as it is now. */
  z.object({ type: z.literal("fetch"), id }),
  z.object({ type: z.literal("disconnect") }),
  z.object({ type: z.literal("plan"), id, json: z.string() }),
  z.object({ type: z.literal("apply"), id }),
  /** Plan the code edits for the Figma changes ticked, by their ids, in the plan `id` showed. */
  z.object({ type: z.literal("planEdits"), id, changes: names }),
  /** Open a pull request with the planned edits of the changes ticked; `token` when the designer just gave one that
   * can. */
  z.object({ type: z.literal("openPullRequest"), id, changes: names, token: z.string().optional() }),
  z.object({ type: z.literal("close") }),
]);
export type ToPlugin = z.infer<typeof ToPlugin>;

const ToWindow = z.discriminatedUnion("type", [
  /** `saved`: the repo this file syncs from when this computer has no token for it, to fill in the form. */
  z.object({ type: z.literal("connection"), repo: RepoSource.nullable(), saved: RepoSource.optional() }),
  z.object({ type: z.literal("plan"), id, summary: PlanSummary }),
  z.object({ type: z.literal("applied"), notes: names }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({ type: z.literal("edits"), id, edits: z.array(PlannedEdit) }),
  /** Opening a pull request needs a token that can write to `repo`; `reason` when GitHub refused the one given. */
  z.object({ type: z.literal("writeTokenNeeded"), id, repo: z.string(), reason: z.string().optional() }),
  z.object({ type: z.literal("pullRequest"), id, url: z.string() }),
  /** Planning the edits or opening the pull request failed; the plan stays on screen. */
  z.object({ type: z.literal("designToCodeError"), id, message: z.string() }),
]);
export type ToWindow = z.infer<typeof ToWindow>;

/** A message the window sent, or undefined for anything else. */
export const toPlugin = (data: unknown): ToPlugin | undefined => ToPlugin.safeParse(data).data;

/** A message the Figma side sent, or undefined for anything else. */
export const toWindow = (data: unknown): ToWindow | undefined => ToWindow.safeParse(data).data;
