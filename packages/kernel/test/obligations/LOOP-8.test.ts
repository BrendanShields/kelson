import { describe, expect, it } from "bun:test";
import { EvidenceLink } from "@kelson/schemas";
import { enterGate, resolveEvidence } from "../../src/loop.ts";
import { openDb } from "../../src/storage.ts";
import {
  draftProposal,
  loopCtx,
  seedVerdictEvidence,
} from "../loop-helpers.ts";

describe("LOOP-8: two link grammars, stated-location-only resolution, checked at creation and pre-gate, atomic evented rejection", () => {
  it("grammar: valid forms parse, everything else is a schema error", () => {
    expect(
      EvidenceLink.safeParse("ev:db/verdict/01ARZ3NDEKTSV4RRFFQ69G5FAV")
        .success,
    ).toBe(true);
    expect(
      EvidenceLink.safeParse("ev:file/.kelson/findings.json#F-042").success,
    ).toBe(true);
    for (const bad of [
      "verdict/01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "ev:db/unknown_table/01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "ev:db/verdict/not-a-ulid",
      "ev:file/.kelson/secrets.json#F-001",
      "ev:file/.kelson/findings.json#f-042",
      "",
    ])
      expect(EvidenceLink.safeParse(bad).success).toBe(false);
  });

  it("resolution: stated table only, wrong table is a wrong claim, dangling rejects atomically with per-link results", () => {
    const db = openDb(":memory:");
    const ctx = loopCtx();
    const [verdictLink, runLink] = seedVerdictEvidence(db);
    const good = resolveEvidence(
      db,
      [verdictLink as never, runLink as never],
      ctx.repoRoot,
    );
    expect(good.ok).toBe(true);

    // Same ULID claimed in the wrong table: no cross-table fallback.
    const ulid = (verdictLink as string).split("/").pop() as string;
    const wrongTable = resolveEvidence(
      db,
      [`ev:db/drift_event/${ulid}`] as never,
      ctx.repoRoot,
    );
    expect(wrongTable.ok).toBe(false);

    const mixed = resolveEvidence(
      db,
      [verdictLink, "ev:db/verdict/01ARZ3NDEKTSV4RRFFQ69G5FZZ"] as never,
      ctx.repoRoot,
    );
    expect(mixed.ok).toBe(false);
    expect(mixed.results).toEqual([
      { link: verdictLink as string, resolved: true },
      { link: "ev:db/verdict/01ARZ3NDEKTSV4RRFFQ69G5FZZ", resolved: false },
    ]);
    db.close();
  });

  it("file links resolve against the findings log by exact id", () => {
    const db = openDb(":memory:");
    const ctx = loopCtx();
    expect(
      resolveEvidence(
        db,
        ["ev:file/.kelson/findings.json#F-042"] as never,
        ctx.repoRoot,
      ).ok,
    ).toBe(true);
    expect(
      resolveEvidence(
        db,
        ["ev:file/.kelson/findings.json#F-999"] as never,
        ctx.repoRoot,
      ).ok,
    ).toBe(false);
    db.close();
  });

  it("pre-gate re-check rejects a proposal whose file evidence vanished after creation", () => {
    const db = openDb(":memory:");
    const ctx = loopCtx();
    const proposal = draftProposal(db, ctx, {
      evidence: ["ev:file/.kelson/findings.json#F-042"] as never,
    });
    // The file changes between creation and gate.
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    writeFileSync(
      `${ctx.repoRoot}/.kelson/findings.json`,
      JSON.stringify({ findings: [] }),
    );
    const gated = enterGate(db, proposal.id, ctx.repoRoot);
    expect(gated.state).toBe("rejected");
    db.close();
  });
});
