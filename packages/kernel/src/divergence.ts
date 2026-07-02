import type { Database } from "bun:sqlite";
import type { KelspecClause, KelspecDomain } from "@kelson/schemas";
import fc from "fast-check";
import { hashContent } from "./artifacts.ts";
import { domainArbitrary } from "./generators.ts";
import type { CompiledSpec, ObservationHarness } from "./kelspec.ts";
import { ulid } from "./ulid.ts";

// DSL-7: an implementation is one observation harness per clause — the same
// shape the compiled obligations consume.
export type Implementation = Record<string, ObservationHarness>;

export interface ProbeSet {
  seed: number;
  probes: Record<string, Record<string, unknown>[]>;
}

const boundaryValues = (domain: KelspecDomain): unknown[] => {
  switch (domain.type) {
    case "int":
      return [domain.min, domain.max, 0, domain.min + 1, domain.max - 1].filter(
        (v) => v >= domain.min && v <= domain.max,
      );
    case "float": {
      const mid = (domain.min + domain.max) / 2;
      return [domain.min, domain.max, mid];
    }
    case "enum":
      return domain.values;
    case "string":
      return ["", "a"];
    default:
      return [];
  }
};

// DSL-7: boundary corpus prepended to seeded generator draws, 256 per clause,
// seed derived from the spec content hash — byte-identical across runs.
export const buildProbes = (
  spec: CompiledSpec,
  specSource: string,
  clauses: KelspecClause[],
  perClause = 256,
): ProbeSet => {
  const seed = Number.parseInt(hashContent(specSource).slice(7, 15), 16);
  const probes: Record<string, Record<string, unknown>[]> = {};
  for (const clause of clauses) {
    const inputNames = Object.keys(clause.inputs);
    const domains = inputNames.map(
      (name) =>
        spec.domains.get(clause.inputs[name] as string) as KelspecDomain,
    );
    const boundary: Record<string, unknown>[] = [];
    // Cross the first input's boundaries with the others' first boundary.
    if (inputNames.length > 0) {
      const grids = domains.map(boundaryValues);
      const base = Object.fromEntries(
        inputNames.map((n, i) => [n, grids[i]?.[0]]),
      );
      grids.forEach((grid, i) => {
        for (const v of grid)
          boundary.push({ ...base, [inputNames[i] as string]: v });
      });
      // Half-increment ties for paired numeric inputs.
      if (domains.length >= 2 && domains.every((d) => d.type === "int")) {
        const [a, b] = inputNames as [string, string];
        boundary.push({ ...base, [a]: 5, [b]: 2 }, { ...base, [a]: 1, [b]: 2 });
      }
    }
    const arb = fc.record(
      Object.fromEntries(
        inputNames.map((name, i) => [
          name,
          domainArbitrary(spec.domains, clause.inputs[name] as string),
        ]),
      ),
    ) as fc.Arbitrary<Record<string, unknown>>;
    const generated = fc.sample(arb, {
      numRuns: perClause - boundary.length,
      seed,
    });
    const seen = new Set<string>();
    probes[clause.id] = [...boundary, ...generated].filter((p) => {
      const key = JSON.stringify(p, Object.keys(p).sort());
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  return { seed, probes };
};

type Outcome =
  | { tag: "returned"; value: Record<string, unknown> }
  | { tag: "threw"; errorName: string };

const observe = (
  harness: ObservationHarness | undefined,
  input: Record<string, unknown>,
): Outcome => {
  if (!harness) return { tag: "threw", errorName: "MissingHarness" };
  try {
    return { tag: "returned", value: harness(structuredClone(input)) };
  } catch (e) {
    return { tag: "threw", errorName: (e as Error).constructor.name };
  }
};

const redact = (
  record: Record<string, unknown>,
  paths: string[],
): Record<string, unknown> => {
  const out = structuredClone(record);
  for (const path of paths) {
    const segs = path.split(".");
    let target: Record<string, unknown> | undefined = out;
    for (const seg of segs.slice(0, -1))
      target = target?.[seg] as Record<string, unknown> | undefined;
    if (target) delete target[segs[segs.length - 1] as string];
  }
  return out;
};

// DSL-7 comparison: tag mismatch diverges unconditionally; both-threw
// compares error names only; both-returned compares canonically with
// bit-exact numbers (Object.is; NaN = NaN) — no harness epsilon, ever.
const firstDiff = (a: unknown, b: unknown, path = "$"): string | null => {
  if (typeof a === "number" && typeof b === "number")
    return Object.is(a, b) ? null : path;
  if (a === null || b === null || typeof a !== typeof b)
    return a === b ? null : path;
  if (typeof a === "object") {
    const keys = new Set([
      ...Object.keys(a as object),
      ...Object.keys(b as object),
    ]);
    for (const key of [...keys].sort()) {
      const diff = firstDiff(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        `${path}.${key}`,
      );
      if (diff) return diff;
    }
    return null;
  }
  return a === b ? null : path;
};

export interface DivergenceEntry {
  clause_id: string;
  probe_input: Record<string, unknown>;
  differing_path: string;
  outcome_a: Outcome;
  outcome_b: Outcome;
  redacted_paths: string[];
}

export interface DivergenceResult {
  status: "diverged" | "converged" | "implementation_rejected";
  rejected?: { agent: "A" | "B"; clause: string };
  seed: number;
  entries: DivergenceEntry[];
}

// The probe/compare stage without the obligation gate — public for fixtures
// and tooling (DSL-7); runDivergence composes gate then probe.
export const probeImplementations = (
  spec: CompiledSpec,
  specSource: string,
  clauses: KelspecClause[],
  implA: Implementation,
  implB: Implementation,
): DivergenceResult => {
  const { seed, probes } = buildProbes(spec, specSource, clauses);
  const entries = collectEntries(probes, clauses, implA, implB);
  return { status: entries.length ? "diverged" : "converged", seed, entries };
};

const collectEntries = (
  probes: Record<string, Record<string, unknown>[]>,
  clauses: KelspecClause[],
  implA: Implementation,
  implB: Implementation,
): DivergenceEntry[] => {
  const entries: DivergenceEntry[] = [];
  for (const clause of clauses) {
    for (const input of probes[clause.id] ?? []) {
      const a = observe(implA[clause.id], input);
      const b = observe(implB[clause.id], input);
      if (a.tag !== b.tag) {
        entries.push({
          clause_id: clause.id,
          probe_input: input,
          differing_path: "$outcome",
          outcome_a: a,
          outcome_b: b,
          redacted_paths: clause.nondeterministic,
        });
        continue;
      }
      if (a.tag === "threw" && b.tag === "threw") {
        if (a.errorName !== b.errorName)
          entries.push({
            clause_id: clause.id,
            probe_input: input,
            differing_path: "$outcome.errorName",
            outcome_a: a,
            outcome_b: b,
            redacted_paths: clause.nondeterministic,
          });
        continue;
      }
      const ra = redact(
        (a as { value: Record<string, unknown> }).value,
        clause.nondeterministic,
      );
      const rb = redact(
        (b as { value: Record<string, unknown> }).value,
        clause.nondeterministic,
      );
      const diff = firstDiff(ra, rb);
      if (diff)
        entries.push({
          clause_id: clause.id,
          probe_input: input,
          differing_path: diff,
          outcome_a: { tag: "returned", value: ra },
          outcome_b: { tag: "returned", value: rb },
          redacted_paths: clause.nondeterministic,
        });
    }
  }
  return entries;
};

export const runDivergence = (
  spec: CompiledSpec,
  specSource: string,
  clauses: KelspecClause[],
  implA: Implementation,
  implB: Implementation,
): DivergenceResult => {
  const { seed, probes } = buildProbes(spec, specSource, clauses);
  // Obligation gate: both implementations must pass the compiled obligations
  // first — a spec-violating implementation is a bug, not ambiguity.
  for (const [agent, impl] of [
    ["A", implA],
    ["B", implB],
  ] as const) {
    for (const compiled of spec.clauses) {
      if (!compiled.makeProperty) continue;
      const harness = impl[compiled.id];
      if (!harness)
        return {
          status: "implementation_rejected",
          rejected: { agent, clause: compiled.id },
          seed,
          entries: [],
        };
      const check = fc.check(compiled.makeProperty(harness), {
        numRuns: 100,
        seed,
      });
      if (check.failed)
        return {
          status: "implementation_rejected",
          rejected: { agent, clause: compiled.id },
          seed,
          entries: [],
        };
    }
  }

  const entries = collectEntries(probes, clauses, implA, implB);
  return {
    status: entries.length ? "diverged" : "converged",
    seed,
    entries,
  };
};

// SPEC-5: a divergent spec routes back to planning and cannot reach build.
export const recordDivergence = (
  db: Database,
  specSource: string,
  result: DivergenceResult,
): string => {
  const id = ulid();
  db.query(
    "INSERT INTO divergence_report (id, spec_hash, clause_ids, entries, resolved, at, schema_version) VALUES (?, ?, ?, ?, 0, ?, 1)",
  ).run(
    id,
    hashContent(specSource),
    JSON.stringify([...new Set(result.entries.map((e) => e.clause_id))]),
    JSON.stringify(result.entries),
    new Date().toISOString(),
  );
  return id;
};

export const specBlockedByDivergence = (
  db: Database,
  specSource: string,
): boolean => {
  const row = db
    .query(
      "SELECT 1 FROM divergence_report WHERE spec_hash = ? AND resolved = 0",
    )
    .get(hashContent(specSource));
  return row !== null;
};
