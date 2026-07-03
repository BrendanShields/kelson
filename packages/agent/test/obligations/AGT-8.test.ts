import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runTurn } from "../../src/loop.ts";
import { listEvents } from "../../src/sessions.ts";
import { loadSpecContext } from "../../src/spec.ts";
import { fixture, textResponse, toolCallResponse } from "../helpers.ts";
import { markStale, seedSpec } from "../spec-helpers.ts";

const writeGoverned = (id: string) =>
  toolCallResponse([
    {
      id,
      name: "write",
      input: { path: "src/governed.ts", content: "const x = 'SENTINEL';\n" },
    },
  ]);

const lastToolResult = (db: Parameters<typeof listEvents>[0], sid: string) =>
  [...listEvents(db, sid)].reverse().find((e) => e.kind === "tool_result");

describe("AGT-8: ART-4 write gate — stale/spec-less T1+ writes blocked, override unblocks, T0 warns", () => {
  it("a T1 write against a stale confirmed clause is denied with a spec-repair message; the file is unchanged", async () => {
    const f = fixture([writeGoverned("c1"), textResponse("done")]);
    f.deps.rules = [{ tool: "write", action: "allow" }];
    const { governedAbs } = seedSpec(f.db, f.dir, { authority: "confirmed" });
    const before = readFileSync(governedAbs, "utf8");
    markStale(f.db, f.dir);
    f.deps.spec = loadSpecContext(f.db, f.dir);

    await runTurn(f.deps, 3);
    const tr = lastToolResult(f.db, f.sessionId);
    expect(tr?.payload.is_error).toBe(true);
    expect(String(tr?.payload.output)).toMatch(/blocked|spec repair|ART-4/);
    expect(readFileSync(governedAbs, "utf8")).toBe(before); // unwritten
  }, 30_000);

  it("a recorded override lets the stale write through", async () => {
    const f = fixture([writeGoverned("c1"), textResponse("done")]);
    f.deps.rules = [{ tool: "write", action: "allow" }];
    const { governedAbs } = seedSpec(f.db, f.dir, { authority: "confirmed" });
    markStale(f.db, f.dir);
    f.deps.spec = loadSpecContext(f.db, f.dir);
    f.deps.override = { by: "operator", reason: "known-safe" };

    await runTurn(f.deps);
    expect(readFileSync(governedAbs, "utf8")).toContain("SENTINEL");
  }, 30_000);

  it("a T0 stale clause warns and writes", async () => {
    const f = fixture([writeGoverned("c1"), textResponse("done")]);
    f.deps.rules = [{ tool: "write", action: "allow" }];
    const { governedAbs } = seedSpec(f.db, f.dir, {
      authority: "confirmed",
      tier: "T0",
    });
    markStale(f.db, f.dir);
    f.deps.spec = loadSpecContext(f.db, f.dir);

    await runTurn(f.deps);
    expect(readFileSync(governedAbs, "utf8")).toContain("SENTINEL");
  }, 30_000);

  it("a write to a T1 governed file with no non-inferred clause is denied (spec-first)", async () => {
    const f = fixture([writeGoverned("c1"), textResponse("done")]);
    f.deps.rules = [{ tool: "write", action: "allow" }];
    // Only an inferred clause governs the file → no non-inferred clause.
    const { governedAbs } = seedSpec(f.db, f.dir, { authority: "inferred" });
    const before = readFileSync(governedAbs, "utf8");
    f.deps.spec = loadSpecContext(f.db, f.dir);

    await runTurn(f.deps, 3);
    const tr = lastToolResult(f.db, f.sessionId);
    expect(tr?.payload.is_error).toBe(true);
    expect(String(tr?.payload.output)).toMatch(/spec-first|no non-inferred/);
    expect(readFileSync(governedAbs, "utf8")).toBe(before);
  }, 30_000);

  it("an empty SpecContext never blocks a write", async () => {
    const f = fixture([writeGoverned("c1"), textResponse("done")]);
    f.deps.rules = [{ tool: "write", action: "allow" }];
    f.deps.spec = loadSpecContext(f.db, f.dir); // no seed
    await runTurn(f.deps);
    expect(existsSync(join(f.dir, "src", "governed.ts"))).toBe(true);
  }, 30_000);
});
