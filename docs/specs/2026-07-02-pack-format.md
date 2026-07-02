# Spec: Pack Format, Lockfile & Registry

- **Status:** Draft for review
- **Date:** 2026-07-02
- **Upstream:** [PRD §5.3, §9, §14.2](./2026-07-02-agent-harness-prd.md) (SEC-4..6, LOOP-*, OSS-3/4), [ERD §4](./2026-07-02-agent-harness-erd.md)
- **Clause family:** `PACK-*`

## 1. Pack Layout

```
my-pack/
├── pack.yaml            # manifest (normative Zod schema in packages/schemas)
├── skills/              # prompt fragments / skill files
├── rules/               # behavior rules (e.g. comment suppression)
├── routing/             # routing table fragments (structure only — weights live in SQLite)
├── agents/              # agent registry entries
├── context/             # context-compiler heuristics (PRD §12.1 / CTX-2)
└── suites/              # eval suites (community packs: staging-only, LOOP-6)
```

Content paths are POSIX-style (`/`-separated) everywhere they are mapped, hashed, or recorded — loaders on other platforms normalize before use.

`pack.yaml`:

```yaml
schema_version: 1
name: ponytail            # kebab-case, unique in registry
version: 1.2.0            # semver (rules in §3)
kind: efficiency          # stage|efficiency|spec_tooling|routing|eval_suite|agent_registry
kernel_compat: ">=0.1 <2" # semver range of the Kelson kernel (grammar below)
capabilities:             # closed enum — the SEC-4 surfaces this pack may influence
  - rules
description: One line.
```

**Capability enum (closed):** `stage:feedback`, `stage:ideation`, `stage:planning`, `stage:spec`, `stage:build`, `stage:verify`, `rules`, `routing-table`, `agent-registry`, `eval-suite`, `context-assembly`. A pack whose content directory implies a surface absent from `capabilities` is refused at load (SEC-4); adding a capability in an update is always a **major** version (§3).

- **PACK-1.** The pack loader shall map each content path to its required capability by this deterministic rule: `rules/**` → `rules`; `skills/<stage>/**` → that `stage:*` (a skill file directly under `skills/` is a layout error, refused); `routing/**` → `routing-table`; `agents/**` → `agent-registry`; `context/**` → `context-assembly`; `suites/**` → `eval-suite`. Neither `rules` nor a `stage:*` declaration substitutes for the other. The loader shall refuse any pack whose content implies an undeclared capability, naming the file and the missing capability. Paths the rule does not map — other than `pack.yaml` and `pack.sig` — are layout errors, refused naming the file (fail-closed: an unmappable path is an unknown surface under SEC-4). The loader shall validate `kernel_compat` as a semver range and refuse manifests where it is not one. The accepted range grammar (v1) is comparator sets — each comparator an optional `>=`, `<=`, `>`, `<`, `~`, `^`, or `=` prefix on a full, partial, or `x`/`*` version — space-joined within a set, sets joined by `||`; hyphen ranges (`1.2 - 2.0`) and build metadata are not accepted in v1.
  *Obligation:* fixture matrix per path rule including the top-level-skill layout error, a rules-only pack declaring only a stage capability (refused), an unmapped-path fixture (refused), and a non-range `kernel_compat` fixture (refused) — extends SEC-4's obligation with the concrete mapping.

## 2. Hashing & Signing

- **Content hash:** SHA-256 over the pack's files in path-sorted order, each contributing `path + "\0" + bytes`; manifest included, `pack.sig` excluded (the signature cannot cover itself). Canonical JSON (RFC 8785) wherever JSON is hashed.
- **Signature:** Ed25519 detached signature over the content hash (`pack.sig`), key published in the registry repo's `keys/` directory (ADR-0003). `kelson` verifies at install; unsigned installs require an explicit `--unsigned` flag that marks the pack untrusted in telemetry.

- **PACK-2.** The pack installer shall recompute the content hash, verify the Ed25519 signature against the registry-published key, and refuse mismatches; packs installed with `--unsigned` shall carry an `untrusted` flag on every telemetry event they influence.
  *Obligation:* tamper test — one flipped byte in any file fails install; an `--unsigned` fixture's step events carry the flag.

## 3. Semver Rules (mechanical, checked by `kelson pack lint`)

