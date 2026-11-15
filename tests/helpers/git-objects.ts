/** Git's object store held in memory: blobs, trees and commits hashed exactly as Git hashes them, so their SHAs are the
 * ones `git hash-object` gives. */

import { createHash } from "node:crypto";

export const FILE_MODE = "100644";
/** How GitHub's API writes a tree's mode; Git's own tree objects drop the leading zero. */
const TREE_MODE = "040000";

export interface TreeEntry {
  name: string;
  mode: string;
  type: "blob" | "tree";
  sha: string;
}

export interface Commit {
  tree: string;
  parents: string[];
  message: string;
  /** Seconds since the epoch, as Git records a commit's time. */
  time: number;
}

/** A file to put in a tree, by its path from the tree's root. */
export interface FileEntry {
  path: string;
  mode: string;
  sha: string;
}

const AUTHOR = "Designmap Test <test@example.com>";
const LEADING_ZERO = /^0/;

export function gitObjects() {
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, TreeEntry[]>();
  const commits = new Map<string, Commit>();

  const hash = (type: string, body: Buffer) =>
    createHash("sha1")
      .update(Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]))
      .digest("hex");

  function writeBlob(content: Buffer): string {
    const sha = hash("blob", content);
    blobs.set(sha, content);
    return sha;
  }

  function writeTree(entries: TreeEntry[]): string {
    // Git orders a tree's entries by name, a folder's as if it ended in a slash.
    const sortKey = (entry: TreeEntry) => (entry.type === "tree" ? `${entry.name}/` : entry.name);
    const sorted = [...entries].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
    const body = Buffer.concat(
      sorted.flatMap((entry) => [
        Buffer.from(`${entry.mode.replace(LEADING_ZERO, "")} ${entry.name}\0`),
        Buffer.from(entry.sha, "hex"),
      ]),
    );
    const sha = hash("tree", body);
    trees.set(sha, sorted);
    return sha;
  }

  function writeCommit(commit: Commit): string {
    const signature = `${AUTHOR} ${commit.time} +0000`;
    const lines = [
      `tree ${commit.tree}`,
      ...commit.parents.map((parent) => `parent ${parent}`),
      `author ${signature}`,
      `committer ${signature}`,
      "",
      commit.message,
    ];
    const sha = hash("commit", Buffer.from(lines.join("\n")));
    commits.set(sha, commit);
    return sha;
  }

  /** A tree from `base` (none for an empty one) with `files` put in at their paths, making folders as needed. */
  function treeWith(base: string | undefined, files: FileEntry[]): string {
    const entries = new Map((base ? (trees.get(base) ?? []) : []).map((entry) => [entry.name, entry]));
    const inFolders = new Map<string, FileEntry[]>();
    for (const file of files) {
      const slash = file.path.indexOf("/");
      if (slash === -1) {
        entries.set(file.path, { name: file.path, mode: file.mode, type: "blob", sha: file.sha });
        continue;
      }
      const folder = file.path.slice(0, slash);
      inFolders.set(folder, [
        ...(inFolders.get(folder) ?? []),
        { ...file, path: file.path.slice(slash + 1) },
      ]);
    }
    for (const [folder, inside] of inFolders) {
      const existing = entries.get(folder);
      const sha = treeWith(existing?.type === "tree" ? existing.sha : undefined, inside);
      entries.set(folder, { name: folder, mode: TREE_MODE, type: "tree", sha });
    }
    return writeTree([...entries.values()]);
  }

  /** Every file in the tree `sha`, by path, with its text. */
  function filesIn(sha: string, prefix = ""): Map<string, string> {
    const files = new Map<string, string>();
    for (const entry of trees.get(sha) ?? []) {
      const path = prefix + entry.name;
      if (entry.type === "tree")
        for (const [inner, text] of filesIn(entry.sha, `${path}/`)) files.set(inner, text);
      else files.set(path, blobs.get(entry.sha)?.toString("utf8") ?? "");
    }
    return files;
  }

  return { blobs, trees, commits, writeBlob, writeTree, writeCommit, treeWith, filesIn };
}

export type GitObjects = ReturnType<typeof gitObjects>;
