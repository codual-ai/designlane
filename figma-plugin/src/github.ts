/** The plugin's requests to GitHub's API, the one place a token is sent, with GitHub's refusals put in words a designer
 * can act on. */

import type { z } from "zod";
import { type Connection, isRepoName, parsedJson } from "./connection.js";
import type { RepoSource } from "./messages.js";

const GITHUB_API = "https://api.github.com";
/** Asks for a file's contents as they are, rather than wrapped in JSON. */
const RAW_CONTENTS = "application/vnd.github.raw+json";
const JSON_CONTENTS = "application/vnd.github+json";
const API_VERSION = "2022-11-28";

const TOKEN_REJECTED =
  "GitHub didn't accept the token: it may be mistyped or expired. Check it, or make a new one, then connect again.";
const RATE_LIMITED = "GitHub is limiting requests for now. Try again in a few minutes.";
const UNREACHABLE = "Couldn't reach GitHub. Check your internet connection, then try again.";
const UNEXPECTED = "GitHub answered in a way Designmap doesn't expect. Try again in a moment.";

/** A request GitHub refused, worded for a designer unless the caller knows better what its status means here. */
export class GitHubRefusal extends Error {
  readonly status: number;
  readonly rateLimited: boolean;

  constructor(response: FetchResponse) {
    super(refusalWords(response));
    this.status = response.status;
    this.rateLimited = isRateLimited(response);
  }
}

function refusalWords(response: FetchResponse): string {
  if (isRateLimited(response)) return RATE_LIMITED;
  if (response.status === 401) return TOKEN_REJECTED;
  // Over HTTP/2, as a browser reaches GitHub, an answer has no status text.
  const status = response.statusText ? `${response.status} ${response.statusText}` : response.status;
  return `GitHub answered ${status}. Try again in a moment.`;
}

/** A path with each part encoded, so a branch or file name holding `#`, `?` or a space stays one part. */
export const encodedPath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

interface Request {
  method?: "GET" | "POST" | "DELETE";
  accept?: string;
  body?: unknown;
}

async function send(
  token: string,
  path: string,
  { method = "GET", accept, body }: Request,
): Promise<FetchResponse> {
  try {
    return await fetch(`${GITHUB_API}/${path}`, {
      method,
      headers: {
        Accept: accept ?? JSON_CONTENTS,
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": API_VERSION,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      // GitHub lets a client reuse its answer for a minute, which would read the repo as it was before CI's latest.
      cache: "no-store",
    });
  } catch {
    throw new Error(UNREACHABLE);
  }
}

async function accepted(token: string, path: string, request: Request): Promise<FetchResponse> {
  const response = await send(token, path, request);
  if (!response.ok) throw new GitHubRefusal(response);
  return response;
}

/** GitHub's API for one repo, as `token` may use it. The repo's name is checked again here, where it becomes a URL,
 * since one kept on the file may not have come through the connect form. */
export function repoApi(repo: string, token: string) {
  if (!isRepoName(repo)) throw new Error(`"${repo}" isn't a repo name. Connect the repo again.`);
  const at = (path: string) => `repos/${repo}/${path}`;
  return {
    repo,
    /** GitHub's JSON answer, checked to be what `schema` describes. */
    async json<S extends z.ZodType>(schema: S, path: string, request: Request = {}): Promise<z.output<S>> {
      const text = await (await accepted(token, at(path), request)).text();
      const parsed = schema.safeParse(parsedJson(text));
      if (!parsed.success) throw new Error(UNEXPECTED);
      return parsed.data;
    },
    async raw(path: string): Promise<string> {
      return (await accepted(token, at(path), { accept: RAW_CONTENTS })).text();
    },
    async remove(path: string): Promise<void> {
      await accepted(token, at(path), { method: "DELETE" });
    },
  };
}

export type RepoApi = ReturnType<typeof repoApi>;

/** The file `connection` points at; its settings are checked by `checkConnection` first. */
export async function fetchTokensFile({ repo, branch, path, token }: Connection): Promise<string> {
  const url = `repos/${repo}/contents/${encodedPath(path)}?ref=${encodeURIComponent(branch)}`;
  const response = await send(token, url, { accept: RAW_CONTENTS });
  if (response.ok) return response.text();
  throw new Error(refusalMessage(response, { repo, branch, path }));
}

function refusalMessage(response: FetchResponse, { repo, branch, path }: RepoSource): string {
  if (response.status === 403 && !isRateLimited(response)) {
    return `The token can't read ${repo}. Give it read access to this repo's contents.`;
  }
  if (response.status === 404) {
    return `Couldn't find ${path} on ${branch} in ${repo}. Check the names and that the token can read the repo. A repo with both an iPhone and an Android app has designmap/tokens.ios.json and designmap/tokens.android.json instead. If CI hasn't written the file yet, it will on the next push.`;
  }
  return new GitHubRefusal(response).message;
}

/** GitHub's limits: the hourly one used up, or a secondary one asking the client to wait. */
const isRateLimited = (response: FetchResponse) =>
  response.status === 429 ||
  (response.status === 403 &&
    (header(response, "x-ratelimit-remaining") === "0" || header(response, "retry-after") !== undefined));

/** A response header, whatever case GitHub gave its name in. */
const header = (response: FetchResponse, name: string) =>
  Object.entries(response.headersObject).find(([key]) => key.toLowerCase() === name)?.[1];
