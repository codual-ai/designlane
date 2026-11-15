/** The plugin's conversation with its window: actions in turn, a plan made from the file as it is now, and an apply of
 * exactly the plan the designer saw. */

import { type DesignFile, type Plan, planSync, type SyncPlan } from "../../src/sync/plan.js";
import { readTokensFile, type SyncTokens } from "../../src/sync/tokens-file.js";
import { type ApplyOptions, applyPlan } from "./apply.js";
import { changeLabel } from "./code-edits.js";
import {
  type Connection,
  checkConnection,
  fileSource,
  forgetConnection,
  saveConnection,
  savedConnection,
} from "./connection.js";
import { darkUnavailable, readDesignFile, withoutDarkMode } from "./design-file.js";
import { createDesignToCode } from "./design-to-code.js";
import { figmaChanges, pairsOf, readAgreed, recordAgreements } from "./figma-changes.js";
import { darkLeftOutOf, withDarkWhereRoom, withoutMissingFonts } from "./fitted-plan.js";
import { fetchTokensFile, repoApi } from "./github.js";
import { keptChanges, mayKeepCode, withFigmaValues } from "./kept-in-figma.js";
import { type FigmaChange, type PlanSummary, type RepoSource, type ToWindow, toPlugin } from "./messages.js";
import {
  darkModeAdded,
  invalidJson,
  keptAsChanged,
  messageOf,
  missingFont,
  type Origin,
  pageNotRedrawn,
  stoppedPartway,
} from "./notes.js";
import {
  NO_PULL_REQUESTS,
  type OpenPullRequests,
  openPullRequests,
  withPullRequests,
} from "./open-pull-requests.js";
import { drawDesignSystemPage } from "./page.js";

interface Pending {
  id: number;
  /** The code's tokens as this file can hold them, and the file as the plan found it. */
  tokens: SyncTokens;
  file: DesignFile;
  /** The values a designer changed in Figma, which Apply keeps unless the designer chose the code's. */
  changes: FigmaChange[];
  options: ApplyOptions;
  origin: Origin;
  /** The code's tokens, which the file agrees with once the plan is applied. */
  inCode: SyncTokens;
}

/** The plan that syncs `tokens` to `file` and leaves the `kept` changes as Figma has them. */
const fittedPlan = (tokens: SyncTokens, file: DesignFile, kept: readonly FigmaChange[]) =>
  withoutMissingFonts(planSync(withFigmaValues(tokens, file, kept), file));

