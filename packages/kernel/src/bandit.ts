import type { Database } from "bun:sqlite";
import type { AgentRegistryEntry, FeatureVector } from "@kelson/schemas";
import { hashContent } from "./artifacts.ts";
import { canExplore } from "./routing.ts";
import { ulid as newUlid } from "./ulid.ts";

// RPOL §4: epsilon-greedy, exploration only when ALL hold — T0 (RTR-3 guard),
// a candidate exactly one cost class below the exploit arm, cheaper by
// construction. Randomness derives from the step-event ULID: reproducible
// from telemetry, no wall-clock RNG.
export const BANDIT_DEFAULTS = { epsilon: 0.05, alpha: 0.1, w0: 0.5 } as const;

export const explorationDraw = (stepEventUlid: string): number =>
  Number.parseInt(hashContent(stepEventUlid).slice(7, 15), 16) / 0xffffffff;

export const exploreDecision = (
  vector: FeatureVector,
  exploit: AgentRegistryEntry,
  registry: AgentRegistryEntry[],
  stepEventUlid: string,
  epsilon: number = BANDIT_DEFAULTS.epsilon,
): AgentRegistryEntry | null => {
  if (!canExplore(vector, exploit, registry)) return null;
  if (explorationDraw(stepEventUlid) >= epsilon) return null;
  const candidates = registry
    .filter((e) => e.cost_class === exploit.cost_class - 1)
    .sort((a, b) => a.id.localeCompare(b.id));
  return candidates[0] ?? null;
};

// RTR-5: the EMA update writes nothing but routing_weight.weight (the
// updated_at timestamp rides along; the key columns are trigger-pinned).
// Outcomes append to routing_outcome so the promotion trigger can count
// without widening the bandit's mutable surface.
export const recordOutcome = (
  db: Database,
  policyVersion: string,
  arm: string,
  outcome: 0 | 1,
  alpha: number = BANDIT_DEFAULTS.alpha,
): number => {
  db.query(
    "INSERT INTO routing_outcome (id, policy_version, arm, outcome, at, schema_version) VALUES (?, ?, ?, ?, ?, 1)",
  ).run(newUlid(), policyVersion, arm, outcome, new Date().toISOString());
  const row = db
    .query(
      "SELECT weight FROM routing_weight WHERE policy_version = ? AND arm = ?",
    )
    .get(policyVersion, arm) as { weight: number } | null;
  const prev = row?.weight ?? BANDIT_DEFAULTS.w0;
  const next = (1 - alpha) * prev + alpha * outcome;
  if (row)
    db.query(
      "UPDATE routing_weight SET weight = ?, updated_at = ? WHERE policy_version = ? AND arm = ?",
    ).run(next, new Date().toISOString(), policyVersion, arm);
  else
    db.query(
      "INSERT INTO routing_weight (policy_version, arm, weight, updated_at) VALUES (?, ?, ?, ?)",
    ).run(policyVersion, arm, next, new Date().toISOString());
  return next;
};

// RPOL §4 promotion trigger: challenger beats the incumbent by > 0.1 for 50
// consecutive outcomes, both arms carrying >= 50 recorded outcomes — a loop
// PROPOSAL input, never a direct policy change (RTR-5).
export const promotionCandidate = (
  db: Database,
  policyVersion: string,
  incumbentArm: string,
  challengerArm: string,
): boolean => {
  const count = (arm: string) =>
    (
      db
        .query(
          "SELECT COUNT(*) AS n FROM routing_outcome WHERE policy_version = ? AND arm = ?",
        )
        .get(policyVersion, arm) as { n: number }
    ).n;
  if (count(incumbentArm) < 50 || count(challengerArm) < 50) return false;
  // Streak: replay both arms' full outcome history chronologically, tracking
  // running EMAs; the margin must hold after every one of the last 50
  // outcome events. A margin crossed late in the window fails.
  const history = db
    .query(
      "SELECT arm, outcome FROM routing_outcome WHERE policy_version = ? AND arm IN (?, ?) ORDER BY rowid",
    )
    .all(policyVersion, incumbentArm, challengerArm) as {
    arm: string;
    outcome: number;
  }[];
  const ema: Record<string, number> = {
    [incumbentArm]: BANDIT_DEFAULTS.w0,
    [challengerArm]: BANDIT_DEFAULTS.w0,
  };
  const margins: boolean[] = [];
  for (const row of history) {
    ema[row.arm] =
      (1 - BANDIT_DEFAULTS.alpha) * (ema[row.arm] as number) +
      BANDIT_DEFAULTS.alpha * row.outcome;
    margins.push(
      (ema[challengerArm] as number) > (ema[incumbentArm] as number) + 0.1,
    );
  }
  return margins.length >= 50 && margins.slice(-50).every(Boolean);
};
