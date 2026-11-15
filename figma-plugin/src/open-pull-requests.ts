/** The pull requests Designmap opened from Figma that are still open, found by a marker in each one's description
 * listing the values it changes and the tokens file they're for, so a change already in one isn't offered again. */

import { z } from "zod";
import { EDIT_PROPERTIES } from "../../src/edit/edit-tokens.js";
import { parsedJson } from "./connection.js";
import type { RepoApi } from "./github.js";
import type { FigmaChange } from "./messages.js";

/** Branch names Designmap makes, apart from anyone's own. */
export const BRANCH_PREFIX = "designmap/figma-";
const MARKER_START = "<!-- designmap-figma-changes ";
const MARKER_END = " -->";
/** Escaped inside the marker's JSON strings, where it's the only character that could end the comment early. */
const COMMENT_CLOSER = />/g;
const ESCAPED_CLOSER = "\\u003e";
/** As many as GitHub lists at once; a repo with more open pull requests has their newest checked. */
const PAGE_SIZE = 100;

const MarkedValue = z.object({ token: z.string(), property: z.enum(EDIT_PROPERTIES), value: z.string() });
/** `tokens`: the tokens.json the values are for, which tells one app's from another's in a repo with several. */
const Marked = z.object({ tokens: z.string(), values: z.array(MarkedValue) });
type MarkedValue = z.infer<typeof MarkedValue>;
/** A pull request's page, which GitHub gives as its `html_url`. */
export const PullRequestPage = z.url().startsWith("https://github.com/");
const Pulls = z.array(
  z.object({
    html_url: PullRequestPage,
    head: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
    body: z.string().nullable(),
  }),
);

interface OpenPullRequest {
  url: string;
  values: MarkedValue[];
}

/** The open pull requests GitHub listed, or that it couldn't list them. */
export type OpenPullRequests = { listed: true; pulls: OpenPullRequest[] } | { listed: false };

export const NO_PULL_REQUESTS: OpenPullRequests = { listed: true, pulls: [] };

/** The marker for a pull request's description: the values it changes for `tokensFile`, out of sight in an HTML
 * comment. */
export function markerOf(tokensFile: string, changes: readonly FigmaChange[]): string {
  const values: MarkedValue[] = changes.map(({ token, property, to }) => ({ token, property, value: to }));
  const json = JSON.stringify({ tokens: tokensFile, values });
  return `${MARKER_START}${json.replace(COMMENT_CLOSER, ESCAPED_CLOSER)}${MARKER_END}`;
}

/** The values a description's marker lists for `tokensFile`; none for one without a marker, such as one opened before
 * markers, or one for another app's tokens file. */
function markedValues(body: string | null, tokensFile: string): MarkedValue[] {
  const start = body?.indexOf(MARKER_START) ?? -1;
  if (!body || start === -1) return [];
  const end = body.indexOf(MARKER_END, start + MARKER_START.length);
  if (end === -1) return [];
  const marked = Marked.safeParse(parsedJson(body.slice(start + MARKER_START.length, end))).data;
  return marked?.tokens === tokensFile ? marked.values : [];
}

/** Designmap's open pull requests into `branch` for `tokensFile`'s app: those from one of its own branches in the repo
 * itself. */
export async function openPullRequests(
  api: RepoApi,
  branch: string,
  tokensFile: string,
): Promise<OpenPullRequests> {
  const query = `state=open&base=${encodeURIComponent(branch)}&per_page=${PAGE_SIZE}`;
  try {
    const pulls = await api.json(Pulls, `pulls?${query}`);
    const ours = pulls.filter(
      ({ head }) =>
        head.ref.startsWith(BRANCH_PREFIX) && head.repo?.full_name.toLowerCase() === api.repo.toLowerCase(),
    );
    return {
      listed: true,
      pulls: ours.map(({ html_url, body }) => ({ url: html_url, values: markedValues(body, tokensFile) })),
    };
  } catch {
    // A token without access to pull requests, or GitHub unreachable, leaves the changes offered as they are.
    return { listed: false };
  }
}

/** `changes`, each with the link of an open pull request that already has its value. */
export function withPullRequests(changes: FigmaChange[], open: OpenPullRequests): FigmaChange[] {
  if (!open.listed) return changes;
  return changes.map((change) => {
    const pull = open.pulls.find(({ values }) =>
      values.some(
        ({ token, property, value }) =>
          token === change.token && property === change.property && value === change.to,
      ),
    );
    return pull ? { ...change, pullRequest: pull.url } : change;
  });
}
