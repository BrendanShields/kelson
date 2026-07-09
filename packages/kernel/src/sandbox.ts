import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxProfile } from "@kelson/schemas";
import { restoreSnapshot } from "./snapshots.ts";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface Workspace {
  dir: string;
  home: string;
  profile: SandboxProfile;
  exec: (
    command: string,
    opts?: { env?: Record<string, string>; timeoutMs?: number },
  ) => ExecResult;
  // EVP-12: eval session commands run through the async variant so cells can
  // genuinely overlap; `exec` stays synchronous because the agent ToolContext
  // contract is sync (unify when the tool layer goes async).
  execAsync: (
    command: string,
    opts?: { env?: Record<string, string>; timeoutMs?: number },
  ) => Promise<ExecResult>;
  cleanup: () => void;
}

export class SandboxRefusal extends Error {}

export const containerRuntime = (): string | null =>
  Bun.which("docker") ?? Bun.which("podman");

const CONTAINER_IMAGE = "oven/bun:1";

// SEC-1: worktree = detached clone + temp HOME (convenience tier); container =
// no mounts beyond the workspace, network denied (SEC-2). EVP-2: container
// required but unavailable → refuse, never degrade to worktree.
export const createWorkspace = (
  profile: SandboxProfile,
  opts: { snapshot: string; storeDir?: string; runtime?: string | null },
): Workspace => {
  if (profile.isolation === "container") {
    if (
      (opts.runtime === undefined ? containerRuntime() : opts.runtime) === null
    )
      throw new SandboxRefusal(
        "container profile required but no docker/podman on PATH — refusing (EVP-2); not degrading to worktree",
      );
    if (
      profile.network.policy === "deny" &&
      profile.network.allowlist.length > 0
    )
      throw new SandboxRefusal(
        "network allowlists are not implemented yet — only full deny is supported (SEC-2 v1)",
      );
  }
  const root = mkdtempSync(join(tmpdir(), "kelson-ws-"));
  const dir = join(root, "workspace");
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  restoreSnapshot(opts.snapshot, dir, opts.storeDir);

  // One command plan for both exec variants — the docker argv must never
  // drift between them.
  const spawnPlan = (
    command: string,
    env: Record<string, string> | undefined,
  ): { cmd: string[]; cwd?: string; env?: Record<string, string> } => {
    if (profile.isolation === "container") {
      const runtime = containerRuntime() as string;
      const network = profile.network.policy === "deny" ? "none" : "bridge";
      const envArgs = Object.entries(env ?? {}).flatMap(([k, v]) => [
        "-e",
        `${k}=${v}`,
      ]);
      return {
        cmd: [
          runtime,
          "run",
          "--rm",
          `--network=${network}`,
          "-v",
          `${dir}:/workspace`,
          "-w",
          "/workspace",
          ...envArgs,
          CONTAINER_IMAGE,
          "sh",
          "-c",
          command,
        ],
      };
    }
    return {
      cmd: ["sh", "-c", command],
      cwd: dir,
      env: { HOME: home, PATH: process.env.PATH ?? "", ...env },
    };
  };

  const exec: Workspace["exec"] = (command, execOpts = {}) => {
    const timeoutMs = execOpts.timeoutMs ?? 300_000;
    const plan = spawnPlan(command, execOpts.env);
    const res = spawnSync(plan.cmd[0] as string, plan.cmd.slice(1), {
      stdio: "pipe",
      timeout: timeoutMs,
      ...(plan.cwd !== undefined ? { cwd: plan.cwd } : {}),
      ...(plan.env !== undefined ? { env: plan.env } : {}),
    });
    return {
      exitCode: res.status ?? -1,
      stdout: res.stdout?.toString() ?? "",
      stderr: res.stderr?.toString() ?? "",
      timedOut: res.signal === "SIGTERM" && res.status === null,
    };
  };

  const execAsync: Workspace["execAsync"] = async (command, execOpts = {}) => {
    const timeoutMs = execOpts.timeoutMs ?? 300_000;
    const plan = spawnPlan(command, execOpts.env);
    const proc = Bun.spawn(plan.cmd, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      timeout: timeoutMs,
      ...(plan.cwd !== undefined ? { cwd: plan.cwd } : {}),
      ...(plan.env !== undefined ? { env: plan.env } : {}),
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    return {
      exitCode: proc.exitCode ?? -1,
      stdout,
      stderr,
      timedOut: proc.signalCode === "SIGTERM" && proc.exitCode === null,
    };
  };

  return {
    dir,
    home,
    profile,
    exec,
    execAsync,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};
