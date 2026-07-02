import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AgentRegistryEntry,
  type FeatureVector,
  type NoveltyBucket,
  type RouteTargetSpec,
  RoutingDecision,
  RoutingPolicy,
  type RuleMatch,
  type TaskSize,
  type Tier,
} from "@kelson/schemas";
import { hashContent } from "./artifacts.ts";
import { canonicalJson } from "./packs.ts";
import { ulid } from "./ulid.ts";

export const loadPolicy = (path: string): RoutingPolicy =>
  RoutingPolicy.parse(Bun.YAML.parse(readFileSync(path, "utf8")));

export const policyHash = (policy: RoutingPolicy): string =>
  hashContent(canonicalJson(policy));

export const loadRegistry = (dir: string): AgentRegistryEntry[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) =>
      AgentRegistryEntry.parse(
        Bun.YAML.parse(readFileSync(join(dir, f), "utf8")),
      ),
    );
};

// RPOL-1: every rule/default target must exist in the registry so routing is
// total AND every decision's target is resolvable (RTR-1 obligation).
export const validatePolicyTargets = (
  policy: RoutingPolicy,
  registry: AgentRegistryEntry[],
): void => {
  const ids = new Set(registry.map((e) => e.id));
  const missing = [
    ...policy.rules.flatMap((r) => [r.target, ...r.escalation]),
    policy.default.target,
    ...policy.default.escalation,
  ].filter((t) => !ids.has(t));
  if (missing.length)
    throw new Error(
      `policy names targets absent from the registry: ${[...new Set(missing)].join(", ")}`,
    );
};

// RPOL-2 feature extraction with the table's declared fallbacks.
export interface FeatureInputs {
  step: FeatureVector["step"];
  repo: string;
  touchedTiers?: Tier[];
  plannedFiles?: string[];
  langCounts?: Record<string, number>;
  repoPrimaryLang?: string;
  history?: string[][];
  mechanical?: boolean;
}

const TIER_ORDER: Record<Tier, number> = { T0: 0, T1: 1, T2: 2 };

