import type { Database } from "bun:sqlite";
import { Session, type SharedStepEvent, StepEvent } from "@kelson/schemas";
import { stripStepEvent } from "./privacy.ts";

// TEL-6: OFF by default — this module performs network IO only when the
// caller supplies an endpoint (the explicit opt-in TEL-2 requires); nothing
// in the harness calls it ambiently. Attributes are the TEL-3 shared
// projection, so content-stripping is structural, not filtered.
// (TEL-2's static network scan carries a named exemption for this file.)

const hexId = (ulid: string, bytes: number): string => {
  let hex = "";
  for (let i = 0; i < ulid.length && hex.length < bytes * 2; i++)
    hex += ulid.charCodeAt(i).toString(16).padStart(2, "0");
  return hex.slice(0, bytes * 2).padEnd(bytes * 2, "0");
};

const attr = (key: string, value: string | number) => ({
  key,
  value:
    typeof value === "number"
      ? Number.isInteger(value)
        ? { intValue: String(value) }
        : { doubleValue: value }
      : { stringValue: value },
});

const stepAttributes = (shared: SharedStepEvent) => [
  attr("kelson.sdlc_step", shared.sdlc_step),
  attr("kelson.model", shared.model),
  attr("kelson.effort", shared.effort),
  attr("kelson.tokens_in", shared.tokens_in),
  attr("kelson.tokens_out", shared.tokens_out),
  attr("kelson.tokens_cache_read", shared.tokens_cache_read),
  attr("kelson.tokens_cache_write", shared.tokens_cache_write),
  attr("kelson.cost_micro_usd", shared.cost_micro_usd),
  attr("kelson.budget_tokens", shared.budget_tokens),
  attr("kelson.overrun", shared.overrun),
];

export interface OtelExportResult {
  traces: number;
  spans: number;
  payload: unknown;
}

// One trace per session, one span per step event, OTLP/HTTP JSON.
export const exportSessionOtel = async (
  db: Database,
  sessionId: string,
  endpoint: string,
): Promise<OtelExportResult> => {
  const sessionRow = db
    .query("SELECT * FROM session WHERE id = ?")
    .get(sessionId) as Record<string, unknown> | null;
  if (!sessionRow) throw new Error(`unknown session: ${sessionId}`);
  const session = Session.parse(sessionRow);
  const steps = (
    db
      .query("SELECT * FROM step_event WHERE session_id = ? ORDER BY rowid")
      .all(sessionId) as Record<string, unknown>[]
  ).map((r) =>
    StepEvent.parse({ ...r, unit_prices: JSON.parse(r.unit_prices as string) }),
  );
  const traceId = hexId(session.id, 16);
  const startNs = `${Date.parse(session.started_at)}000000`;
  const endNs = `${Date.parse(session.ended_at ?? session.started_at)}000000`;
  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            attr("service.name", "kelson"),
            attr("kelson.session_status", session.status),
          ],
        },
        scopeSpans: [
          {
            scope: { name: "kelson" },
            spans: steps.map((step, i) => {
              const shared = stripStepEvent(step);
              return {
                traceId,
                spanId: hexId(step.id, 8),
                name: `kelson.step.${shared.sdlc_step}`,
                kind: 1,
                startTimeUnixNano: startNs,
                endTimeUnixNano: endNs,
                attributes: [
                  ...stepAttributes(shared),
                  attr("kelson.step_index", i),
                ],
              };
            }),
          },
        ],
      },
    ],
  };
  const res = await fetch(`${endpoint.replace(/\/$/, "")}/v1/traces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok)
    throw new Error(`OTLP export failed: ${res.status} ${await res.text()}`);
  return { traces: 1, spans: steps.length, payload };
};
