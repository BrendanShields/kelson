import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { Lockfile } from "@kelson/schemas";
import {
  applyProposal,
  enterGate,
  readChangelog,
  revertProposal,
  transition,
} from "../../src/loop.ts";
import { hashLockfile } from "../../src/packs.ts";
import { openDb } from "../../src/storage.ts";
import {
  DISABLE_PONYTAIL,
  draftProposal,
  loopCtx,
  seedVerdictEvidence,
} from "../loop-helpers.ts";

const currentHash = (path: string) =>
  hashLockfile(JSON.parse(readFileSync(path, "utf8")) as Lockfile);

const approve = (
  db: ReturnType<typeof openDb>,
  ctx: ReturnType<typeof loopCtx>,
  over = {},
) => {
  const proposal = draftProposal(db, ctx, over);
  enterGate(db, proposal.id, ctx.repoRoot);
  transition(db, proposal.id, "approved", {
    actor: "human",
    reason: "test approval",
  });
  return proposal;
};

describe("LOOP-2: apply only after the gate; changelog entry reverts in one command; revert is a new child preserving later diffs", () => {
  it("single-diff apply then revert restores the exact prior lockfile hash", () => {
    const db = openDb(":memory:");
    const ctx = loopCtx();
    const before = currentHash(ctx.lockfilePath);
    const proposal = approve(db, ctx);
    const { lockfileAfter } = applyProposal(db, proposal.id, ctx);
    expect(lockfileAfter).not.toBe(before);
    transition(db, proposal.id, "monitoring", { actor: "auto" });
    revertProposal(db, proposal.id, ctx, { actor: "human", reason: "test" });
    expect(currentHash(ctx.lockfilePath)).toBe(before);
    const log = readChangelog(ctx.changelogPath);
    expect(log.map((e) => e.action)).toEqual(["apply", "revert"]);
    expect(log[0]?.lockfile_before).toBe(before);
    db.close();
  });

  it("interleaved: apply A, apply B, revert A leaves B active and produces a new hash, not B's parent", () => {
    const db = openDb(":memory:");
    const ctx = loopCtx();
    const a = approve(db, ctx);
    applyProposal(db, a.id, ctx);
    transition(db, a.id, "monitoring", { actor: "auto" });
    const hashAfterA = currentHash(ctx.lockfilePath);
    const b = approve(db, ctx, {
      targetPack: "routing-default",
      diff: {
        kind: "lockfile" as const,
        ops: [{ op: "disable" as const, pack: "routing-default" }],
      },
      evidence: seedVerdictEvidence(db),
    });
    applyProposal(db, b.id, ctx);
    const hashAfterB = currentHash(ctx.lockfilePath);

    revertProposal(db, a.id, ctx, { actor: "auto", reason: "regression" });
    const final = JSON.parse(
      readFileSync(ctx.lockfilePath, "utf8"),
    ) as Lockfile;
    const finalHash = hashLockfile(final);
    // B's diff survives; A's is exactly removed.
    expect(
      final.entries.find((e) => e.name === "routing-default")?.enabled,
    ).toBe(false);
    expect(final.entries.find((e) => e.name === "ponytail")?.enabled).toBe(
      true,
    );
    // New child, not a rewind to any earlier hash.
    expect(finalHash).not.toBe(hashAfterB);
    expect(finalHash).not.toBe(hashAfterA);
    expect(readChangelog(ctx.changelogPath).map((e) => e.action)).toEqual([
      "apply",
      "apply",
      "revert",
    ]);
    db.close();
  });

  it("a loop-originated approval without a passing gate basis or human override is refused (LOOP-2)", () => {
    const db = openDb(":memory:");
    const ctx = loopCtx();
    const proposal = draftProposal(db, ctx);
    enterGate(db, proposal.id, ctx.repoRoot);
    expect(() =>
      transition(db, proposal.id, "approved", { actor: "loop" }),
    ).toThrow(/LOOP-2/);
    expect(() =>
      transition(db, proposal.id, "approved", { actor: "auto" }),
    ).toThrow(/LOOP-2/);
    // A passing basis approves without a human.
    const ok = transition(db, proposal.id, "approved", {
      actor: "auto",
      gate_basis: { auto_approvable: true },
    });
    expect(ok.state).toBe("approved");
    db.close();
  });

  it("apply refuses any state but approved (I1 structural)", () => {
    const db = openDb(":memory:");
    const ctx = loopCtx();
    const proposal = draftProposal(db, ctx);
    expect(() => applyProposal(db, proposal.id, ctx)).toThrow(/I1/);
    db.close();
  });
});
