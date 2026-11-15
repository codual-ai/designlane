/** GitHub's API for one repo as the plugin's `fetch` sees it: the contents and Git endpoints the plugin uses, over
 * commits and trees held in memory, with every request kept to look at and any of them made to fail. */

import { vi } from "vitest";

export type RepoFiles = Record<string, string>;

interface TreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
}

/** A file in a tree: its Git mode and text. */
interface Stored {
  mode: string;
  text: string;
}

export interface SentRequest {
  method: string;
  /** After `https://api.github.com/repos/<repo>/`. */
  path: string;
  token: string;
  body?: unknown;
}

interface Refusal {
  method: string;
  path: string;
  status: number;
  headers: Record<string, string>;
}

/** A pull request opened, as its request's body has it; `repo` for one opened from a fork. */
export interface PullBody {
  title: string;
  head: string;
  base: string;
  body: string | null;
  repo?: string;
}

const PLAIN_FILE = "100644";
const BASE = /(?:^|&)base=([^&]*)/;
const SPREAD = 2654435761;
const BYTE_ORDER_MARK = /^\uFEFF/;
const ESCAPED_BYTE = /%[0-9A-F]{2}/g;

/** How many bytes `text` takes as UTF-8, as a tree entry's size says. */
const utf8Bytes = (text: string) => encodeURIComponent(text).replace(ESCAPED_BYTE, "x").length;
const API = "https://api.github.com/";

