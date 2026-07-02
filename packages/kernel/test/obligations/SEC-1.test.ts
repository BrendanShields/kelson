import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SandboxProfile } from "@kelson/schemas";
import {
  CLAUDE_AUTH_PASSTHROUGH,
  claudeSessionEnv,
} from "../../src/evaltask.ts";
import { containerRuntime, createWorkspace } from "../../src/sandbox.ts";
import { storeSnapshot } from "../../src/snapshots.ts";
import { makeRepo, tmpDir, WORKTREE } from "../eval-helpers.ts";

const store = tmpDir();
const sourceRepo = makeRepo({ "README.md": "live\n" });
const snapshot = storeSnapshot(sourceRepo, store);

const CONTAINER: SandboxProfile = {
  isolation: "container",
  network: { policy: "deny", allowlist: [] },
};
const docker = containerRuntime() !== null;

describe("SEC-1: eval work runs only in isolated workspaces", () => {
  it("worktree: temp-HOME isolation — $HOME is not the operator home and writes stay inside", () => {
    const ws = createWorkspace(WORKTREE, { snapshot, storeDir: store });
    try {
      const home = ws.exec("echo $HOME").stdout.trim();
      expect(home).toBe(ws.home);
      expect(home).not.toBe(homedir());
      ws.exec('touch "$HOME/escape-marker"');
      expect(existsSync(join(ws.home, "escape-marker"))).toBe(true);
      expect(existsSync(join(homedir(), "escape-marker"))).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  it("claude-executor passthrough is limited to exactly the auth set (SEC-1 stated exception)", () => {
    const env = claudeSessionEnv();
    const allowed = new Set<string>([...CLAUDE_AUTH_PASSTHROUGH]);
    for (const key of Object.keys(env)) expect(allowed.has(key)).toBe(true);
    expect("PATH" in env).toBe(false);
    expect("CLAUDE_CONFIG_DIR" in env).toBe(false);
  });

  it("worktree: detached clone — ref writes cannot reach the source repo", () => {
    const ws = createWorkspace(WORKTREE, { snapshot, storeDir: store });
    try {
      const origin = ws.exec("git remote get-url origin").stdout.trim();
      expect(origin).not.toBe(sourceRepo);
      expect(origin).toContain(".bundle");
      const push = ws.exec("git push origin HEAD:refs/heads/escape 2>&1");
      expect(push.exitCode).not.toBe(0);
      const refs = spawnSync("git", ["show-ref"], {
        cwd: sourceRepo,
      }).stdout.toString();
      expect(refs).not.toContain("escape");
    } finally {
      ws.cleanup();
    }
  });

  it.skipIf(!docker)(
    "container: reads outside the workspace, credential paths, and live-repo writes all fail and are recorded",
    () => {
      const ws = createWorkspace(CONTAINER, { snapshot, storeDir: store });
      try {
        // The host store dir, operator HOME, and source repo are not mounted.
        expect(ws.exec(`cat ${store}/anything`).exitCode).not.toBe(0);
        expect(ws.exec(`cat ${homedir()}/.aws/credentials`).exitCode).not.toBe(
          0,
        );
        const write = ws.exec(`touch ${sourceRepo}/escaped.txt`);
        expect(write.exitCode).not.toBe(0);
        expect(existsSync(join(sourceRepo, "escaped.txt"))).toBe(false);
      } finally {
        ws.cleanup();
      }
    },
    180_000,
  );
});
