import { afterAll, describe, expect, it } from "bun:test";
import { exportSessionOtel } from "../../src/otel.ts";
import { openDb } from "../../src/storage.ts";
import { ulid } from "../../src/ulid.ts";

const MARKER = "XKELSON_SECRET_MARKERX";

const seedSessionWithSteps = (db: ReturnType<typeof openDb>): string => {
  const sessionId = ulid();
  db.query(
    `INSERT INTO session (id, repo, lockfile_hash, harness_version, schema_version, status, trace_id, started_at, ended_at)
     VALUES (?, 'r', ?, '0.1.0', 1, 'complete', NULL, ?, ?)`,
  ).run(
    sessionId,
    `sha256:${"a".repeat(64)}`,
    "2026-07-02T10:00:00Z",
    "2026-07-02T11:00:00Z",
  );
  for (const step of ["planning", "build", "verify"] as const)
    db.query(
      `INSERT INTO step_event (id, task_id, session_id, sdlc_step, model, effort, agent_id, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, unit_prices, cost_micro_usd, budget_tokens, overrun, span_id, schema_version)
       VALUES (?, ?, ?, ?, 'claude-sonnet-5', 'medium', ?, 100, 50, 0, 0, '{}', 1234, 20000, 'none', ?, 1)`,
    ).run(
      ulid(),
      ulid(),
      sessionId,
      step,
      // Free-text-capable fields carry planted content that must not export.
      `src/${MARKER}/impl.ts`,
      `prompt: ${MARKER}`,
    );
  return sessionId;
};

// OTLP collector fixture.
const received: unknown[] = [];
const collector = Bun.serve({
  port: 0,
  fetch: async (req) => {
    received.push(await req.json());
    return new Response("{}", { status: 200 });
  },
});
afterAll(() => collector.stop());

describe("TEL-6: opt-in OTel projection — one trace per session, one span per step, TEL-3-stripped attributes", () => {
  it("a session exports one trace with a span per step carrying token/cost attributes and no planted markers", async () => {
    const db = openDb(":memory:");
    const sessionId = seedSessionWithSteps(db);
    const result = await exportSessionOtel(
      db,
      sessionId,
      `http://localhost:${collector.port}`,
    );
    expect(result.traces).toBe(1);
    expect(result.spans).toBe(3);
    expect(received).toHaveLength(1);
    const payload = JSON.stringify(received[0]);
    expect(payload).not.toContain(MARKER);
    const doc = received[0] as {
      resourceSpans: {
        scopeSpans: {
          spans: { traceId: string; attributes: { key: string }[] }[];
        }[];
      }[];
    };
    const spans = doc.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
    expect(spans).toHaveLength(3);
    const traceIds = new Set(spans.map((s) => s.traceId));
    expect(traceIds.size).toBe(1);
    for (const span of spans) {
      const keys = span.attributes.map((a) => a.key);
      expect(keys).toContain("kelson.tokens_in");
      expect(keys).toContain("kelson.cost_micro_usd");
    }
    db.close();
  });

  it("off by default: nothing in the harness calls the exporter ambiently", async () => {
    // Structural: the only network-capable kernel module is otel.ts and its
    // single export requires an explicit endpoint argument.
    const src = await Bun.file(
      new URL("../../src/otel.ts", import.meta.url).pathname,
    ).text();
    expect(src).toContain("endpoint: string");
    const before = received.length;
    // Opening a db and running a session records nothing outbound.
    const db = openDb(":memory:");
    seedSessionWithSteps(db);
    db.close();
    expect(received.length).toBe(before);
  });
});
