/** GitHub's REST API endpoints the Figma plugin calls, answered from a Git object store as GitHub answers them:
 * GitHub's statuses, the fields of its answers, and its refusals of what it won't take. */

import { z } from "zod";
import { FILE_MODE, type GitObjects } from "./git-objects.js";

const RAW = "application/vnd.github.raw+json";
const DOCS = "https://docs.github.com/rest";
const HEADS = "refs/heads/";

export interface Answer {
  status: number;
  json?: unknown;
  raw?: Buffer;
}

export const failure = (status: number, message: string): Answer => ({
  status,
  json: { message, documentation_url: DOCS, status: String(status) },
});
const NOT_FOUND = failure(404, "Not Found");

const BlobBody = z.object({ content: z.string(), encoding: z.enum(["utf-8", "base64"]).default("utf-8") });
const TreeBody = z.object({
  base_tree: z.string().optional(),
  tree: z.array(
    z.object({
      path: z.string(),
      mode: z.enum([FILE_MODE, "100755"]),
      type: z.literal("blob"),
      sha: z.string(),
    }),
  ),
});
const CommitBody = z.object({ message: z.string(), tree: z.string(), parents: z.array(z.string()) });
const RefBody = z.object({ ref: z.string().startsWith(HEADS), sha: z.string() });
const PullBody = z.object({ title: z.string(), head: z.string(), base: z.string(), body: z.string() });
/** A pull request opened, and whether it's still open. */
export type PullRequest = z.infer<typeof PullBody> & { state: "open" | "closed" };

export interface RepoState {
  git: GitObjects;
  refs: Map<string, string>;
  pulls: PullRequest[];
  repo: string;
  at: (path: string) => string;
  now: () => number;
}

/** GitHub's answers for the repo, each with GitHub's status and the fields of its own answer. */
function answers({ git, refs, repo, at }: RepoState) {
  return {
    ref: (name: string, sha: string) => ({
      ref: `${HEADS}${name}`,
      node_id: `REF_${sha.slice(0, 8)}`,
      url: at(`git/refs/heads/${name}`),
      object: { sha, type: "commit", url: at(`git/commits/${sha}`) },
    }),
    commit(sha: string) {
      const commit = git.commits.get(sha);
      if (!commit) return undefined;
      return {
        sha,
        node_id: `C_${sha.slice(0, 8)}`,
        url: at(`git/commits/${sha}`),
        html_url: `https://github.com/${repo}/commit/${sha}`,
        message: commit.message,
        tree: { sha: commit.tree, url: at(`git/trees/${commit.tree}`) },
        parents: commit.parents.map((parent) => ({ sha: parent, url: at(`git/commits/${parent}`) })),
      };
    },
    tree(sha: string) {
      const entries = git.trees.get(sha);
      if (!entries) return undefined;
      const tree = entries.map(({ name, mode, type, sha: entrySha }) => ({
        path: name,
        mode,
        type,
        sha: entrySha,
        ...(type === "blob" ? { size: git.blobs.get(entrySha)?.length ?? 0 } : {}),
        url: at(`git/${type}s/${entrySha}`),
      }));
      return { sha, url: at(`git/trees/${sha}`), tree, truncated: false };
    },
    /** A file's bytes as they are when asked for raw, or else as JSON holding them in base64. */
    contents: (content: Buffer, accept: string, fields: Record<string, unknown>): Answer =>
      accept === RAW
        ? { status: 200, raw: content }
        : {
            status: 200,
            json: {
              ...fields,
              size: content.length,
              content: content.toString("base64"),
              encoding: "base64",
            },
          },
    /** The file at `path` in `ref`'s head commit. */
    fileOn(ref: string, path: string): string | undefined {
      const tree = git.commits.get(refs.get(ref) ?? "")?.tree;
      return tree === undefined ? undefined : git.filesIn(tree).get(path);
    },
  };
}

const ok = (json: unknown, status = 200): Answer => (json === undefined ? NOT_FOUND : { status, json });

