import { describe, expect, it } from "bun:test";
import {
  buildGate,
  detectDrift,
  hashContent,
  registerArtifact,
} from "../../src/artifacts.ts";
import { inferredSpecMarkdown } from "../../src/excavate.ts";
import { compileSpec, ingestManifest } from "../../src/kelspec.ts";
import { openDb } from "../../src/storage.ts";

describe("SPEC-7: excavation emits authority:inferred clauses linked to code evidence — drift detectors, never build blockers", () => {
  it("emitted inferred kelspec compiles, carries evidence links, and ingests with authority inferred", () => {
    const markdown = inferredSpecMarkdown({
      componentId: "legacy-parser",
      events: ["line_received"],
      clauses: [
        {
          id: "LP-1",
          ears: "event",
          trigger: "line_received",
          text: "When a line arrives, the parser shall trim trailing whitespace before tokenizing.",
          inputs: {},
          observe: ["tokens"],
          check: "(ctx) => ctx.expect(ctx.tokens === ctx.tokens)",
          evidence: ["src/parser.ts:42", "test/parser.test.ts:10"],
        },
      ],
    });
    expect(markdown).toContain("src/parser.ts:42");
    const res = compileSpec(markdown, {
      file: "docs/kelspec/legacy-parser.spec.md",
    });
    expect(res.ok).toBe(true);
    if (!res.ok || res.spec === null) throw new Error("unreachable");
    expect(res.spec.component.authority).toBe("inferred");

    const db = openDb(":memory:");
    ingestManifest(db, "r", res.spec.manifest, "inferred");
    const row = db
      .query(
        "SELECT authority FROM artifact WHERE repo = 'r' AND logical_id = 'docs/kelspec/legacy-parser.spec.md#LP-1'",
      )
      .get() as { authority: string };
    expect(row.authority).toBe("inferred");
    db.close();
  });

  it("violating an inferred clause alerts but allows build; a confirmed clause blocks per ART-4", () => {
    const db = openDb(":memory:");
    for (const [id, authority] of [
      ["spec.md#INF-1", "inferred"],
      ["spec.md#CONF-1", "confirmed"],
    ] as const) {
      registerArtifact(db, {
        repo: "r",
        logical_id: id,
        type: "spec",
        content: `${id}-v1`,
        authority,
        tier: "T1",
      });
      registerArtifact(db, {
        repo: "r",
        logical_id: `src/${id}.ts`,
        type: "code_region",
        content: "code-v1",
        upstream: [id],
      });
    }
    // Violate both: code drifts under each clause.
    detectDrift(db, "r", (logicalId) =>
      logicalId.startsWith("src/")
        ? hashContent("code-v2")
        : hashContent(`${logicalId}-v1`),
    );
    const inferredGate = buildGate(db, "r", ["spec.md#INF-1"]);
    expect(inferredGate.action).toBe("proceed");
    expect(inferredGate.alerts.length).toBeGreaterThan(0);
    const confirmedGate = buildGate(db, "r", ["spec.md#CONF-1"]);
    expect(confirmedGate.action).toBe("block");
    db.close();
  });
});
