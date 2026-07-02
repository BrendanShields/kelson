import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { hashContent, registerArtifact } from "../../src/artifacts.ts";
import { openDb } from "../../src/storage.ts";

// A DAG as edges lower→higher index guarantees acyclicity; node i's upstreams
// are a subset of nodes 0..i-1.
export const dagArb = fc
  .integer({ min: 3, max: 10 })
  .chain((n) =>
    fc.tuple(
      fc.constant(n),
      fc.array(fc.string({ minLength: 1, maxLength: 20 }), {
        minLength: n,
        maxLength: n,
      }),
      fc.array(fc.array(fc.boolean(), { minLength: n, maxLength: n }), {
        minLength: n,
        maxLength: n,
      }),
    ),
  )
  .map(([n, contents, adj]) => ({
    n,
    contents,
    upstreamOf: (i: number) =>
      Array.from({ length: i }, (_, j) => j)
        .filter((j) => (adj[i] as boolean[])[j])
        .map((j) => `node-${j}`),
  }));

export const registerDag = (
  db: ReturnType<typeof openDb>,
  dag: { n: number; contents: string[]; upstreamOf: (i: number) => string[] },
) => {
  for (let i = 0; i < dag.n; i++)
    registerArtifact(db, {
      repo: "r",
      logical_id: `node-${i}`,
      type: "spec",
      content: dag.contents[i] as string,
      upstream: dag.upstreamOf(i),
    });
};

describe("ART-1: recorded upstream hashes match current upstream contents iff no intervening edit", () => {
  it("holds across generated DAGs", () => {
    fc.assert(
      fc.property(dagArb, fc.integer({ min: 0, max: 9 }), (dag, editSeed) => {
        const db = openDb(":memory:");
        registerDag(db, dag);

        const links = db
          .query("SELECT upstream_id, upstream_hash_at_link FROM trace_link")
          .all() as { upstream_id: string; upstream_hash_at_link: string }[];
        for (const link of links) {
          const current = db
            .query("SELECT content_hash FROM artifact WHERE logical_id = ?")
            .get(link.upstream_id) as { content_hash: string };
          expect(link.upstream_hash_at_link).toBe(current.content_hash);
        }

        const edited = editSeed % dag.n;
        registerArtifact(db, {
          repo: "r",
          logical_id: `node-${edited}`,
          type: "spec",
          content: `${dag.contents[edited]}-EDITED`,
          upstream: dag.upstreamOf(edited),
        });
        const mismatched = (
          db
            .query(
              `SELECT DISTINCT tl.upstream_id FROM trace_link tl
               JOIN artifact a ON a.logical_id = tl.upstream_id
               WHERE tl.upstream_hash_at_link <> a.content_hash`,
            )
            .all() as { upstream_id: string }[]
        ).map((r) => r.upstream_id);
        const hasDownstreamLinks =
          (db
            .query("SELECT 1 FROM trace_link WHERE upstream_id = ?")
            .get(`node-${edited}`) as unknown) !== null;
        expect(mismatched).toEqual(
          hasDownstreamLinks ? [`node-${edited}`] : [],
        );
        db.close();
      }),
      { numRuns: 100 },
    );
  });

  it("rejects a declared upstream that was never registered", () => {
    const db = openDb(":memory:");
    expect(() =>
      registerArtifact(db, {
        repo: "r",
        logical_id: "x",
        type: "spec",
        content: "c",
        upstream: ["ghost"],
      }),
    ).toThrow(/not registered/);
    db.close();
  });

  it("re-registration replaces links (hashes re-recorded at current upstream state)", () => {
    const db = openDb(":memory:");
    registerArtifact(db, {
      repo: "r",
      logical_id: "up",
      type: "spec",
      content: "v1",
    });
    registerArtifact(db, {
      repo: "r",
      logical_id: "down",
      type: "code_region",
      content: "d",
      upstream: ["up"],
    });
    registerArtifact(db, {
      repo: "r",
      logical_id: "up",
      type: "spec",
      content: "v2",
    });
    registerArtifact(db, {
      repo: "r",
      logical_id: "down",
      type: "code_region",
      content: "d",
      upstream: ["up"],
    });
    const link = db
      .query(
        "SELECT upstream_hash_at_link FROM trace_link WHERE downstream_id = 'down'",
      )
      .get() as {
      upstream_hash_at_link: string;
    };
    expect(link.upstream_hash_at_link).toBe(hashContent("v2"));
    db.close();
  });
});
