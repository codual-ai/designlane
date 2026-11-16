/** The plugin's design-to-code side: the Figma changes a plan found, the code edits planned for those the designer
 * ticks, and a pull request opened with them. */

import type { EditPlan, TextEdit } from "../../src/edit/plan.js";
import { type ReadSource, readingOnce } from "../../src/edit/read-source.js";
import { OLD_OUTPUT_DIR } from "../../src/output/old-names.js";
import { OUTPUT_DIR } from "../../src/output/output-files.js";
import { editedFiles, planCodeEdits } from "./code-edits.js";
import { forgetWriteToken, savedConnection, savedWriteToken, saveWriteToken } from "./connection.js";
import { GitHubRefusal, repoApi, TOKEN_NOT_ACCEPTED } from "./github.js";
import type { FigmaChange, PlannedEdit, ToWindow } from "./messages.js";
import { messageOf, type Origin } from "./notes.js";
import { type ChangedFile, type MadeChange, openPullRequest } from "./pull-request.js";
import { type Snapshot, snapshotOf } from "./repo-snapshot.js";

/** The changes the plan on screen found, and the tokens.json it was made from. */
interface Found {
  id: number;
  origin: Origin;
  json: string;
  changes: FigmaChange[];
}

/** The edits planned for the ticked changes, against one commit of the repo. */
interface Planned {
  id: number;
  repo: string;
  branch: string;
  tokensFile: string;
  snapshot: Snapshot;
  /** The app's folder in the repo, which tokens.json's paths are relative to. */
  root: string;
  read: ReadSource;
  plans: Map<FigmaChange, EditPlan>;
}

const NO_REPO =
  "Connect this file to the app's repo to open a pull request. A picked tokens.json can't open one.";
const CHANGED = "The plan changed. Look it over, then tick the changes again.";

export function createDesignToCode(send: (message: ToWindow) => void) {
  let found: Found | undefined;
  let planned: Planned | undefined;

  /** Runs `step` for the plan `id`, showing a failure beside the plan rather than in its place. */
  const forPlan = async (id: number, step: () => Promise<void>) => {
    await step().catch((error: unknown) =>
      send({ type: "designToCodeError", id, message: messageOf(error) }),
    );
  };

  async function planEdits(id: number, ids: string[]): Promise<void> {
    planned = undefined;
    if (found?.id !== id) throw new Error(CHANGED);
    if (found.origin !== "repo") throw new Error(NO_REPO);
    const connection = await savedConnection();
    if (!connection) throw new Error(NO_REPO);
    const root = appRoot(connection.path);
    const api = repoApi(connection.repo, connection.token);
    const snapshot = await snapshotOf(api, connection.branch);
    const json = await snapshot.read(connection.path);
    if (json !== found.json) {
      throw new Error(
        `${connection.branch} changed since you checked it. Press Check again, then tick the changes.`,
      );
    }
    const read = readingOnce((file) => snapshot.read(inRoot(root, file)));
    // A change already in an open pull request isn't offered again, so a second one never has it.
    const ticked = found.changes.filter((change) => ids.includes(change.id) && !change.pullRequest);
    const plans = await planCodeEdits(JSON.parse(json), read, ticked);
    const { repo, branch, path: tokensFile } = connection;
    planned = { id, repo, branch, tokensFile, snapshot, root, read, plans };
    send({ type: "edits", id, edits: [...plans].map(([change, plan]) => plannedEdit(change, plan)) });
  }

  async function openRequest(id: number, ids: string[], given: string | undefined): Promise<void> {
    if (planned?.id !== id) throw new Error(CHANGED);
    const { repo, branch, tokensFile, snapshot, root, read, plans } = planned;
    const made: MadeChange[] = [...plans].flatMap(([change, plan]) =>
      plan.ok && ids.includes(change.id)
        ? [{ change, edit: plan.edit, path: inRoot(root, plan.edit.file) }]
        : [],
    );
    if (made.length === 0) throw new Error("Tick at least one edit to open a pull request.");
    if (given !== undefined) {
      if (given.trim() === "")
        throw new Error("Paste a GitHub token that can open pull requests on this repo.");
      await saveWriteToken(repo, given.trim());
    }
    const token = await savedWriteToken(repo);
    if (!token) return send({ type: "writeTokenNeeded", id, repo });
    const files = await changedFiles(
      snapshot,
      read,
      root,
      made.map(({ edit }) => edit),
    );
    const base = { branch, commit: snapshot.commit, tree: snapshot.tree, tokensFile };
    try {
      const url = await openPullRequest(repoApi(repo, token), base, files, made, new Date());
      // The same edits again would open a second pull request.
      planned = undefined;
      send({ type: "pullRequest", id, url });
    } catch (error) {
      if (!needsOtherToken(error)) throw error;
      await forgetWriteToken(repo);
      send({ type: "writeTokenNeeded", id, repo, reason: refusedWith(error, repo) });
    }
  }

  return {
    /** The changes a new plan found; any edits planned for the plan before are gone with it. */
    found(id: number, origin: Origin, json: string, changes: FigmaChange[]): void {
      found = { id, origin, json, changes };
      planned = undefined;
    },
    planEdits: (id: number, ids: string[]) => forPlan(id, () => planEdits(id, ids)),
    openPullRequest: (id: number, ids: string[], token: string | undefined) =>
      forPlan(id, () => openRequest(id, ids, token)),
  };
}

function plannedEdit(change: FigmaChange, plan: EditPlan): PlannedEdit {
  if (!plan.ok) return { ok: false, change: change.id, reason: plan.reason };
  const { file, line, before, after } = plan.edit;
  return { ok: true, change: change.id, file, line, before, after };
}

/** The app's folder in the repo: tokens.json sits in its `designlane/` folder, or the `designmap/` of an app set up
 * before the rename. */
function appRoot(path: string): string {
  const parts = path.split("/");
  const folder = parts[parts.length - 2];
  if (folder !== OUTPUT_DIR && folder !== OLD_OUTPUT_DIR) {
    throw new Error(
      `Opening a pull request needs the tokens file in the app's ${OUTPUT_DIR}/ folder, where designlane writes it.`,
    );
  }
  return parts.slice(0, -2).join("/");
}

const inRoot = (root: string, file: string) => (root ? `${root}/${file}` : file);

async function changedFiles(
  snapshot: Snapshot,
  read: ReadSource,
  root: string,
  edits: TextEdit[],
): Promise<ChangedFile[]> {
  const files: ChangedFile[] = [];
  for (const [file, text] of await editedFiles(read, edits)) {
    const path = inRoot(root, file);
    const mode = await snapshot.mode(path);
    if (!mode) throw new Error(`${path} isn't in the repo any more. Press Check again.`);
    files.push({ path, mode, text });
  }
  return files;
}

/** GitHub refused the token itself, or what it may do: a token that can only read is told it can't write, or, without
 * access to the repo at all, that there's no such repo. */
const needsOtherToken = (error: unknown) =>
  error instanceof GitHubRefusal && !error.rateLimited && [401, 403, 404].includes(error.status);

function refusedWith(error: unknown, repo: string): string {
  if (error instanceof GitHubRefusal && error.status === 401) {
    return `${TOKEN_NOT_ACCEPTED} Make a new one and paste it here.`;
  }
  return `The token can't open pull requests on ${repo}. Give it access to this repo with Contents and Pull requests, both Read and write.`;
}