export const jaccard = (a: string[], b: string[]): number => {
  const sa = new Set(a);
  const sb = new Set(b);
  const union = new Set([...sa, ...sb]);
  if (union.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / union.size;
};

const bucketOf = (novelty: number): NoveltyBucket =>
  novelty < 0.3 ? "low" : novelty > 0.7 ? "high" : "mid";

export const extractFeatures = (i: FeatureInputs): FeatureVector => {
  const tier = (i.touchedTiers ?? []).reduce<Tier>(
    (max, t) => (TIER_ORDER[t] > TIER_ORDER[max] ? t : max),
    "T0",
  );
  const size: TaskSize =
    i.plannedFiles === undefined
      ? "M"
      : i.plannedFiles.length <= 2
        ? "S"
        : i.plannedFiles.length <= 10
          ? "M"
          : "L";
  const novelty =
    i.plannedFiles === undefined || !i.history?.length
      ? 1
      : 1 -
        Math.max(
          ...i.history.map((h) => jaccard(i.plannedFiles as string[], h)),
        );
  const counts = Object.entries(i.langCounts ?? {});
  const maxCount = Math.max(0, ...counts.map(([, n]) => n));
  const dominant = counts.filter(([, n]) => n === maxCount);
  const lang =
    dominant.length === 1
      ? (dominant[0] as [string, number])[0]
      : (i.repoPrimaryLang ?? "unknown");
  return {
    step: i.step,
    tier,
    size,
    lang,
    novelty,
    novelty_bucket: bucketOf(novelty),
    task_type: i.mechanical ? "mechanical" : "standard",
    repo: i.repo,
  };
};

const ruleMatches = (match: RuleMatch, v: FeatureVector): boolean =>
  (match.step === undefined || match.step === v.step) &&
  (match.tier === undefined || match.tier === v.tier) &&
  (match.size === undefined || match.size === v.size) &&
  (match.lang === undefined || match.lang === v.lang) &&
  (match.novelty === undefined || match.novelty === v.novelty_bucket) &&
  (match.task_type === undefined || match.task_type === v.task_type) &&
  (match.repo === undefined || match.repo === v.repo);

// RPOL-1: first match wins, falling through to default (rule_index -1).
export const resolveRule = (
  policy: RoutingPolicy,
  v: FeatureVector,
): { spec: RouteTargetSpec; ruleIndex: number } => {
  const idx = policy.rules.findIndex((r) => ruleMatches(r.match, v));
  if (idx === -1) return { spec: policy.default, ruleIndex: -1 };
  const rule = policy.rules[idx] as RoutingPolicy["rules"][number];
  const { match: _match, ...spec } = rule;
  return { spec, ruleIndex: idx };
};

// RPOL-5: most fields specified wins; ties → lower cost_class; none → null.
export const matchAgent = (
  registry: AgentRegistryEntry[],
  v: FeatureVector,
  domain?: string,
): AgentRegistryEntry | null => {
  const capMatches = (
    cap: AgentRegistryEntry["capabilities"][number],
  ): number | null => {
    let fields = 0;
    if (cap.domain !== undefined) {
      if (cap.domain !== domain) return null;
      fields++;
    }
    if (cap.lang !== undefined) {
      if (cap.lang !== v.lang) return null;
      fields++;
    }
    if (cap.task_type !== undefined) {
      if (cap.task_type !== v.task_type) return null;
      fields++;
    }
    if (cap.step !== undefined) {
      if (cap.step !== v.step) return null;
      fields++;
    }
    return fields;
  };
  let best: { entry: AgentRegistryEntry; fields: number } | null = null;
  for (const entry of registry.filter((e) => e.kind === "custom_agent")) {
    const scores = entry.capabilities
      .map(capMatches)
      .filter((s): s is number => s !== null && s > 0);
    if (!scores.length) continue;
    const fields = Math.max(...scores);
    if (
      best === null ||
      fields > best.fields ||
      (fields === best.fields && entry.cost_class < best.entry.cost_class)
    )
      best = { entry, fields };
  }
  return best?.entry ?? null;
};

// RTR-3/RPOL-4 guard: exploration is legal ONLY at T0, with a candidate whose
// cost_class is exactly one below the exploit target's. The Phase 3 router is
// exploit-only; the Phase 5 bandit must pass through this gate.
export const canExplore = (
  v: FeatureVector,
  exploitTarget: AgentRegistryEntry,
  registry: AgentRegistryEntry[],
): boolean =>
  v.tier === "T0" &&
  registry.some((e) => e.cost_class === exploitTarget.cost_class - 1);

export interface RouteArgs {
  policy: RoutingPolicy;
  registry: AgentRegistryEntry[];
  vector: FeatureVector;
  taskId: string;
  stepId: string;
  domain?: string;
}

const insertDecision = (db: Database, d: RoutingDecision): void => {
  db.query(
    `INSERT INTO routing_decision (id, task_id, step_id, attempt, kind, feature_vector, rule_index, matched_by, target, effort, loadout, budget_tokens, escalation, policy_hash, regret, at, schema_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    d.id,
    d.task_id,
    d.step_id,
    d.attempt,
    d.kind,
    JSON.stringify(d.feature_vector),
    d.rule_index,
    d.matched_by,
    d.target,
    d.effort,
    JSON.stringify(d.loadout),
    d.budget_tokens,
    JSON.stringify(d.escalation),
    d.policy_hash,
    d.regret ? 1 : 0,
    d.at,
    d.schema_version,
  );
};

export const readDecision = (db: Database, id: string): RoutingDecision => {
  const row = db
    .query("SELECT * FROM routing_decision WHERE id = ?")
    .get(id) as Record<string, unknown>;
  return RoutingDecision.parse({
    ...row,
    feature_vector: JSON.parse(row.feature_vector as string),
    loadout: JSON.parse(row.loadout as string),
    escalation: JSON.parse(row.escalation as string),
    regret: row.regret === 1,
  });
};

// RTR-1: select target/effort/loadout/budget from the active policy, record
// the decision and its feature vector. RTR-4: capability-matched custom
// agents take precedence; no match falls back to the policy target.
export const route = (db: Database, args: RouteArgs): RoutingDecision => {
  validatePolicyTargets(args.policy, args.registry);
  const { spec, ruleIndex } = resolveRule(args.policy, args.vector);
  const agent = matchAgent(args.registry, args.vector, args.domain);
  const decision = RoutingDecision.parse({
    id: ulid(),
    task_id: args.taskId,
    step_id: args.stepId,
    attempt: 0,
    kind: "initial",
    feature_vector: args.vector,
    rule_index: ruleIndex,
    matched_by: agent ? "capability" : "rule",
    target: agent?.id ?? spec.target,
    effort: spec.effort,
    loadout: spec.loadout,
    budget_tokens: spec.budget_tokens,
    escalation: spec.escalation,
    policy_hash: policyHash(args.policy),
    regret: false,
    at: new Date().toISOString(),
    schema_version: 1,
  });
  insertDecision(db, decision);
  return decision;
};

// RPOL §3 derivation, in order: first rule owning the target whose match
// accepts the vector; else first rule owning the target; else the default
// when it owns the target; else the previous attempt's budget.
const targetBudget = (
  policy: RoutingPolicy,
  target: string,
  vector: FeatureVector,
  fallback: number,
): number => {
  const matching = policy.rules.find(
    (r) => r.target === target && ruleMatches(r.match, vector),
  );
  if (matching) return matching.budget_tokens;
  const owning = policy.rules.find((r) => r.target === target);
  if (owning) return owning.budget_tokens;
  if (policy.default.target === target) return policy.default.budget_tokens;
  return fallback;
};

export type EscalationOutcome =
  | { kind: "escalated"; decision: RoutingDecision }
  | { kind: "triage" };

// RTR-2: escalate to the next ladder entry, recorded as a routing-regret
// event. RPOL-3: cap 2 automatic escalations; the third failure goes to triage.
export const escalate = (
  db: Database,
  policy: RoutingPolicy,
  prev: RoutingDecision,
): EscalationOutcome => {
  const nextAttempt = prev.attempt + 1;
  if (nextAttempt > 2) return { kind: "triage" };
  const ladder =
    prev.kind === "initial"
      ? prev.escalation
      : readInitialLadder(db, prev.task_id, prev.step_id);
  const target = ladder[nextAttempt - 1];
  if (target === undefined) return { kind: "triage" };
  const decision = RoutingDecision.parse({
    ...prev,
    id: ulid(),
    attempt: nextAttempt,
    kind: "escalation",
    target,
    budget_tokens: targetBudget(
      policy,
      target,
      prev.feature_vector,
      prev.budget_tokens,
    ),
    regret: true,
    at: new Date().toISOString(),
  });
  insertDecision(db, decision);
  return { kind: "escalated", decision };
};

const readInitialLadder = (
  db: Database,
  taskId: string,
  stepId: string,
): string[] => {
  const row = db
    .query(
      // rowid: ISO timestamps and ULIDs both tie within one millisecond (F-060).
      "SELECT escalation FROM routing_decision WHERE task_id = ? AND step_id = ? AND kind = 'initial' ORDER BY rowid LIMIT 1",
    )
    .get(taskId, stepId) as { escalation: string } | null;
  return row ? (JSON.parse(row.escalation) as string[]) : [];
};
