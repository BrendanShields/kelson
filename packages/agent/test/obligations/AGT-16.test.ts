import { describe, expect, it } from "bun:test";
import type { SessionEvent } from "@obligato/schemas";
import { runTurn } from "../../src/loop.ts";
import {
  deterministicDigest,
  listEvents,
  pendingToolCalls,
  reconstruct,
} from "../../src/sessions.ts";
import { loadSpecContext, obligationChecks } from "../../src/spec.ts";
import {
  fixture,
  TEST_ENTRY,
  textResponse,
  toolCallResponse,
} from "../helpers.ts";
import { seedSpec } from "../spec-helpers.ts";

// USAGE_FIXTURE footprint per step: 70 in + 20 cache_read + 10 cache_write
// = 100. Window 125 makes the integer tie exact: 100×5 = 500 ≥ 125×4 = 500.
const TIE_WINDOW = 125;

const compactions = (db: Parameters<typeof listEvents>[0], sid: string) =>
  listEvents(db, sid).filter(
    (e) => e.kind === "session_meta" && e.payload.compaction,
  );

describe("AGT-16: over-threshold continue steps auto-compact once, deterministically, for free", () => {
  it("(a,c,e) exact-tie step appends one compaction; next call sees root+summary; zero extra provider calls", async () => {
    const f = fixture([
      toolCallResponse([{ id: "c1", name: "ls", input: { path: "." } }]),
      textResponse("done"),
    ]);
    f.deps.entry = { ...TEST_ENTRY, context_window: TIE_WINDOW };
    const result = await runTurn(f.deps);
    expect(result.status).toBe("done");

    // (c) exactly one compaction for the one over-threshold continue step
    // (the final text step ends the session and never triggers).
    const comps = compactions(f.db, f.sessionId);
    expect(comps.length).toBe(1);

    // (e) two scripted steps, two provider invocations — compaction is free.
    expect(f.model.doStreamCalls.length).toBe(2);

    // (a) the SECOND model call's prompt carries the digest, not the
    // original tool transcript — root + summary + nothing pre-compaction.
    const secondPrompt = JSON.stringify(f.model.doStreamCalls[1]?.prompt);
    expect(secondPrompt).toContain("events: ");
    expect(secondPrompt).toContain("task: do the thing");
    // The reconstructed chain: session_meta root first (F-177), then the
    // synthetic summary, then only post-compaction events.
    const chain = reconstruct(listEvents(f.db, f.sessionId));
    expect(chain[0]?.kind).toBe("session_meta");
    expect(chain[1]?.payload.compacted).toBe(true);
  });

  it("(b,h) one token below the tie appends nothing; the override is discriminating and telemetry keeps real usage", async () => {
    const f = fixture([
      toolCallResponse([{ id: "c1", name: "ls", input: { path: "." } }]),
      textResponse("done"),
    ]);
    // The entry alone WOULD fire on real usage (footprint 100, tie window) —
    // so a passing no-fire result proves the override was consulted (F-100
    // discriminating-fixture rule). 99×5 = 495 < 124×4 = 496 (F-088).
    f.deps.entry = { ...TEST_ENTRY, context_window: TIE_WINDOW };
    f.deps.autoCompactOverride = {
      usage: { tokens_in: 99, tokens_cache_read: 0, tokens_cache_write: 0 },
      contextWindow: 124,
    };
    const result = await runTurn(f.deps);
    expect(result.status).toBe("done");
    expect(compactions(f.db, f.sessionId).length).toBe(0);
    // The override drives the trigger ONLY — the step's telemetry row still
    // records the provider-reported classes, not the override's.
    const rows = f.db
      .query(
        "SELECT tokens_in, tokens_cache_read, tokens_cache_write FROM step_event WHERE session_id = ? ORDER BY rowid",
      )
      .all(f.sessionId) as Record<string, number>[];
    expect(rows[0]?.tokens_in).toBe(70);
    expect(rows[0]?.tokens_cache_read).toBe(20);
    expect(rows[0]?.tokens_cache_write).toBe(10);
  });

  it("(c) two over-threshold continue steps compact once each — never twice without an intervening step", async () => {
    const f = fixture([
      toolCallResponse([{ id: "c1", name: "ls", input: { path: "." } }]),
      toolCallResponse([{ id: "c2", name: "ls", input: { path: "." } }]),
      textResponse("done"),
    ]);
    f.deps.entry = { ...TEST_ENTRY, context_window: TIE_WINDOW };
    await runTurn(f.deps);
    const all = listEvents(f.db, f.sessionId);
    const comps = compactions(f.db, f.sessionId);
    expect(comps.length).toBe(2);
    // Between the two compactions an assistant_message (a model step) exists.
    const idx = (id: string) => all.findIndex((e) => e.id === id);
    const between = all.slice(
      idx(comps[0]?.id as string) + 1,
      idx(comps[1]?.id as string),
    );
    expect(between.some((e) => e.kind === "assistant_message")).toBe(true);
  });

  it("(d) the digest is byte-identical for identical chains and carries the four lines, tools sorted", () => {
    const ev = (
      kind: SessionEvent["kind"],
      payload: Record<string, unknown>,
      n: number,
    ): SessionEvent => ({
      id: `01ARZ3NDEKTSV4RRFFQ69G5FA${String.fromCharCode(65 + n)}`,
      session_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      parent_id: null,
      kind,
      payload,
      at: "2026-07-11T00:00:00.000Z",
      schema_version: 1,
    });
    const chain = [
      ev("session_meta", { system: "SYS" }, 0),
      // Embedded newline: excerpts collapse to one line so the four-line
      // frame survives re-compaction (a prior digest is multi-line).
      ev("user_message", { text: `find the\nbug ${"x".repeat(300)}` }, 1),
      ev(
        "assistant_message",
        { text: "", tool_calls: [{ name: "read" }, { name: "ls" }] },
        2,
      ),
      // session_meta bookkeeping is preserved, not folded — excluded from
      // the events: count (AGT-16/F-178).
      ev("session_meta", { obligation_check: { clause_id: "X-1" } }, 3),
      ev("assistant_message", { text: "it is in auth.ts" }, 4),
    ];
    const d1 = deterministicDigest(chain);
    const d2 = deterministicDigest([...chain]);
    expect(d1).toBe(d2);
    const lines = d1.split("\n");
    expect(lines.length).toBe(4);
    expect(lines[0]).toBe("events: 3");
    expect(lines[1]?.startsWith("task: find the bug ")).toBe(true);
    expect(lines[1]?.endsWith("…")).toBe(true);
    // 200 code units + "task: " prefix + trailing ellipsis
    expect(lines[1]?.length).toBe("task: ".length + 200 + 1);
    expect(lines[2]).toBe("last: it is in auth.ts");
    expect(lines[3]).toBe("tools: ls, read");
  });

  it("(f) an injected summarizer's text lands in the compaction event instead of the digest", async () => {
    const f = fixture([
      toolCallResponse([{ id: "c1", name: "ls", input: { path: "." } }]),
      textResponse("done"),
    ]);
    f.deps.entry = { ...TEST_ENTRY, context_window: TIE_WINDOW };
    f.deps.autoCompactSummarizer = () => "INJECTED SUMMARY";
    await runTurn(f.deps);
    const comps = compactions(f.db, f.sessionId);
    expect(comps.length).toBe(1);
    const payload = comps[0]?.payload.compaction as { summary: string };
    expect(payload.summary).toBe("INJECTED SUMMARY");
  });

  it("(i) the done-gate demotion tail is exempt; the injected instruction reaches the next call and gate memory survives compaction", async () => {
    const f = fixture([
      toolCallResponse([
        {
          id: "c1",
          name: "write",
          input: { path: "src/governed.ts", content: "// still wrong\n" },
        },
      ]), // step 1: obligation fails; over-threshold tail compacts
      textResponse("all set"), // step 2: done attempt → demoted (exempt tail)
      toolCallResponse([
        {
          id: "c2",
          name: "write",
          input: {
            path: "src/governed.ts",
            content: "const x = 'SENTINEL';\n",
          },
        },
      ]), // step 3: fix passes; over-threshold tail compacts
      textResponse("all set"), // step 4: done allowed
    ]);
    f.deps.rules = [{ tool: "write", action: "allow" }];
    seedSpec(f.db, f.dir);
    f.deps.spec = loadSpecContext(f.db, f.dir);
    f.deps.entry = { ...TEST_ENTRY, context_window: TIE_WINDOW };

    const result = await runTurn(f.deps);
    expect(result.status).toBe("done");

    // Steps 1 and 3 compact; the demotion tail (step 2) and the done tail
    // (step 4) do not.
    expect(compactions(f.db, f.sessionId).length).toBe(2);
    // The injected retry instruction survived to the next model call even
    // though step 1's compaction had already folded the transcript.
    const thirdPrompt = JSON.stringify(f.model.doStreamCalls[2]?.prompt);
    expect(thirdPrompt).toContain("Cannot finish");
    // Gate memory (obligation_check session_meta) survives both compactions
    // in the reconstructed chain — the F-178 regression arm.
    const checks = obligationChecks(reconstruct(listEvents(f.db, f.sessionId)));
    expect(checks.map((c) => c.status)).toEqual(["fail", "pass"]);
  }, 30_000);

  it("(g) a paused step over threshold never compacts and stays resumable", async () => {
    const f = fixture([
      toolCallResponse([
        { id: "c1", name: "bash", input: { command: "echo hi" } },
      ]),
    ]);
    f.deps.entry = { ...TEST_ENTRY, context_window: TIE_WINDOW };
    const result = await runTurn(f.deps);
    expect(result.status).toBe("paused");
    expect(compactions(f.db, f.sessionId).length).toBe(0);
    // The pending call is still reachable — compaction would have folded it.
    const chain = reconstruct(listEvents(f.db, f.sessionId));
    expect(pendingToolCalls(chain).length).toBe(1);
  });
});
