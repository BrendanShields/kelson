# Kelson Privacy Policy

## Local-first, always (TEL-2)

Every telemetry event Kelson records — sessions, step events, routing decisions, budget events, eval results — is stored **only** in a local SQLite database (`~/.kelson/kelson.db`) and local files under your repo's `.kelson/` directory. Nothing is transmitted off your machine unless you explicitly opt in. There is no default endpoint, no phone-home, and the kernel's test suite structurally bans network modules from every telemetry path (the single exception, the OTel exporter below, performs IO only when you hand it an endpoint).

## What sharing means when you opt in (TEL-3, OSS-2)

Opt-in sharing (the OTel exporter, or any future shared-telemetry channel) sends only the **published shared schema** — `SharedStepEvent` and `SharedSessionEvent` in `packages/schemas/src/shared.ts`, versioned via `schema_version`. The schema is structurally incapable of carrying free text: every field is a number, a closed enum, or a format-pinned identifier (ULIDs, model-id patterns, ISO timestamps). Source code content, file paths, prompt text, error messages, and rule text have **no destination field** — stripping is a whitelist projection into this schema, enforced by schema validation, not by filtering.

Shared, when you opt in: token counts per class, cost in micro-USD, SDLC step names, model identifiers, effort levels, budget/overrun categories, session status, timestamps.

Never shared, under any configuration: code, diffs, file paths, prompts, transcripts, rule/pack text, findings text, spec content, repository names beyond your own configuration, environment variables, credentials.

## The OTel exporter (TEL-6)

Off by default. `exportSessionOtel(db, sessionId, endpoint)` projects one session as one trace with one span per step, attributes drawn exclusively from the shared schema above. It runs only when invoked with an explicit endpoint; no configuration flag silently enables it.

## Snapshots and replay (EVP §4)

Session snapshots (git bundles for counterfactual replay) live under `~/.kelson/snapshots/` and never leave your machine. They may contain your repository content — they exist so *your* harness can replay *your* sessions locally.

## Eval ledger entries (EVT-3)

Ledger entries (`ledger/<pack>/<version>.json`) are git-tracked in your repository and contain only statistics: verdicts, effect sizes, confidence intervals, sample sizes, and a run-manifest hash. Publishing them anywhere is a git push you perform yourself.