/** The GET endpoints the plugin reads the repo with. */
export function reads(state: RepoState, route: string, query: string, accept: string): Answer {
  const { git, refs, at } = state;
  const answer = answers(state);
  const tail = (prefix: string) => decodeURIComponent(route.slice(prefix.length));
  if (route.startsWith("contents/")) {
    const path = tail("contents/");
    const text = answer.fileOn(new URLSearchParams(query).get("ref") ?? "", path);
    return text === undefined
      ? NOT_FOUND
      : answer.contents(Buffer.from(text), accept, { type: "file", path });
  }
  if (route.startsWith("git/ref/heads/")) {
    const name = tail("git/ref/heads/");
    const sha = refs.get(name);
    return ok(sha && answer.ref(name, sha));
  }
  if (route.startsWith("git/commits/")) return ok(answer.commit(tail("git/commits/")));
  if (route.startsWith("git/trees/")) {
    // Only a folder's own listing: the plugin never asks for a recursive one.
    if (query.includes("recursive")) return failure(400, "Unexpected recursive listing");
    return ok(answer.tree(tail("git/trees/")));
  }
  if (route === "pulls") return openPulls(state, new URLSearchParams(query));
  if (route.startsWith("git/blobs/")) {
    const sha = tail("git/blobs/");
    const blob = git.blobs.get(sha);
    return blob ? answer.contents(blob, accept, { sha, url: at(`git/blobs/${sha}`) }) : NOT_FOUND;
  }
  return NOT_FOUND;
}

/** The pull requests `query` asks for, as GitHub lists them: open ones only, into its `base` when it names one. */
function openPulls({ pulls, repo, at }: RepoState, query: URLSearchParams): Answer {
  if (query.get("state") !== "open") return failure(400, "Unexpected listing of closed pull requests");
  const base = query.get("base");
  const listed = pulls.flatMap((pull, index) => {
    if (pull.state !== "open" || (base !== null && pull.base !== base)) return [];
    const number = index + 1;
    return [
      {
        number,
        state: pull.state,
        title: pull.title,
        body: pull.body,
        url: at(`pulls/${number}`),
        html_url: `https://github.com/${repo}/pull/${number}`,
        head: { ref: pull.head, repo: { full_name: repo } },
        base: { ref: pull.base, repo: { full_name: repo } },
      },
    ];
  });
  return { status: 200, json: listed };
}

const INVALID = failure(422, "Invalid request.");

/** The POST and DELETE endpoints the plugin opens a pull request with, refusing what GitHub refuses. */
export function writes(state: RepoState, method: string, route: string, body: unknown): Answer {
  const { git, refs, pulls, repo, at, now } = state;
  const answer = answers(state);
  if (method === "DELETE" && route.startsWith("git/refs/heads/")) {
    const name = decodeURIComponent(route.slice("git/refs/heads/".length));
    return refs.delete(name) ? { status: 204 } : failure(422, "Reference does not exist");
  }
  if (method !== "POST") return NOT_FOUND;
  if (route === "git/blobs") {
    const blob = BlobBody.safeParse(body).data;
    if (!blob) return INVALID;
    const sha = git.writeBlob(Buffer.from(blob.content, blob.encoding === "base64" ? "base64" : "utf8"));
    return ok({ sha, url: at(`git/blobs/${sha}`) }, 201);
  }
  if (route === "git/trees") {
    const tree = TreeBody.safeParse(body).data;
    if (!tree) return INVALID;
    if (tree.base_tree !== undefined && !git.trees.has(tree.base_tree)) {
      return failure(422, "base_tree is not a valid tree oid");
    }
    if (tree.tree.some((entry) => !git.blobs.has(entry.sha)))
      return failure(422, "tree.sha is not a valid blob");
    return ok(answer.tree(git.treeWith(tree.base_tree, tree.tree)), 201);
  }
  if (route === "git/commits") {
    const commit = CommitBody.safeParse(body).data;
    if (!commit) return INVALID;
    if (!git.trees.has(commit.tree) || commit.parents.some((parent) => !git.commits.has(parent))) {
      return failure(422, "Tree SHA does not exist");
    }
    return ok(answer.commit(git.writeCommit({ ...commit, time: now() })), 201);
  }
  if (route === "git/refs") {
    const ref = RefBody.safeParse(body).data;
    if (!ref || !git.commits.has(ref.sha)) return failure(422, "Reference update failed");
    const name = ref.ref.slice(HEADS.length);
    if (refs.has(name)) return failure(422, "Reference already exists");
    refs.set(name, ref.sha);
    return ok(answer.ref(name, ref.sha), 201);
  }
  if (route === "pulls") {
    const pull = PullBody.safeParse(body).data;
    if (!pull || !refs.has(pull.head) || !refs.has(pull.base)) return failure(422, "Validation Failed");
    pulls.push({ ...pull, state: "open" });
    const number = pulls.length;
    return ok(
      { number, state: "open", title: pull.title, html_url: `https://github.com/${repo}/pull/${number}` },
      201,
    );
  }
  return NOT_FOUND;
}
