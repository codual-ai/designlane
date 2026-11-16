/** The plugin's requests to GitHub's API, the one place a token is sent, with GitHub's refusals put in words a designer
 * can act on. */

import { z } from "zod";
import { OLD_OUTPUT_DIR } from "../../src/output/old-names.js";
import { OUTPUT_DIR } from "../../src/output/output-files.js";
import { type Connection, isRepoName, parsedJson } from "./connection.js";
import type { RepoSource } from "./messages.js";

const GITHUB_API = "https://api.github.com";
/** Asks for a file's contents as they are, rather than wrapped in JSON. */
const RAW_CONTENTS = "application/vnd.github.raw+json";
const JSON_CONTENTS = "application/vnd.github+json";
const API_VERSION = "2022-11-28";

/** How every message saying GitHub refused a token outright (401) starts. */
export const TOKEN_NOT_ACCEPTED = "GitHub didn't accept the token: it may be mistyped or expired.";
const TOKEN_REJECTED = `${TOKEN_NOT_ACCEPTED} Check it, or make a new one, then connect again.`;
const RATE_LIMITED = "GitHub is limiting requests for now. Try again in a few minutes.";
const UNREACHABLE = "Couldn't reach GitHub. Check your internet connection, then try again.";
const UNEXPECTED = "GitHub answered in a way Designlane doesn't expect. Try again in a moment.";

/** A Git object's full hash, as GitHub's API gives it. */
export const Sha = z.string().regex(/^[0-9a-f]{40}$/);

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
export async function fetchTokensFile(connection: Connection): Promise<string> {
  const response = await requestTokensFile(connection);
  if (response.ok) return response.text();
  throw new Error(refusalMessage(response, connection));
}

/** The file `connection` points at, with the connection that read it: for a path in a `designlane/` folder that isn't
 * there, the same file in `designmap/` when an app set up before the rename has it there. */
export async function findTokensFile(
  connection: Connection,
): Promise<{ json: string; connection: Connection }> {
  const response = await requestTokensFile(connection);
  if (response.ok) return { json: await response.text(), connection };
  const oldPath = oldFolderPath(connection.path);
  if (response.status === 404 && oldPath) {
    const old = { ...connection, path: oldPath };
    const oldResponse = await requestTokensFile(old);
    if (oldResponse.ok) return { json: await oldResponse.text(), connection: old };
  }
  throw new Error(refusalMessage(response, connection));
}

const requestTokensFile = ({ repo, branch, path, token }: Connection) =>
  send(token, `repos/${repo}/contents/${encodedPath(path)}?ref=${encodeURIComponent(branch)}`, {
    accept: RAW_CONTENTS,
  });

/** `path` in the old output folder, when it's a file in the current one. */
function oldFolderPath(path: string): string | undefined {
  const parts = path.split("/");
  if (parts.length < 2 || parts[parts.length - 2] !== OUTPUT_DIR) return undefined;
  return [...parts.slice(0, -2), OLD_OUTPUT_DIR, ...parts.slice(-1)].join("/");
}

function refusalMessage(response: FetchResponse, { repo, branch, path }: RepoSource): string {
  if (response.status === 403 && !isRateLimited(response)) {
    return `The token can't read ${repo}. Give it read access to this repo's contents.`;
  }
  if (response.status === 404) {
    return `Couldn't find ${path} on ${branch} in ${repo}. Check the names and that the token can read the repo. A repo with both an iPhone and an Android app has designlane/tokens.ios.json and designlane/tokens.android.json instead. If CI hasn't written the file yet, it will on the next push.`;
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
