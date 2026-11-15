/** Opens a pull request with a set of code edits: one commit on a new branch from the commit they were planned
 * against, through GitHub's Git API. */

import { z } from "zod";
import type { TextEdit } from "../../src/edit/plan.js";
import { changeLabel } from "./code-edits.js";
import { encodedPath, GitHubRefusal, type RepoApi } from "./github.js";
import type { FigmaChange } from "./messages.js";
import { messageOf } from "./notes.js";

const Created = z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) });
const Pull = z.object({ html_url: z.url().startsWith("https://github.com/") });
const SHORT_HASH = 7;
/** Branch names Designmap makes, apart from anyone's own. */
const BRANCH_PREFIX = "designmap/figma-";
const BACKTICKS = /`/g;

/** Where the edits were planned: the branch connected, and its head commit and that commit's tree. */
export interface Base {
  branch: string;
  commit: string;
  tree: string;
}

/** A file the pull request changes: its path in the repo, its Git mode, and its text with the edits made. */
export interface ChangedFile {
  path: string;
  mode: string;
  text: string;
}

/** A change made, its edit, and where in the repo that is. */
export interface MadeChange {
  change: FigmaChange;
  edit: TextEdit;
  path: string;
}

const pullRequestTitle = (count: number) =>
  `Design changes from Figma: ${count} ${count === 1 ? "value" : "values"}`;

/** The pull request's link. A branch it made is deleted again when GitHub won't open the pull request. */
export async function openPullRequest(
  api: RepoApi,
  base: Base,
  files: ChangedFile[],
  changes: MadeChange[],
  now: Date,
): Promise<string> {
  const title = pullRequestTitle(changes.length);
  const tree = await api.json(Created, "git/trees", {
    method: "POST",
    body: { base_tree: base.tree, tree: await Promise.all(files.map((file) => treeEntry(api, file))) },
  });
  const commit = await api.json(Created, "git/commits", {
    method: "POST",
    body: { message: title, tree: tree.sha, parents: [base.commit] },
  });
  const branch = `${BRANCH_PREFIX}${now.toISOString().slice(0, 10)}-${commit.sha.slice(0, SHORT_HASH)}`;
  await createBranch(api, branch, commit.sha);
  try {
    const body = { title, head: branch, base: base.branch, body: pullRequestBody(changes) };
    return (await api.json(Pull, "pulls", { method: "POST", body })).html_url;
  } catch (error) {
    // Only a refusal says no pull request was opened; after any other failure one may have been.
    if (!(error instanceof GitHubRefusal)) {
      throw new Error(
        `${messageOf(error)} The branch ${branch} is on GitHub: look there for its pull request first.`,
      );
    }
    await api.remove(`git/refs/heads/${encodedPath(branch)}`).catch(() => {
      throw new Error(`${messageOf(error)} The branch ${branch} is left on GitHub: delete it there.`);
    });
    throw error;
  }
}

async function treeEntry(api: RepoApi, { path, mode, text }: ChangedFile) {
  const blob = await api.json(Created, "git/blobs", {
    method: "POST",
    body: { content: text, encoding: "utf-8" },
  });
  return { path, mode, type: "blob", sha: blob.sha };
}

async function createBranch(api: RepoApi, branch: string, sha: string): Promise<void> {
  try {
    await api.json(z.unknown(), "git/refs", { method: "POST", body: { ref: `refs/heads/${branch}`, sha } });
  } catch (error) {
    // GitHub answers 422 for a branch that's there already, and 409 while another write to the repo is under way.
    if (error instanceof GitHubRefusal && (error.status === 409 || error.status === 422)) {
      throw new Error(
        `Couldn't make the branch ${branch} on ${api.repo}: it's there already. Press Open pull request again.`,
      );
    }
    throw error;
  }
}

/** Names and values in code spans, with any backtick of their own made plain so none can end the span. */
const code = (text: string) => `\`${text.replace(BACKTICKS, "'")}\``;

function pullRequestBody(changes: MadeChange[]): string {
  const lines = changes.map(
    ({ change, edit, path }) =>
      `- ${code(changeLabel(change))}: ${code(change.from)} → ${code(change.to)}, in ${code(`${path}:${edit.line}`)}`,
  );
  return [
    "Changed in Figma by a designer, and written into the code by Designmap from Figma, each value the way the code already writes it:",
    "",
    ...lines,
    "",
    "The app's tokens.json catches up the next time designmap runs.",
  ].join("\n");
}
