/** Where the plugin reads tokens.json from: a GitHub repo, kept with the Figma file (an iPhone app's file and an
 * Android app's file each read their own path), and the token that reads it, kept on this computer only. */

import { z } from "zod";
import { syncedCollection } from "./design-file.js";
import { RepoSource } from "./messages.js";

/** On the file, readable by this plugin only: the repo, branch and path it syncs from. */
const SOURCE_KEY = "connection";
/** On this computer: the token for a repo. */
const tokenKey = (repo: string) => `token:${repo}`;
/** On this computer: the token that can open pull requests on a repo, kept apart so syncing never needs more than
 * reading. */
const writeTokenKey = (repo: string) => `writeToken:${repo}`;
/** On this computer, before connections were kept per file: one repo, branch, path and token. */
const LEGACY_KEY = "connection";
/** `owner/name`: letters, digits, `.`, `_` and `-` on each side of the slash. */
const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;

export const Connection = RepoSource.extend({ token: z.string() });
export type Connection = z.infer<typeof Connection>;

/** `connection`, once each setting is one GitHub can read; otherwise what to fix, in words a designer can act on. */
export function checkConnection(connection: Connection): Connection {
  const { repo, branch, path, token } = connection;
  if (!isRepoName(repo)) {
    throw new Error(`"${repo}" isn't a repo name. Write it as owner/name, for example octocat/my-app.`);
  }
  if (branch === "") throw new Error("Enter the branch to read, for example main.");
  if (!isRepoPath(path)) {
    throw new Error(`"${path}" isn't a file's path in the repo. Write it like designmap/tokens.json.`);
  }
  if (token === "") throw new Error("Paste a GitHub token that can read this repo.");
  return connection;
}

/** `.` or `..`, which would step outside the repo's files. */
const isDotPart = (part: string) => part === "." || part === "..";

/** Whether `repo` is `owner/name`, with neither part one that steps elsewhere in a URL. */
export const isRepoName = (repo: string) => REPO_NAME.test(repo) && !repo.split("/").some(isDotPart);

/** Whether `path` names a file inside the repo: no empty, `.` or `..` part, which would step outside it or, in a URL,
 * reach another of GitHub's endpoints. */
export const isRepoPath = (path: string) => path.split("/").every((part) => part !== "" && !isDotPart(part));

/** The repo, branch and path this file syncs from, whether or not this computer has a token for it. */
export function fileSource(): RepoSource | undefined {
  const written = figma.root.getPluginData(SOURCE_KEY);
  return written ? RepoSource.safeParse(parsedJson(written)).data : undefined;
}

/** The connection this file syncs from, with this computer's token for its repo; undefined before one is made here. A
 * file synced before connections were kept per file takes the one connection kept then, and keeps it as its own. */
export async function savedConnection(): Promise<Connection | undefined> {
  const legacy = Connection.safeParse(await figma.clientStorage.getAsync(LEGACY_KEY)).data;
  const source = fileSource();
  if (!source) {
    if (!legacy || !(await syncedCollection())) return undefined;
    await saveConnection(legacy);
    return legacy;
  }
  const token = z.string().safeParse(await figma.clientStorage.getAsync(tokenKey(source.repo))).data;
  if (token) return { ...source, token };
  return legacy?.repo === source.repo ? { ...source, token: legacy.token } : undefined;
}

/** `text` read as JSON, or undefined when it isn't. */
export const parsedJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export async function saveConnection({ token, ...source }: Connection): Promise<void> {
  figma.root.setPluginData(SOURCE_KEY, JSON.stringify(source));
  await figma.clientStorage.setAsync(tokenKey(source.repo), token);
}

/** Forgets this file's connection. The token stays on this computer: another file may read the same repo (an iPhone
 * app's file and an Android app's). */
export async function forgetConnection(): Promise<void> {
  figma.root.setPluginData(SOURCE_KEY, "");
}

/** This computer's token that can open pull requests on `repo`, if one was given. */
export async function savedWriteToken(repo: string): Promise<string | undefined> {
  return z.string().safeParse(await figma.clientStorage.getAsync(writeTokenKey(repo))).data;
}

export async function saveWriteToken(repo: string, token: string): Promise<void> {
  await figma.clientStorage.setAsync(writeTokenKey(repo), token);
}

/** Forgets a token GitHub wouldn't let open a pull request, so the next try asks for one that can. */
export async function forgetWriteToken(repo: string): Promise<void> {
  await figma.clientStorage.deleteAsync(writeTokenKey(repo));
}
