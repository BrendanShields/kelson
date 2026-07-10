import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvidenceLink, Lockfile, ProposalDiff } from "@kelson/schemas";
import { LedgerEntry } from "@kelson/schemas";

import type { CycleDraft } from "./loop.ts";

// The compiler's draft IS a cycle draft — expected_effect (|FPAR delta|) is
// the LOOP-10 rank key emitProposalCycle clips on.
export type ProposalDraft = CycleDraft;

// LOOP-1 postmortem compiler v1: mines pack-attributed eval evidence (the
// ledger + its verdict/run rows) into lockfile-level proposals. Only
// conclusive verdicts propose — helps for a disabled pack (enable it),
// hurts for an enabled pack (disable it). Underpowered/no_effect never do.
export const compileProposals = (
  db: Database,
  args: { ledgerDir: string; lockfile: Lockfile },
): ProposalDraft[] => {
  if (!existsSync(args.ledgerDir)) return [];
  const drafts: ProposalDraft[] = [];
  for (const pack of readdirSync(args.ledgerDir, { withFileTypes: true })) {
    if (!pack.isDirectory()) continue;
    for (const file of readdirSync(join(args.ledgerDir, pack.name))) {
      if (!file.endsWith(".json")) continue;
      const entry = LedgerEntry.parse(
        JSON.parse(readFileSync(join(args.ledgerDir, pack.name, file), "utf8")),
      );
      const lockEntry = args.lockfile.entries.find(
        (e) => e.name === entry.pack,
      );
      if (!lockEntry) continue;
      const run = db
        .query("SELECT id FROM eval_run WHERE manifest_hash = ?")
        .get(entry.run_manifest_hash) as { id: string } | null;
      if (!run) continue;
      const verdictRow = db
        .query("SELECT id FROM verdict WHERE run_id = ?")
        .get(run.id) as { id: string } | null;
      if (!verdictRow) continue;
      const evidence: EvidenceLink[] = [
        `ev:db/verdict/${verdictRow.id}`,
        `ev:db/eval_run/${run.id}`,
      ];
      if (entry.verdict === "hurts" && lockEntry.enabled)
        drafts.push({
          targetPack: entry.pack,
          diff: {
            kind: "lockfile",
            ops: [{ op: "disable", pack: entry.pack }],
          },
          evidence,
          rationale: `ablation ${entry.suite} verdict "hurts": fpar ${entry.fpar_delta.mean.toFixed(3)} [${entry.fpar_delta.ci95.join(", ")}], cost ${entry.cost_delta_pct.mean.toFixed(1)}% [${entry.cost_delta_pct.ci95.map((x) => x.toFixed(1)).join(", ")}], n=${entry.n} — pack is enabled and measurably harmful`,
          expected_effect: Math.abs(entry.fpar_delta.mean),
        });
      if (entry.verdict === "helps" && !lockEntry.enabled)
        drafts.push({
          targetPack: entry.pack,
          diff: { kind: "lockfile", ops: [{ op: "enable", pack: entry.pack }] },
          evidence,
          rationale: `ablation ${entry.suite} verdict "helps": fpar ${entry.fpar_delta.mean.toFixed(3)}, cost ${entry.cost_delta_pct.mean.toFixed(1)}%, n=${entry.n} — pack is disabled and measurably helpful`,
          expected_effect: Math.abs(entry.fpar_delta.mean),
        });
    }
  }
  return drafts;
};