| Change | Bump |
|---|---|
| Capability added, entry removed/renamed, kernel_compat narrowed | **major** |
| Entry added, entry content changed with same surface | **minor** |
| Typo/metadata-only (no content-hash change to entries) | **patch** |

- **PACK-3.** `kelson pack lint` shall compute the required bump by diffing manifests and entry hashes against the previous published version — capabilities or kind changed → major; any content hash changed → minor; manifest-metadata-only → patch — and shall fail CI when the declared version bump is lower than required.
  *Obligation:* fixture pairs per table row — each change class yields the required bump; an under-bumped fixture fails.

## 3.1 Capability surfaces (normative for SEC-4)

"Content addresses a surface" is decided by **path prefix only** — file contents are never inspected (a rules file that *talks about* routing cannot *influence* routing through any harness mechanism; text-sniffing would make loading nondeterministic across wording):

| Path prefix | Surface |
|---|---|
| `routing/**` | `routing-table` |
| `agents/**` | `agent-registry` |
| `rules/**` | `rules` |
| `suites/**` | `eval-suite` |
| `context/**` | `context-assembly` |
| `stages/<name>/**` | `stage:<name>` (name must be in the closed stage set; unknown names can never be declared, so they can never load) |
| `README.md`, `LICENSE`, `CHANGELOG.md`, `docs/**` | no surface (documentation allowlist — invisible to the check) |
| anything else | **refused fail-closed** (PACK-1): an unmappable path is an unknown surface |

Declared capabilities are a **ceiling**: declared-but-absent content is legal (an empty pack with `capabilities: []` is valid and inert). Excess = addressed − declared; non-empty excess refuses the load **atomically** with a diagnostic naming every excess surface and one example path each. (Pinned after divergence testing: both blind readers converged on exactly this table.)

## 4. Lockfile (`kelson.lock`, in the target repo, git-tracked)

```json
{
  "schema_version": 1,
  "parent_hash": "sha256:…",
  "entries": [
    { "name": "ponytail", "version": "1.2.0", "hash": "sha256:…", "enabled": true }
  ]
}
```

Lockfile hash = SHA-256 of its RFC 8785 canonical form, excluding `parent_hash` (so the hash identifies configuration content, and `parent_hash` chains history). Sessions pin this hash at start (LOOP-7); eval results record it (EVAL-4); proposals apply as parent→child transitions; revert per LOOP-2 creates a new child that removes exactly the reverted diff (it equals the old parent hash only when no later diff intervened).

- **PACK-4.** Lockfile hashing shall be canonical: semantically identical lockfiles (key order, whitespace) produce identical hashes, and any entry change produces a different hash.
  *Obligation:* PBT — hash invariant under key/array-formatting permutations that preserve content; sensitive to every content field mutation (`parent_hash` excluded — it chains history, per this section).

## 5. Changelog (`.kelson/changelog.jsonl`, append-only, git-tracked)

One JSON object per line: `{seq, at, action: apply|revert|human_change, proposal_id, lockfile_before, lockfile_after, evidence_summary}`. Invariant I5 (append-only) is enforced by the writer (seq must equal last+1) and by CI (a PR that rewrites an existing line fails).

- **PACK-5.** The changelog writer shall refuse any operation other than appending seq = last+1, and repository CI shall fail if an existing changelog line differs from its content on the merge base.
  *Obligation:* unit test (gap/rewrite refused) + CI script fixture (tampered history fails).

## 6. Registry (v1: a git repo)

The registry is a public git repository: `packs/<name>/<version>/` (manifest + hash + sig, not content — content lives in the pack's own repo/tarball URL recorded in the manifest), `keys/<name>.pub`, and `ledger/` (EVT-3 entries). Publishing = PR passing the OSS-4 contribution gate (reproducible ablation + SEC-5 scan). No registry server in v1; `kelson` reads the repo raw. This keeps trust auditable (git history is the audit log) and infrastructure at zero.

- **PACK-6.** `kelson pack publish` shall produce a registry PR containing manifest, content hash, signature, and the eval-run manifest hash backing its ledger entry, and the registry CI shall reject submissions missing any of the four.
  *Obligation:* CI contribution-gate test (extends OSS-4's) with per-artifact omission fixtures.
