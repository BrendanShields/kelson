import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hashContent } from "./artifacts.ts";

export const DEFAULT_SNAPSHOT_DIR = join(homedir(), ".kelson", "snapshots");

const git = (args: string[], cwd: string): void => {
  const res = spawnSync("git", args, { cwd, stdio: "pipe" });
  if (res.status !== 0)
    throw new Error(
      `git ${args[0]} failed: ${res.stderr?.toString() ?? "unknown"}`,
    );
};

// EVP §4: content-addressed git bundle (all refs). Working-tree diff capture
// arrives with Phase 4 replay — benchmark snapshots are committed states.
export const storeSnapshot = (
  sourceRepoDir: string,
  storeDir = DEFAULT_SNAPSHOT_DIR,
): string => {
  mkdirSync(storeDir, { recursive: true });
  const tmp = join(
    tmpdir(),
    `kelson-bundle-${process.pid}-${Date.now()}.bundle`,
  );
  try {
    git(["bundle", "create", tmp, "--all"], sourceRepoDir);
    const hash = hashContent(readFileSync(tmp));
    copyFileSync(tmp, join(storeDir, `${hash.replace("sha256:", "")}.bundle`));
    return hash;
  } finally {
    // SES-9: a cleanup failure must not fail an otherwise successful snapshot.
    try {
      rmSync(tmp, { force: true });
    } catch {}
  }
};

// EVP §4 validity rule 1: the bundle must restore bit-identically — verified
// by re-hashing the stored bundle against its address before every restore.
export const restoreSnapshot = (
  hash: string,
  destDir: string,
  storeDir = DEFAULT_SNAPSHOT_DIR,
): void => {
  // git clone runs from tmpdir — a relative store path must resolve first.
  const path = resolve(storeDir, `${hash.replace("sha256:", "")}.bundle`);
  if (!existsSync(path)) throw new Error(`snapshot not found: ${hash}`);
  const actual = hashContent(readFileSync(path));
  if (actual !== hash)
    throw new Error(`snapshot corrupt: stored ${actual}, addressed ${hash}`);
  // A detached clone per SEC-1 — refs/objects are copied from the bundle,
  // never shared with any live repository.
  git(["clone", "--quiet", path, destDir], tmpdir());
};
