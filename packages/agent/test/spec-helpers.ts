import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectDrift, hashContent, registerArtifact } from "@kelson/kernel";
import { loadSpecContext } from "../src/spec.ts";

// An obligation test that passes iff the governed file contains SENTINEL.
// bun test runs with cwd = the repo dir, so the relative read resolves.
const OBLIGATION_TEST = (
  governedRel: string,
) => `import { readFileSync } from "node:fs";
import { expect, it } from "bun:test";
it("governed file contains SENTINEL", () => {
  expect(readFileSync(${JSON.stringify(governedRel)}, "utf8")).toContain("SENTINEL");
});
`;

export interface SpecFixtureOpts {
  clauseId?: string;
  governedRel?: string; // path of the governed file, relative to repo
  tier?: "T0" | "T1" | "T2";
  authority?: "authored" | "inferred" | "confirmed";
  writeObligation?: boolean; // false => missing-obligation case
  initialContent?: string; // starting content of the governed file
}

// Seeds the artifact store (clause + governed code + trace link) and writes a
// real, runnable obligation test on disk under the repo dir.
export const seedSpec = (
  db: Database,
  repo: string,
  opts: SpecFixtureOpts = {},
): { clauseId: string; governedRel: string; governedAbs: string } => {
  const clauseId = opts.clauseId ?? "AGT-TEST";
  const governedRel = opts.governedRel ?? "src/governed.ts";
  const tier = opts.tier ?? "T1";
  const authority = opts.authority ?? "authored";

  registerArtifact(db, {
    repo,
    logical_id: clauseId,
    type: "spec",
    content: `clause ${clauseId}`,
    authority,
    tier,
  });
  const governedAbs = join(repo, governedRel);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(governedAbs, opts.initialContent ?? "// no sentinel yet\n");
  registerArtifact(db, {
    repo,
    logical_id: governedRel,
    type: "code_region",
    content: opts.initialContent ?? "// no sentinel yet\n",
    authority,
    tier,
    upstream: [clauseId],
  });

  if (opts.writeObligation !== false) {
    const obDir = join(repo, "packages", "pkg", "test", "obligations");
    mkdirSync(obDir, { recursive: true });
    writeFileSync(
      join(obDir, `${clauseId}.test.ts`),
      OBLIGATION_TEST(governedRel),
    );
  }
  return { clauseId, governedRel, governedAbs };
};

export const specContextFor = (db: Database, repo: string) =>
  loadSpecContext(db, repo);

// Opens a drift event on the seeded clause's governed file so buildGate sees
// it as stale (ART-4). Call after seedSpec.
export const markStale = (
  db: Database,
  repo: string,
  governedRel = "src/governed.ts",
): void => {
  const inserted = detectDrift(db, repo, (id) =>
    id === governedRel ? hashContent("moved") : hashContent(`clause ${id}`),
  );
  if (inserted.length === 0)
    throw new Error("markStale: expected a drift event to be inserted");
};
