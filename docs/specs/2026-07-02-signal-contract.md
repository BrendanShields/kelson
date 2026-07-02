# Spec: Signal Ingestion Contract

- **Status:** Draft for review
- **Date:** 2026-07-02
- **Upstream:** [PRD §8.1, §8.7](./2026-07-02-agent-harness-prd.md) (PIPE-1, PIPE-10). This is the published contract external systems implement; Kelson never needs to know the producer.
- **Clause family:** `SIG-*`

## 1. Schema (v1 — JSON; normative Zod schema in `packages/schemas`, JSON Schema exported from it)

```json
{
  "schema_version": 1,
  "source": "github-actions/deploy",
  "kind": "incident",
  "severity": "error",
  "occurred_at": "2026-07-02T10:15:00Z",
  "summary": "Checkout API 5xx spike after v2.3.1 deploy",
  "evidence": [
    { "type": "url", "value": "https://grafana.example/d/abc" },
    { "type": "text", "value": "5xx rate 4.2% for 11 minutes, rolled back" }
  ],
  "artifact_refs": ["docs/kelspec/checkout.spec.md#CHK-3"],
  "dedupe_key": "deploy-v2.3.1-5xx"
}
```

Field rules:

- `kind` (closed enum, v1): `deploy_outcome` | `incident` | `slo_breach` | `error_cluster` | `user_feedback` | `custom`.
- `severity` (closed enum): `info` | `warn` | `error` | `critical`.
- `summary`: required, ≤ 500 chars — the triage line.
- `evidence`: ≥ 1 entry; `type` ∈ `url` | `text`; `text` values ≤ 4,000 chars.
- `artifact_refs`: optional repo-relative paths, `#<clause-id>` fragment allowed; unresolvable refs are kept but flagged (a signal about deleted code is still a signal).
- `dedupe_key`: optional; signals sharing a key within 24h collapse into one inbox item with an occurrence count.
- Unknown fields: **preserved and ignored** (forward compatibility).

- **SIG-1.** The signal ingester shall accept any JSON document validating against the v1 schema, apply the dedupe rule, and normalize it into a SIGNAL row plus an inbox item (PIPE-1), preserving unknown fields verbatim in the stored payload.
  *Obligation:* contract tests from synthetic producers (extends PIPE-10's): valid fixtures for every `kind`; each field-rule violation rejected with a field-path diagnostic; dedupe fixture collapses; unknown-field fixture round-trips.

## 2. Delivery (v1: files, no server)

Producers write one JSON file per signal to `.kelson/signals/inbox/` in the target repo (or pipe to `kelson signals ingest -`). The harness ingests on session start and on `kelson signals ingest`, moving processed files to `.kelson/signals/processed/<ULID>.json`. Local-first (TEL-2 discipline): no listener, no port, nothing to secure. A webhook receiver is a post-v1 companion concern (PRD §8.7) — it would translate to these files, so the contract doesn't change.

- **SIG-2.** The ingester shall process inbox files idempotently: re-ingesting an already-processed file (same content hash) shall create no duplicate SIGNAL row.
  *Obligation:* integration test — double ingestion of the same file and of a byte-identical copy yields one row.

## 3. Versioning Rules

- **Additive** (new optional field, new enum value in an open position) → minor; consumers ignore what they don't know.
- **Breaking** (field removed/renamed/retyped, closed-enum value removed, semantics changed) → `schema_version` increments; Kelson supports the previous major for ≥ 2 kernel minor releases with a migration note in the changelog.
- The exported JSON Schema is published in the registry repo and versioned with this spec; OSS-6's no-silent-coercion rule applies to cross-version signal reads.

- **SIG-3.** If a signal declares an unsupported `schema_version`, then the ingester shall park it in `.kelson/signals/unsupported/` with a diagnostic rather than guess, and shall surface a count in `kelson signals inbox`.
  *Obligation:* fixture with `schema_version: 99` — parked, counted, never a SIGNAL row.