/** Answers each message from the window in turn, replying through `send`. */
export function createSession(send: (message: ToWindow) => void): (data: unknown) => Promise<void> {
  let pending: Pending | undefined;
  let queue = Promise.resolve();
  const designToCode = createDesignToCode(send);

  /** Runs `step` after any already running, so a file picked during an apply is planned against its result. */
  const inTurn = (step: () => Promise<void>): Promise<void> => {
    queue = queue.then(() =>
      step().catch((error: unknown) => send({ type: "error", message: messageOf(error) })),
    );
    return queue;
  };

  async function plan(
    id: number,
    json: string,
    origin: Origin,
    open: OpenPullRequests = NO_PULL_REQUESTS,
  ): Promise<void> {
    // A new file replaces any plan already shown, even if this one can't be read.
    pending = undefined;
    const inCode = readTokensFile(parseJson(json, origin));
    const leftOut = darkLeftOutOf(inCode, await darkUnavailable());
    const darkLeftOut = leftOut.main || leftOut.themes.size > 0;
    const tokens = withDarkWhereRoom(inCode, leftOut);
    const file = await readDesignFile();
    const pairs = pairsOf(inCode, file, await withoutDarkMode());
    const agreed = await readAgreed(pairs);
    const changedInFigma = withPullRequests(figmaChanges(pairs, agreed), open);
    await recordAgreements(pairs, agreed);
    const { plan, missingFonts } = await fittedPlan(tokens, file, changedInFigma);
    designToCode.found(id, origin, json, changedInFigma);
    pending = {
      id,
      tokens,
      file,
      changes: changedInFigma,
      options: {
        retryDark: leftOut,
        ...(tokens.app ? { app: tokens.app } : {}),
        ...(tokens.platform ? { platform: tokens.platform } : {}),
      },
      origin,
      inCode,
    };
    const summary = summarize(plan, !tokens.complete);
    const changes = [summary.create, summary.update, summary.restore, summary.rename, summary.deprecate];
    const applicable =
      changes.some((list) => list.length > 0) || darkLeftOut || changedInFigma.some(mayKeepCode);
    const missingFontNames = missingFonts.map(({ name, font }) => `${name} (${font})`);
    send({
      type: "plan",
      id,
      summary: {
        ...summary,
        missingFonts: missingFontNames,
        darkLeftOut,
        applicable,
        figmaChanges: changedInFigma,
        pullRequestsUnlisted: !open.listed,
      },
    });
  }

  async function apply(id: number, keepCode: string[]): Promise<void> {
    if (!pending) throw new Error("There's no plan to apply yet.");
    if (pending.id !== id) throw new Error("The plan changed. Look it over, then press Apply again.");
    const { tokens, file, changes, options, origin, inCode } = pending;
    pending = undefined;
    const kept = keptChanges(changes, keepCode);
    const { plan, missingFonts } = await fittedPlan(tokens, file, kept);
    try {
      const { notes, darkValuesPending } = await applyPlan(plan, options);
      const pairs = pairsOf(inCode, await readDesignFile(), await withoutDarkMode());
      await recordAgreements(pairs, await readAgreed(pairs));
      const pageNotes = await drawDesignSystemPage(options.app).then(
        () => [],
        (error: unknown) => [pageNotRedrawn(messageOf(error))],
      );
      const missingFontNotes = missingFonts.map(({ name, font }) => missingFont(name, font));
      const darkNotes = darkValuesPending ? [darkModeAdded(origin)] : [];
      const keptNotes = kept.length > 0 ? [keptAsChanged(kept.map(changeLabel))] : [];
      send({
        type: "applied",
        notes: [...missingFontNotes, ...notes, ...darkNotes, ...keptNotes, ...pageNotes],
      });
    } catch (error) {
      throw new Error(stoppedPartway(origin, messageOf(error)));
    }
  }

  /** Says which repo is connected, and plans from it if one is; or, when this computer has no token for the repo the
   * file syncs from (a teammate's computer), which repo that is, so only the token is asked for. */
  async function ready(id: number): Promise<void> {
    const connection = await savedConnection();
    if (connection) {
      send({ type: "connection", repo: repoOf(connection) });
      await planFromRepo(id, connection);
      return;
    }
    const saved = fileSource();
    send({ type: "connection", repo: null, ...(saved ? { saved } : {}) });
  }

  /** Saves a connection once it has read tokens.json, so a mistyped one is never kept. */
  async function connect(id: number, connection: Connection): Promise<void> {
    const checked = checkConnection(connection);
    const json = await fetchTokensFile(checked);
    await saveConnection(connection);
    send({ type: "connection", repo: repoOf(connection) });
    await plan(id, json, "repo", await pullRequestsOf(checked));
  }

  async function fetchPlan(id: number): Promise<void> {
    const connection = await savedConnection();
    if (!connection) throw new Error("Connect a repo first.");
    await planFromRepo(id, connection);
  }

  async function planFromRepo(id: number, connection: Connection): Promise<void> {
    const json = await fetchTokensFile(connection);
    await plan(id, json, "repo", await pullRequestsOf(connection));
  }

  async function disconnect(): Promise<void> {
    await forgetConnection();
    send({ type: "connection", repo: null });
  }

  return (data: unknown): Promise<void> => {
    const message = toPlugin(data);
    if (!message) return Promise.resolve();
    switch (message.type) {
      case "ready":
        return inTurn(() => ready(message.id));
      case "connect": {
        const { id, type: _, ...connection } = message;
        return inTurn(() => connect(id, connection));
      }
      case "fetch":
        return inTurn(() => fetchPlan(message.id));
      case "disconnect":
        return inTurn(disconnect);
      case "plan":
        return inTurn(() => plan(message.id, message.json, "file"));
      case "apply":
        return inTurn(() => apply(message.id, message.keepCode));
      case "planEdits":
        return inTurn(() => designToCode.planEdits(message.id, message.changes));
      case "openPullRequest":
        return inTurn(() => designToCode.openPullRequest(message.id, message.changes, message.token));
      // Closing waits its turn too, so it never cuts an apply short.
      case "close":
        return inTurn(async () => figma.closePlugin());
    }
  };
}

const repoOf = ({ repo, branch, path }: Connection): RepoSource => ({ repo, branch, path });

const pullRequestsOf = ({ repo, branch, token }: Connection) =>
  openPullRequests(repoApi(repo, token), branch);

function parseJson(text: string, origin: Origin): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(invalidJson(origin));
  }
}

/** Every plan a sync makes, each with what its names are shown after: a theme's name (`Desert: color/tint`), since
 * each theme has its own collection with the same names. */
function plansOf({ variables, textStyles, themes }: SyncPlan): { label: string; plan: Plan<unknown> }[] {
  return [
    { label: "", plan: variables },
    { label: "", plan: textStyles },
    ...themes.map(({ theme, variables }) => ({ label: `${theme}: `, plan: variables })),
  ];
}

function summarize(
  plan: SyncPlan,
  partial: boolean,
): Omit<
  PlanSummary,
  "missingFonts" | "darkLeftOut" | "applicable" | "figmaChanges" | "pullRequestsUnlisted"
> {
  const plans = plansOf(plan);
  const each = <T>(list: (p: Plan<unknown>) => T[]) =>
    plans.flatMap(({ label, plan }) => list(plan).map((entry) => ({ label, entry })));
  const updates = each((p) => p.update);
  return {
    create: each((p) => p.create).map(({ label, entry }) => label + entry.name),
    update: updates.filter(({ entry }) => !entry.restored).map(({ label, entry }) => label + entry.name),
    restore: updates.filter(({ entry }) => entry.restored).map(({ label, entry }) => label + entry.name),
    rename: each((p) => p.rename).map(({ label, entry }) => ({
      from: label + entry.name,
      to: label + (entry.token.reference ?? entry.token.name),
    })),
    deprecate: each((p) => p.deprecate).map(({ label, entry }) => label + entry.name),
    unchanged: plans.reduce((sum, { plan }) => sum + plan.unchanged, 0),
    partial,
    renamesSkipped: plans.some(({ plan }) => plan.renamesSkipped),
  };
}
