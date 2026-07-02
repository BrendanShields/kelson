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
└── suites/              # eval suites (community packs: staging-only, LOOP-6)
```

`pack.yaml`:

```yaml
schema_version: 1
name: ponytail            # kebab-case, unique in registry
version: 1.2.0            # semver (rules in §3)
kind: efficiency          # stage|efficiency|spec_tooling|routing|eval_suite|agent_registry
kernel_compat: ">=0.1 <2" # semver range of the Kelson kernel
capabilities:             # closed enum — the SEC-4 surfaces this pack may influence
  - rules
description: One line.
```

**Capability enum (closed):** `stage:feedback`, `stage:ideation`, `stage:planning`, `stage:spec`, `stage:build`, `stage:verify`, `rules`, `routing-table`, `agent-registry`, `eval-suite`. A pack whose content directory implies a surface absent from `capabilities` is refused at load (SEC-4); adding a capability in an update is always a **major** version (§3).

- **PACK-1.** The pack loader shall map each content directory to its required capability (`skills/`+`rules/`→`rules` or a `stage:*`, `routing/`→`routing-table`, `agents/`→`agent-registry`, `suites/`→`eval-suite`) and shall refuse any pack whose content implies an undeclared capability, naming the file and the missing capability.
  *Obligation:* fixture matrix per directory type (extends SEC-4's obligation with the concrete mapping).

## 2. Hashing & Signing

- **Content hash:** SHA-256 over the pack's files in path-sorted order, each contributing `path + "\0" + bytes`; manifest included. Canonical JSON (RFC 8785) wherever JSON is hashed.
- **Signature:** Ed25519 detached signature over the content hash (`pack.sig`), key published in the registry repo's `keys/` directory (ADR-0003). `kelson` verifies at install; unsigned installs require an explicit `--unsigned` flag that marks the pack untrusted in telemetry.

- **PACK-2.** The pack installer shall recompute the content hash, verify the Ed25519 signature against the registry-published key, and refuse mismatches; packs installed with `--unsigned` shall carry an `untrusted` flag on every telemetry event they influence.
  *Obligation:* tamper test — one flipped byte in any file fails install; an `--unsigned` fixture's step events carry the flag.

## 3. Semver Rules (mechanical, checked by `kelson pack lint`)

| Change | Bump |
|---|---|
| Capability added, entry removed/renamed, kernel_compat narrowed | **major** |
| Entry added, entry content changed with same surface | **minor** |
| Typo/metadata-only (no content-hash change to entries) | **patch** |

- **PACK-3.** `kelson pack lint` shall compute the required bump by diffing manifests and entry hashes against the previous published version and shall fail CI when the declared version bump is lower than required.
  *Obligation:* fixture pairs per table row — each change class yields the required bump; an under-bumped fixture fails.

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

Lockfile hash = SHA-256 of its RFC 8785 canonical form, excluding `parent_hash` (so the hash identifies configuration content, and `parent_hash` chains history). Sessions pin this hash at start (LOOP-7); eval results record it (EVAL-4); proposals apply as parent→child transitions (LOOP-2 one-command revert = restore parent).

- **PACK-4.** Lockfile hashing shall be canonical: semantically identical lockfiles (key order, whitespace) produce identical hashes, and any entry change produces a different hash.
  *Obligation:* PBT — hash invariant under key/array-formatting permutations that preserve content; sensitive to every field mutation.

## 5. Changelog (`.kelson/changelog.jsonl`, append-only, git-tracked)

One JSON object per line: `{seq, at, action: apply|revert|human_change, proposal_id, lockfile_before, lockfile_after, evidence_summary}`. Invariant I5 (append-only) is enforced by the writer (seq must equal last+1) and by CI (a PR that rewrites an existing line fails).

- **PACK-5.** The changelog writer shall refuse any operation other than appending seq = last+1, and repository CI shall fail if an existing changelog line differs from its content on the merge base.
  *Obligation:* unit test (gap/rewrite refused) + CI script fixture (tampered history fails).

## 6. Registry (v1: a git repo)

The registry is a public git repository: `packs/<name>/<version>/` (manifest + hash + sig, not content — content lives in the pack's own repo/tarball URL recorded in the manifest), `keys/<name>.pub`, and `ledger/` (EVT-3 entries). Publishing = PR passing the OSS-4 contribution gate (reproducible ablation + SEC-5 scan). No registry server in v1; `kelson` reads the repo raw. This keeps trust auditable (git history is the audit log) and infrastructure at zero.

- **PACK-6.** `kelson pack publish` shall produce a registry PR containing manifest, content hash, signature, and the eval-run manifest hash backing its ledger entry, and the registry CI shall reject submissions missing any of the four.
  *Obligation:* CI contribution-gate test (extends OSS-4's) with per-artifact omission fixtures.
