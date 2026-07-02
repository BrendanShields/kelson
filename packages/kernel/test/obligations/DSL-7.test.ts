import { describe, expect, it } from "bun:test";
import type { KelspecClause } from "@kelson/schemas";
import {
  buildProbes,
  type Implementation,
  probeImplementations,
  runDivergence,
} from "../../src/divergence.ts";
import { compileSpec } from "../../src/kelspec.ts";

const SOURCE = `\`\`\`kelspec
{"kind": "component", "id": "quantizer", "tier": "T0", "authority": "authored", "events": ["quantize_requested"]}
\`\`\`

\`\`\`kelspec
{"kind": "domain", "id": "Qty", "type": "int", "unit": "units", "min": 0, "max": 1000}
\`\`\`

\`\`\`kelspec
{"kind": "clause", "id": "QZ-1", "ears": "event", "trigger": "quantize_requested", "text": "When quantization is requested, the quantizer shall report the quantity unchanged.", "inputs": {"qty": "Qty"}, "observe": ["out", "computed_at"], "check": "(ctx) => ctx.expect(ctx.out === ctx.qty)", "nondeterministic": ["computed_at"]}
\`\`\`
`;

const CLAUSE: KelspecClause = {
  kind: "clause",
  id: "QZ-1",
  ears: "event",
  trigger: "quantize_requested",
  text: "t",
  inputs: { qty: "Qty" },
  observe: ["out", "computed_at"],
  check: "(ctx) => true",
  pre: null,
  post: null,
  nondeterministic: ["computed_at"],
  unverifiable: null,
};

const compiled = () => {
  const res = compileSpec(SOURCE, { file: "q.spec.md" });
  if (!res.ok || res.spec === null) throw new Error("fixture must compile");
  return res.spec;
};

let tick = 0;
const impl = (
  behavior: (qty: number) => Record<string, unknown>,
): Implementation => ({
  "QZ-1": (inputs) => ({
    ...behavior(inputs.qty as number),
    computed_at: `t${tick++}`,
  }),
});

describe("DSL-7: probe determinism, throw-vs-return, and nondeterministic redaction pin the divergence contract", () => {
  it("identical spec bytes produce byte-identical probe sets; different bytes reseed", () => {
    const spec = compiled();
    const a = buildProbes(spec, SOURCE, [CLAUSE]);
    const b = buildProbes(spec, SOURCE, [CLAUSE]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = buildProbes(spec, `${SOURCE}\nx`, [CLAUSE]);
    expect(c.seed).not.toBe(a.seed);
  });

  it("throw-vs-return is a divergence unconditionally, reported as $outcome", () => {
    const spec = compiled();
    const returns = impl((qty) => ({ out: qty }));
    const throwsOnZero = impl((qty) => {
      if (qty === 0) throw new RangeError("qty must be positive");
      return { out: qty };
    });
    const result = runDivergence(spec, SOURCE, [CLAUSE], returns, throwsOnZero);
    expect(result.status).toBe("implementation_rejected");
    // The obligation gate catches the thrower first (zero is in-domain);
    // the sanctioned gate-free surface probes the comparison row (DSL-7).
    const probed = probeImplementations(
      spec,
      SOURCE,
      [CLAUSE],
      returns,
      throwsOnZero,
    );
    expect(probed.status).toBe("diverged");
    const outcomeEntry = probed.entries.find(
      (e) => e.differing_path === "$outcome",
    );
    expect(outcomeEntry?.probe_input).toEqual({ qty: 0 });
    expect(outcomeEntry?.outcome_b).toEqual({
      tag: "threw",
      errorName: "RangeError",
    });
  });

  it("a difference ONLY in nondeterministic fields is not a divergence, and redactions are recorded when real ones exist", () => {
    const spec = compiled();
    // Both agree on `out`; computed_at differs every call (tick counter).
    const a = impl((qty) => ({ out: qty }));
    const b = impl((qty) => ({ out: qty }));
    const clean = runDivergence(spec, SOURCE, [CLAUSE], a, b);
    expect(clean.status).toBe("converged");

    // A real difference still reports, post-redaction, naming the path.
    const off = impl((qty) => ({ out: qty + 1 }));
    const dirty = runDivergence(spec, SOURCE, [CLAUSE], a, off);
    expect(dirty.status).toBe("implementation_rejected"); // off violates QZ-1
    const probed = probeImplementations(spec, SOURCE, [CLAUSE], a, off);
    expect(probed.status).toBe("diverged");
    expect(probed.entries[0]?.differing_path).toBe("$.out");
    expect(probed.entries[0]?.redacted_paths).toEqual(["computed_at"]);
    expect(JSON.stringify(probed.entries[0]?.outcome_a)).not.toContain(
      "computed_at",
    );
  });
});