export function fakeGitHub({
  repo = "octo/app",
  branch = "main",
  files,
  modes = {},
  truncated = false,
  pullUrl = "https://github.com",
}: {
  repo?: string;
  branch?: string;
  files: RepoFiles;
  /** Git modes other than a plain file's, by path. */
  modes?: Record<string, string>;
  /** Whether GitHub says it listed only part of each folder. */
  truncated?: boolean;
  /** Where GitHub says the pull requests it opens are. */
  pullUrl?: string;
}) {
  let next = 0;
  // Spread out, as real hashes are, so their short forms differ too.
  const newSha = () => ((++next * SPREAD) >>> 0).toString(16).padStart(8, "0").repeat(5);
  const blobs = new Map<string, string>();
  const trees = new Map<string, { entries: TreeEntry[]; files: Map<string, Stored> }>();
  const commits = new Map<string, { tree: string; message?: string; parents?: string[] }>();
  const refs = new Map<string, string>();
  const pulls: PullBody[] = [];
  /** The pull requests closed, by number. */
  const closed = new Set<number>();
  const requests: SentRequest[] = [];
  const refusals: Refusal[] = [];
  let reachable = true;

  function blob(text: string): string {
    const sha = newSha();
    blobs.set(sha, text);
    return sha;
  }

  /** A tree holding `stored`, its folders as trees of their own. */
  function treeOf(stored: Map<string, Stored>): string {
    const folders = new Map<string, Map<string, Stored>>();
    const entries: TreeEntry[] = [];
    for (const [path, file] of stored) {
      const slash = path.indexOf("/");
      if (slash === -1) {
        entries.push({
          path,
          mode: file.mode,
          type: "blob",
          sha: blob(file.text),
          size: utf8Bytes(file.text),
        });
        continue;
      }
      const folder = folders.get(path.slice(0, slash)) ?? new Map<string, Stored>();
      folder.set(path.slice(slash + 1), file);
      folders.set(path.slice(0, slash), folder);
    }
    for (const [name, inside] of folders)
      entries.push({ path: name, mode: "040000", type: "tree", sha: treeOf(inside) });
    const sha = newSha();
    trees.set(sha, { entries, files: stored });
    return sha;
  }

  const initial = new Map(
    Object.entries(files).map(([path, text]) => [path, { mode: modes[path] ?? PLAIN_FILE, text }]),
  );
  const head = newSha();
  commits.set(head, { tree: treeOf(initial) });
  refs.set(branch, head);

  /** The files a branch's head commit has, by path. */
  function filesOn(name: string): RepoFiles {
    const commit = commits.get(refs.get(name) ?? "");
    const tree = trees.get(commit?.tree ?? "");
    return Object.fromEntries([...(tree?.files ?? [])].map(([path, file]) => [path, file.text]));
  }

  const answer = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status < 300 ? "OK" : "Error",
    headersObject: headers,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  });

  function route(method: string, path: string, body: Record<string, unknown>) {
    const [route = "", query = ""] = path.split("?");
    const tail = (prefix: string) => decodeURIComponent(route.slice(prefix.length));
    if (method === "GET" && route.startsWith("contents/")) {
      const ref = query.startsWith("ref=") ? decodeURIComponent(query.slice("ref=".length)) : branch;
      const text = filesOn(ref)[tail("contents/")];
      return text === undefined ? answer(404) : answer(200, text);
    }
    if (method === "GET" && route.startsWith("git/ref/heads/")) {
      const sha = refs.get(tail("git/ref/heads/"));
      return sha ? answer(200, { object: { sha } }) : answer(404);
    }
    if (method === "GET" && route.startsWith("git/commits/")) {
      const commit = commits.get(tail("git/commits/"));
      return commit ? answer(200, { tree: { sha: commit.tree } }) : answer(404);
    }
    if (method === "GET" && route.startsWith("git/trees/")) {
      const tree = trees.get(tail("git/trees/"));
      return tree ? answer(200, { tree: tree.entries, truncated }) : answer(404);
    }
    if (method === "GET" && route.startsWith("git/blobs/")) {
      const text = blobs.get(tail("git/blobs/"));
      // A fetch response's text drops a byte order mark, as a browser's does.
      return text === undefined ? answer(404) : answer(200, text.replace(BYTE_ORDER_MARK, ""));
    }
    if (method === "POST" && route === "git/blobs") return answer(201, { sha: blob(String(body.content)) });
    if (method === "POST" && route === "git/trees") return answer(201, { sha: newTree(body) });
    if (method === "POST" && route === "git/commits") {
      const sha = newSha();
      commits.set(sha, {
        tree: String(body.tree),
        message: String(body.message),
        parents: body.parents as string[],
      });
      return answer(201, { sha });
    }
    if (method === "POST" && route === "git/refs") {
      const name = String(body.ref).replace(/^refs\/heads\//, "");
      if (refs.has(name)) return answer(422, { message: "Reference already exists" });
      refs.set(name, String(body.sha));
      return answer(201, { ref: body.ref });
    }
    if (method === "GET" && route === "pulls") {
      const base = decodeURIComponent(BASE.exec(query)?.[1] ?? "");
      const open = pulls.flatMap((pull, index) =>
        closed.has(index + 1) || pull.base !== base ? [] : [listedPull(pull, index + 1)],
      );
      return answer(200, open);
    }
    if (method === "POST" && route === "pulls") {
      pulls.push({
        title: String(body.title),
        head: String(body.head),
        base: String(body.base),
        body: String(body.body),
      });
      return answer(201, {
        html_url: `${pullUrl}/${repo}/pull/${pulls.length}`,
        number: pulls.length,
      });
    }
    if (method === "DELETE" && route.startsWith("git/refs/heads/")) {
      refs.delete(tail("git/refs/heads/"));
      return answer(204, "");
    }
    return answer(404);
  }

  /** A pull request as GitHub lists it; `repo` is where its branch is, another one's for a fork's. */
  const listedPull = (pull: PullBody, number: number) => ({
    number,
    html_url: `${pullUrl}/${repo}/pull/${number}`,
    head: { ref: pull.head, repo: { full_name: pull.repo ?? repo } },
    base: { ref: pull.base },
    body: pull.body,
  });

  /** A tree from `base_tree` with the files `tree` lists put in. */
  function newTree(body: Record<string, unknown>): string {
    const base = trees.get(String(body.base_tree));
    const stored = new Map(base?.files ?? []);
    for (const entry of body.tree as { path: string; mode: string; sha: string }[]) {
      stored.set(entry.path, { mode: entry.mode, text: blobs.get(entry.sha) ?? "" });
    }
    return treeOf(stored);
  }

  const fetch = vi.fn(async (url: string, init: FetchOptions = {}) => {
    if (!reachable) throw new TypeError("Failed to fetch");
    const prefix = `${API}repos/${repo}/`;
    if (!url.startsWith(prefix)) throw new Error(`a request outside ${repo}: ${url}`);
    const method = init.method ?? "GET";
    const path = url.slice(prefix.length);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const token = (init.headers?.Authorization ?? "").replace(/^Bearer /, "");
    requests.push({ method, path, token, ...(body === undefined ? {} : { body }) });
    const refused = refusals.find((r) => r.method === method && path.startsWith(r.path));
    if (refused) return answer(refused.status, { message: "refused" }, refused.headers);
    return route(method, path, body ?? {});
  });
  vi.stubGlobal("fetch", fetch);

  return {
    fetch,
    requests,
    pulls,
    closed,
    refs,
    commits,
    filesOn,
    /** Commits `changed` to `branch` on top of its head, as a push would. */
    push(changed: RepoFiles, onto = branch) {
      const tree = trees.get(commits.get(refs.get(onto) ?? "")?.tree ?? "");
      const stored = new Map(tree?.files ?? []);
      for (const [path, text] of Object.entries(changed)) stored.set(path, { mode: PLAIN_FILE, text });
      const sha = newSha();
      commits.set(sha, { tree: treeOf(stored) });
      refs.set(onto, sha);
    },
    /** Makes GitHub answer `status` to `method` requests whose path starts with `path`. */
    refuse(method: string, path: string, status: number, headers: Record<string, string> = {}) {
      refusals.push({ method, path, status, headers });
    },
    /** Takes back every refusal. */
    accept() {
      refusals.length = 0;
    },
    /** Makes every request fail as without a network. */
    disconnect() {
      reachable = false;
    },
  };
}
