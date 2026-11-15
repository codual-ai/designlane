/** A local HTTP server that answers as GitHub's REST API does for one repo, for the endpoints the Figma plugin calls,
 * over a Git object store held in memory. */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { FILE_MODE, gitObjects } from "./git-objects.js";
import { type Answer, failure, type PullRequest, type RepoState, reads, writes } from "./github-routes.js";

export const API = "https://api.github.com";
const BEARER = /^Bearer (.+)$/;
const NO_STATUS_TEXT = "";

/** What a token may do: read the repo, or read and write it. */
export type Access = "read" | "write";

export interface ReceivedRequest {
  method: string;
  /** After `/repos/<repo>/`, as sent. */
  path: string;
  accept: string;
  token: string;
  body?: unknown;
}

/** GitHub's API for `repo`, its `branch` holding `files` at one commit, the tokens it accepts by what they may do. */
export async function startGitHubServer({
  repo,
  branch,
  files,
  tokens,
}: {
  repo: string;
  branch: string;
  files: Map<string, string>;
  tokens: Record<string, Access>;
}) {
  const git = gitObjects();
  const refs = new Map<string, string>();
  const pulls: PullRequest[] = [];
  const requests: ReceivedRequest[] = [];
  const refusals: { method: string; route: string; answer: Answer }[] = [];
  const now = () => Math.floor(Date.now() / 1000);
  const at = (path: string) => `${API}/repos/${repo}/${path}`;

  /** Commits `changed` on top of `onto`'s head, as a push does. */
  function push(changed: Map<string, string>, onto = branch): void {
    const parent = refs.get(onto);
    const base = parent ? git.commits.get(parent)?.tree : undefined;
    const entries = [...changed].map(([path, text]) => ({
      path,
      mode: FILE_MODE,
      sha: git.writeBlob(Buffer.from(text)),
    }));
    const tree = git.treeWith(base, entries);
    const sha = git.writeCommit({ tree, parents: parent ? [parent] : [], message: "Push", time: now() });
    refs.set(onto, sha);
  }
  push(files);

  const state: RepoState = { git, refs, pulls, repo, at, now };

  const server = createServer(async (request, response) => {
    const body = await bodyOf(request);
    const prefix = `/repos/${repo}/`;
    const url = request.url ?? "";
    const method = request.method ?? "GET";
    const accept = request.headers.accept ?? "";
    const token = BEARER.exec(request.headers.authorization ?? "")?.[1] ?? "";
    const path = url.startsWith(prefix) ? url.slice(prefix.length) : url;
    requests.push({ method, path, accept, token, ...(body === undefined ? {} : { body }) });
    const access = tokens[token];
    if (!access) return send(response, failure(401, "Bad credentials"));
    if (!url.startsWith(prefix)) return send(response, failure(404, "Not Found"));
    if (method !== "GET" && access !== "write") {
      return send(response, failure(403, "Resource not accessible by personal access token"));
    }
    const refused = refusals.find((refusal) => refusal.method === method && path === refusal.route);
    const [route = "", query = ""] = path.split("?");
    const answer = method === "GET" ? reads(state, route, query, accept) : writes(state, method, route, body);
    send(response, refused?.answer ?? answer);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    git,
    refs,
    pulls,
    requests,
    push,
    /** Makes GitHub answer `status` with `message` to every `method` request for `route`. */
    refuse(method: string, route: string, status: number, message: string) {
      refusals.push({ method, route, answer: failure(status, message) });
    },
    /** The files `name`'s head commit has, by path. */
    filesOn(name: string): Map<string, string> {
      const tree = git.commits.get(refs.get(name) ?? "")?.tree;
      return tree ? git.filesIn(tree) : new Map();
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export type GitHubServer = Awaited<ReturnType<typeof startGitHubServer>>;

async function bodyOf(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? undefined : JSON.parse(text);
}

/** Answers with no status text, as a browser sees GitHub's answers: over HTTP/2, which has none. */
function send(response: ServerResponse, { status, json, raw }: Answer): void {
  const headers = {
    "x-github-api-version-selected": "2022-11-28",
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": "4999",
  };
  if (raw) {
    response.writeHead(status, NO_STATUS_TEXT, {
      ...headers,
      "content-type": "application/vnd.github.raw; charset=utf-8",
    });
    response.end(raw);
    return;
  }
  if (json === undefined) {
    response.writeHead(status, NO_STATUS_TEXT, headers);
    response.end();
    return;
  }
  response.writeHead(status, NO_STATUS_TEXT, {
    ...headers,
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(json));
}
