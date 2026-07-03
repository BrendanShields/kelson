import { describe, expect, it } from "bun:test";
import { runTurn } from "../../src/loop.ts";
import { listEvents, reconstruct } from "../../src/sessions.ts";
import { loadSpecContext, obligationChecks } from "../../src/spec.ts";
import { fixture, textResponse, toolCallResponse } from "../helpers.ts";
import { seedSpec } from "../spec-helpers.ts";

const write = (id: string, content: string) =>
  toolCallResponse([
    { id, name: "write", input: { path: "src/governed.ts", content } },
  ]);

describe("AGT-7: obligation done-gate — run after governed writes, refuse done while failing", () => {
  it("a wrong write fails the obligation and blocks done; the sentinel write passes and reaches done", async () => {
    const f = fixture([
      write("c1", "// still wrong\n"), // step 1: obligation runs, fails
      textResponse("all set"), // step 2: attempts done → blocked
      write("c2", "const x = 'SENTINEL';\n"), // step 3: obligation passes
      textResponse("all set"), // step 4: done allowed
    ]);
    f.deps.rules = [{ tool: "write", action: "allow" }];
    seedSpec(f.db, f.dir);
    f.deps.spec = loadSpecContext(f.db, f.dir);
    expect(f.deps.spec.empty).toBe(false);

    const result = await runTurn(f.deps);
    expect(result.status).toBe("done");

    const checks = obligationChecks(reconstruct(listEvents(f.db, f.sessionId)));
    // Two executions: the failing wrong-write and the passing sentinel-write.
    expect(checks.map((c) => c.status)).toEqual(["fail", "pass"]);
    // The block injected a user_message before the fix.
    const userMsgs = listEvents(f.db, f.sessionId).filter(
      (e) => e.kind === "user_message",
    );
    expect(
      userMsgs.some((e) => String(e.payload.text).includes("AGT-TEST")),
    ).toBe(true);
  }, 30_000);

  it("re-writing byte-identical content is a cache hit — no re-run, no event", async () => {
    const f = fixture([
      write("c1", "const x = 'SENTINEL';\n"), // passes
      write("c2", "const x = 'SENTINEL';\n"), // identical → cache hit
      textResponse("done"),
    ]);
    f.deps.rules = [{ tool: "write", action: "allow" }];
    seedSpec(f.db, f.dir);
    f.deps.spec = loadSpecContext(f.db, f.dir);

    await runTurn(f.deps);
    const checks = obligationChecks(reconstruct(listEvents(f.db, f.sessionId)));
    // Only one obligation event despite two writes of the same bytes.
    expect(checks.length).toBe(1);
    expect(checks[0]?.status).toBe("pass");
  }, 30_000);

  it("a still-failing earlier clause blocks done even on a step touching nothing", async () => {
    const f = fixture([
      write("c1", "// wrong\n"), // fails clause
      textResponse("try to finish"), // touches nothing, still blocked
      textResponse("try again"), // still blocked
    ]);
    f.deps.rules = [{ tool: "write", action: "allow" }];
    seedSpec(f.db, f.dir);
    f.deps.spec = loadSpecContext(f.db, f.dir);
    // Runaway guard: the gate never clears, so cap steps and assert it never
    // reached done.
    const result = await runTurn(f.deps, 3);
    expect(result.status).toBe("paused"); // step_limit, never done
    if (result.status === "paused") expect(result.reason).toBe("step_limit");
  }, 30_000);

  it("a bash call that breaks a governed file is caught — the done-gate blocks (F-123)", async () => {
    const f = fixture([
      write("c1", "const x = 'SENTINEL';\n"), // passes the clause
      toolCallResponse([
        {
          id: "b1",
          name: "bash",
          input: { command: "echo '// broken' > src/governed.ts" },
        },
      ]), // bash breaks it without a declared path
      textResponse("done"), // must be blocked
    ]);
    f.deps.rules = [
      { tool: "write", action: "allow" },
      { tool: "bash", action: "allow" },
    ];
    seedSpec(f.db, f.dir);
    f.deps.spec = loadSpecContext(f.db, f.dir);

    const result = await runTurn(f.deps, 3);
    // The bash re-check ran the obligation (now failing), so done is refused.
    expect(result.status).toBe("paused"); // step_limit, never reached done
    const checks = obligationChecks(reconstruct(listEvents(f.db, f.sessionId)));
    expect(checks.map((c) => c.status)).toEqual(["pass", "fail"]);
  }, 30_000);

  it("an empty SpecContext never runs obligations and never blocks done", async () => {
    const f = fixture([write("c1", "// anything\n"), textResponse("done")]);
    f.deps.rules = [{ tool: "write", action: "allow" }];
    f.deps.spec = loadSpecContext(f.db, f.dir); // no seed → empty
    expect(f.deps.spec.empty).toBe(true);

    const result = await runTurn(f.deps);
    expect(result.status).toBe("done");
    expect(
      obligationChecks(reconstruct(listEvents(f.db, f.sessionId))),
    ).toEqual([]);
  }, 30_000);
});
