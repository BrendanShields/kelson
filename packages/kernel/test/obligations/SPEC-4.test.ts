import { describe, expect, it } from "bun:test";
import type { KelspecClause } from "@kelson/schemas";
import { type Implementation, runDivergence } from "../../src/divergence.ts";
import { compileSpec } from "../../src/kelspec.ts";

// The obligation's fixture: fee = amount * rate_bp / 10000, ROUNDING
// UNSPECIFIED in the ambiguous version, pinned in the tightened one.
const spec = (text: string, checkExpr: string) => `\`\`\`kelspec
{"kind": "component", "id": "fee-calculator", "tier": "T0", "authority": "authored", "events": ["fee_requested"]}
\`\`\`

\`\`\`kelspec
{"kind": "domain", "id": "Amount", "type": "int", "unit": "micro_usd", "min": 0, "max": 1000000}
\`\`\`

\`\`\`kelspec
{"kind": "domain", "id": "RateBp", "type": "int", "unit": "basis_points", "min": 0, "max": 10000}
\`\`\`

\`\`\`kelspec
{"kind": "clause", "id": "FEE-1", "ears": "event", "trigger": "fee_requested", "text": ${JSON.stringify(text)}, "inputs": {"amount": "Amount", "rate_bp": "RateBp"}, "observe": ["fee"], "check": ${JSON.stringify(checkExpr)}}
\`\`\`
`;

const AMBIGUOUS = spec(
  "When a fee is requested, the calculator shall charge amount times rate_bp over ten thousand.",
  "(ctx) => ctx.expect(ctx.fee * 10000 - ctx.amount * ctx.rate_bp <= 10000 && ctx.amount * ctx.rate_bp - ctx.fee * 10000 <= 10000)",
);
const TIGHTENED = spec(
  "When a fee is requested, the calculator shall charge amount times rate_bp over ten thousand, rounded half away from zero.",
  "(ctx) => ctx.expect(ctx.fee * 10000 - 5000 <= ctx.amount * ctx.rate_bp && ctx.amount * ctx.rate_bp < ctx.fee * 10000 + 5000)",
);

const halfUp: Implementation = {
  "FEE-1": (inputs) => ({
    fee: Math.round(
      ((inputs.amount as number) * (inputs.rate_bp as number)) / 10000,
    ),
  }),
};
const truncating: Implementation = {
  "FEE-1": (inputs) => ({
    fee: Math.trunc(
      ((inputs.amount as number) * (inputs.rate_bp as number)) / 10000,
    ),
  }),
};

const compile = (source: string) => {
  const res = compileSpec(source, { file: "fee.spec.md" });
  if (!res.ok || res.spec === null)
    throw new Error(JSON.stringify(!res.ok ? res.errors : null));
  return res.spec;
};

const CLAUSES = (source: string): KelspecClause[] => {
  // Re-parse clause blocks for the probe builder's input declarations.
  return [
    {
      kind: "clause",
      id: "FEE-1",
      ears: "event",
      trigger: "fee_requested",
      text: "t",
      inputs: { amount: "Amount", rate_bp: "RateBp" },
      observe: ["fee"],
      check: "(ctx) => true",
      pre: null,
      post: null,
      nondeterministic: [],
      unverifiable: null,
    },
  ];
};

describe("SPEC-4: two independent implementations against shared probes — planted ambiguity yields a named divergence; the tightened spec yields none", () => {
  it("the unspecified rounding rule diverges, naming the probe input", () => {
    const compiled = compile(AMBIGUOUS);
    const result = runDivergence(
      compiled,
      AMBIGUOUS,
      CLAUSES(AMBIGUOUS),
      halfUp,
      truncating,
    );
    expect(result.status).toBe("diverged");
    const entry = result.entries[0];
    expect(entry).toBeDefined();
    // The report names a concrete probe input where the halves disagree.
    const { amount, rate_bp } = entry?.probe_input as {
      amount: number;
      rate_bp: number;
    };
    // Rounding-up vs truncation disagree exactly when the fraction >= 0.5.
    expect(((amount * rate_bp) / 10000) % 1).toBeGreaterThanOrEqual(0.5);
    expect(entry?.differing_path).toBe("$.fee");
  });

  it("the tightened spec (rounding pinned) yields no divergence — the truncating impl is rejected by the obligation gate instead", () => {
    const compiled = compile(TIGHTENED);
    const rejected = runDivergence(
      compiled,
      TIGHTENED,
      CLAUSES(TIGHTENED),
      halfUp,
      truncating,
    );
    // The tightened check makes truncation a spec VIOLATION, not ambiguity.
    expect(rejected.status).toBe("implementation_rejected");
    expect(rejected.rejected?.agent).toBe("B");

    // Two conforming implementations converge.
    const converged = runDivergence(
      compiled,
      TIGHTENED,
      CLAUSES(TIGHTENED),
      halfUp,
      { "FEE-1": halfUp["FEE-1"] as never },
    );
    expect(converged.status).toBe("converged");
    expect(converged.entries).toHaveLength(0);
  });
});
