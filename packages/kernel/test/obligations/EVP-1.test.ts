import { describe, expect, it } from "bun:test";
import { commandExecutor, runTask } from "../../src/evaltask.ts";
import { createWorkspace } from "../../src/sandbox.ts";
import {
  baseTask,
  CMD,
  makeSnapshot,
  tmpDir,
  WORKTREE,
} from "../eval-helpers.ts";

const store = tmpDir();
const plainSnapshot = makeSnapshot({ "README.md": "fixture\n" }, store);
const kelspecGood = makeSnapshot(
  {
    "docs/kelspec/w.spec.md": `\`\`\`kelspec
{"kind": "component", "id": "widget", "tier": "T0", "authority": "authored", "events": ["poked"]}
\`\`\`
`,
  },
  store,
);
const kelspecVague = makeSnapshot(
  {
    "docs/kelspec/w.spec.md": `\`\`\`kelspec
{"kind": "component", "id": "widget", "tier": "T0", "authority": "authored", "events": ["poked"]}
\`\`\`
\`\`\`kelspec
{"kind": "clause", "id": "WID-1", "ears": "ubiquitous", "text": "should be fast"}
\`\`\`
`,
  },
  store,
);

const run = (over: Parameters<typeof baseTask>[0]) => {
  const task = baseTask(over);
  const ws = createWorkspace(WORKTREE, {
    snapshot: task.snapshot,
    storeDir: store,
  });
  try {
    return runTask(task, ws, commandExecutor, {});
  } finally {
    ws.cleanup();
  }
};

describe("EVP-1: each check kind, each failure class, budget breach, and timeout are exercised and recorded", () => {
  it("command check: pass and fail classes", () => {
    expect(run({ id: "t", snapshot: plainSnapshot }).fpar_pass).toBe(true);
    const failed = run({
      id: "t",
      snapshot: plainSnapshot,
      checks: [{ kind: "command", run: "exit 3" }],
    });
    expect(failed.fpar_pass).toBe(false);
    expect(failed.check_results.some((c) => c.detail?.includes("exit 3"))).toBe(
      true,
    );
  });

  it("artifact_exists check: present and missing", () => {
    expect(
      run({
        id: "t",
        snapshot: plainSnapshot,
        checks: [{ kind: "artifact_exists", path: "README.md" }],
      }).fpar_pass,
    ).toBe(true);
    const missing = run({
      id: "t",
      snapshot: plainSnapshot,
      checks: [{ kind: "artifact_exists", path: "nope.md" }],
    });
    expect(missing.fpar_pass).toBe(false);
    expect(missing.check_results[0]?.detail).toContain("nope.md");
  });

  it("obligations check: compiling kelspec passes, vague kelspec fails", () => {
    expect(
      run({
        id: "t",
        snapshot: kelspecGood,
        checks: [{ kind: "obligations" }],
      }).fpar_pass,
    ).toBe(true);
    const vague = run({
      id: "t",
      snapshot: kelspecVague,
      checks: [{ kind: "obligations" }],
    });
    expect(vague.fpar_pass).toBe(false);
    expect(vague.check_results[0]?.detail).toContain("WID-1");
  });

  it("session failure is a task failure with the exit recorded", () => {
    const out = run({
      id: "t",
      snapshot: plainSnapshot,
      session_command: "exit 7",
    });
    expect(out.fpar_pass).toBe(false);
    expect(out.check_results[0]?.detail).toContain("exited 7");
  });

  it("budget breach fails the task even when all checks pass (cost discipline is correctness)", () => {
    const out = run({
      id: "t",
      snapshot: plainSnapshot,
      session_command: CMD.cost("999"),
      budget_ceiling_musd: 500,
    });
    expect(out.cost_micro_usd).toBe(999);
    expect(out.fpar_pass).toBe(false);
    expect(
      out.check_results.some((c) => c.detail?.includes("budget breach")),
    ).toBe(true);
  });

  it("timeout fails the task", () => {
    const out = run({
      id: "t",
      snapshot: plainSnapshot,
      session_command: "sleep 5",
      timeout_minutes: 0.01,
    });
    expect(out.fpar_pass).toBe(false);
    expect(out.check_results.some((c) => c.detail?.includes("timed out"))).toBe(
      true,
    );
  });
});
