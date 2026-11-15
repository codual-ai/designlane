/** A connected repo's files as one commit has them, read through GitHub's Git API: every file an edit is planned
 * against comes from the same commit, which the pull request then builds on. */

import { z } from "zod";
import { TOO_LARGE } from "../../src/edit/read-source.js";
import { MAX_FILE_BYTES } from "../../src/scan/file-limits.js";
import { isRepoPath } from "./connection.js";
import { encodedPath, GitHubRefusal, type RepoApi } from "./github.js";

const Sha = z.string().regex(/^[0-9a-f]{40}$/);
const Ref = z.object({ object: z.object({ sha: Sha }) });
const Commit = z.object({ tree: z.object({ sha: Sha }) });
const TreeEntry = z.object({
  path: z.string(),
  mode: z.string(),
  type: z.string(),
  sha: Sha,
  size: z.number().optional(),
});
const Tree = z.object({ tree: z.array(TreeEntry), truncated: z.boolean() });
type TreeEntry = z.infer<typeof TreeEntry>;

/** The modes of a file Git holds as text: a plain file and an executable one. */
const FILE_MODES = new Set(["100644", "100755"]);
/** What a decoder puts in place of bytes that aren't UTF-8. */
const REPLACEMENT = "�";

type FileRead = string | { unreadable: string } | undefined;

export interface Snapshot {
  /** The commit read, the head of the connected branch when the snapshot was taken. */
  commit: string;
  tree: string;
  /** The text of the file at `path` in the repo, undefined when there's none, or why it can't be read. */
  read(path: string): Promise<FileRead>;
  /** The file's Git mode, which a commit changing it keeps. */
  mode(path: string): Promise<string | undefined>;
}

/** The connected branch's files as its head commit has them now. */
export async function snapshotOf(api: RepoApi, branch: string): Promise<Snapshot> {
  const ref = await api.json(Ref, `git/ref/heads/${encodedPath(branch)}`).catch((error: unknown) => {
    if (error instanceof GitHubRefusal && error.status === 404) {
      throw new Error(
        `Couldn't find the branch ${branch} in ${api.repo}. Check it still exists, then press Check again.`,
      );
    }
    throw error;
  });
  const commit = ref.object.sha;
  const tree = (await api.json(Commit, `git/commits/${commit}`)).tree.sha;
  const folders = new Map<string, Promise<z.infer<typeof Tree>>>();
  const listing = (sha: string) => {
    let found = folders.get(sha);
    if (!found) {
      found = api.json(Tree, `git/trees/${sha}`);
      folders.set(sha, found);
    }
    return found;
  };

  /** The file's entry, undefined when the commit has none, or why it can't be told. */
  async function entryAt(path: string): Promise<TreeEntry | { unreadable: string } | undefined> {
    if (!isRepoPath(path)) return { unreadable: "its path steps outside the repo" };
    const parts = path.split("/");
    let folder = tree;
    for (const [i, part] of parts.entries()) {
      const { tree: entries, truncated } = await listing(folder);
      const entry = entries.find((candidate) => candidate.path === part);
      if (!entry) return truncated ? { unreadable: "GitHub listed only part of its folder" } : undefined;
      if (i === parts.length - 1) return entry;
      if (entry.type !== "tree") return undefined;
      folder = entry.sha;
    }
    return undefined;
  }

  return {
    commit,
    tree,
    async read(path) {
      const entry = await entryAt(path);
      if (!entry || "unreadable" in entry) return entry;
      if (entry.type !== "blob" || !FILE_MODES.has(entry.mode))
        return { unreadable: "it isn't a plain file" };
      if ((entry.size ?? 0) > MAX_FILE_BYTES) return TOO_LARGE;
      const text = await api.raw(`git/blobs/${entry.sha}`);
      // A byte order mark or bytes that aren't UTF-8 would be lost on the way back, and move every offset after them.
      if (text.includes(REPLACEMENT) || utf8Length(text) !== entry.size) {
        return { unreadable: "it isn't plain UTF-8 text" };
      }
      return text;
    },
    async mode(path) {
      const entry = await entryAt(path);
      return entry && "mode" in entry ? entry.mode : undefined;
    },
  };
}

/** How many bytes `text` takes as UTF-8. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}
