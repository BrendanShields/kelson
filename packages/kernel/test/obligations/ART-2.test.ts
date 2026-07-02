import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import {
  detectStaleness,
  registerArtifact,
  staleDownstream,
} from "../../src/artifacts.ts";
import { openDb } from "../../src/storage.ts";
import { dagArb, registerDag } from "./ART-1.test.ts";

const expectedFlagged = (
  dag: { n: number; upstreamOf: (i: number) => string[] },
  edited: number,
): string[] => {
  const children = new Map<string, string[]>();
  for (let i = 0; i < dag.n; i++)
    for (const up of dag.upstreamOf(i))
      children.set(up, [...(children.get(up) ?? []), `node-${i}`]);
  const flagged = new Set<string>();
  const queue = [...(children.get(`node-${edited}`) ?? [])];
  while (queue.length) {
    const node = queue.pop() as string;
    if (flagged.has(node)) continue;
    flagged.add(node);
    queue.push(...(children.get(node) ?? []));
  }
  return [...flagged].sort();
};

describe("ART-2: an edit flags exactly the transitive downstream set", () => {
  it("holds for any edit to any node in generated DAGs", () => {
    fc.assert(
      fc.property(dagArb, fc.integer({ min: 0, max: 9 }), (dag, editSeed) => {
        const db = openDb(":memory:");
        registerDag(db, dag);
        expect(staleDownstream(db, "r")).toEqual([]);

        const edited = editSeed % dag.n;
        registerArtifact(db, {
          repo: "r",
          logical_id: `node-${edited}`,
          type: "spec",
          content: `${dag.contents[edited]}-EDITED`,
          upstream: dag.upstreamOf(edited),
        });
        expect(staleDownstream(db, "r")).toEqual(expectedFlagged(dag, edited));
        db.close();
      }),
      { numRuns: 100 },
    );
  });

  it("colliding logical_ids across repos stay isolated (links, staleness, drift)", () => {
    const db = openDb(":memory:");
    for (const repo of ["r1", "r2"]) {
      registerArtifact(db, {
        repo,
        logical_id: "README.md",
        type: "spec",
        content: `${repo}-v1`,
      });
      registerArtifact(db, {
        repo,
        logical_id: "impl.ts",
        type: "code_region",
        content: "i",
        upstream: ["README.md"],
      });
    }
    registerArtifact(db, {
      repo: "r1",
      logical_id: "README.md",
      type: "spec",
      content: "r1-v2",
    });

    expect(staleDownstream(db, "r1")).toEqual(["impl.ts"]);
    expect(staleDownstream(db, "r2")).toEqual([]);
    expect(detectStaleness(db, "r2")).toEqual([]);
    detectStaleness(db, "r1");
    const rows = db.query("SELECT repo FROM drift_event").all() as {
      repo: string;
    }[];
    expect(rows.map((r) => r.repo)).toEqual(["r1"]);
    registerArtifact(db, {
      repo: "r2",
      logical_id: "impl.ts",
      type: "code_region",
      content: "i2",
      upstream: ["README.md"],
    });
    const r1Links = db
      .query("SELECT COUNT(*) AS c FROM trace_link WHERE repo = 'r1'")
      .get() as { c: number };
    expect(r1Links.c).toBe(1);
    db.close();
  });

  it("detectStaleness records one open drift event per flagged artifact, idempotently", () => {
    const db = openDb(":memory:");
    registerArtifact(db, {
      repo: "r",
      logical_id: "a",
      type: "spec",
      content: "v1",
    });
    registerArtifact(db, {
      repo: "r",
      logical_id: "b",
      type: "code_region",
      content: "b",
      upstream: ["a"],
    });
    registerArtifact(db, {
      repo: "r",
      logical_id: "c",
      type: "test",
      content: "c",
      upstream: ["b"],
    });
    registerArtifact(db, {
      repo: "r",
      logical_id: "a",
      type: "spec",
      content: "v2",
    });

    expect(detectStaleness(db, "r")).toEqual(["b", "c"]);
    detectStaleness(db, "r");
    const count = (
      db
        .query(
          "SELECT COUNT(*) AS c FROM drift_event WHERE direction = 'upstream_stale'",
        )
        .get() as { c: number }
    ).c;
    expect(count).toBe(2);
    db.close();
  });
});
