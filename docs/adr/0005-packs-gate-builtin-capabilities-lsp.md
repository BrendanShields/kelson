# ADR-0005: Packs May Gate Built-in Runtime Capabilities (LSP the First)

- **Status:** Proposed (draft written at LSP planning; PIPE-4).
- **Date:** 2026-07-11
- **Traceability:** shapes [agent-runtime spec](../specs/2026-07-03-agent-runtime.md) (`AGT-17`, `AGT-18`), [PRD](../specs/2026-07-02-agent-harness-prd.md) (`EVT-2`, "every capability is a pack"), [pack-format spec](../specs/2026-07-02-pack-format.md) (`PACK-1` capability mapping)

## Context

opencode and Claude Code both ship LSP / code-intelligence: real compiler
diagnostics fed back after each edit, plus symbol lookup (definition, references,
type) that replaces broad file reads. Obligato's native loop has neither — the
eight core tools (AGT-4) are pure text. Of every base-agent capability the two
comparators have and we lack, this is the one whose thesis maps exactly onto both
north-stars: diagnostics-after-edit lift **FPAR** (fewer type-broken edits settle
as done), symbol lookup cuts **TPAC** (a definition jump replaces reading whole
files). So it is worth having — and, being efficiency-claimed, worth *proving*
rather than asserting.

The PRD's principle is "every capability is a pack" (EVT-2, §6.3) precisely so
efficiency claims are gate-proven. But the pack format (`PACK-1`, packs.ts
`requiredCapability`) maps file paths to capabilities **by directory** and
fail-closes on any unmappable path — there is no directory for runtime code.
Packs are declarative content (rules, routing tables, agent registries,
context-assembly config, eval suites) interpreted by fixed in-tree code paths. An
LSP client is native runtime code; **it cannot ship inside a content pack.**

Two ways to keep LSP ablatable without breaking the pack model:

1. **Generalize ablation** to a parallel "capability flag" mechanism outside
   packs. Contradicts "every capability is a pack" and adds a second ablation
   path the eval harness must learn.
2. **Ship the code in-tree but dormant**, activated only when a thin config-only
   pack is enabled in the session lockfile. The pack carries no code — just
   `context/lsp.yaml` (which servers, per language) — so it maps cleanly to the
   existing `context-assembly` capability and toggles through the existing
   lockfile `enabled` flag. `eval ablate lsp` then works unchanged (EVT-2).

## Decision

Choose (2): **a pack may gate a built-in runtime capability.** The capability's
code ships in `packages/agent` and stays dormant unless the session's pinned
lockfile enables a pack declaring it. LSP is the first such capability; its pack
is `kind: efficiency`, `capabilities: [context-assembly]`, shipping only
`context/lsp.yaml`.

| Concern | Choice | Why |
|---|---|---|
| Where LSP code lives | In-tree (`packages/agent`), dormant by default | It is native runtime code; packs carry no code (PACK-1) |
| Activation | Session's pinned lockfile enables the `lsp` pack | Reuses lockfile pinning (SES-4) + EVT-2 ablation with zero new machinery |
| Pack shape | Config-only: `pack.yaml` + `context/lsp.yaml` | Maps to `context-assembly` (PACK-1); LSP genuinely assembles code-intelligence context |
| Ablation | `eval ablate lsp` toggles the entry | No new ablation path — "every capability is a pack" stays literal |
| v1 language | TypeScript only (`typescript-language-server`) | Repo + bench are TS; prove the gate on one language, generalize later |

## Consequences

- A new coupling: enabling a pack now flips on a **subsystem**, not just feeds
  data to an existing code path. AGT-17 owns the activation semantics; the
  subsystem is best-effort — a missing server binary degrades to unregistered
  tools + skipped diagnostics, never a crash (KERN-1).
- The `context-assembly` capability now covers two unlike things (the CTX context
  compiler and LSP config). Accepted as honest — both assemble code context — but
  flagged for the clause-auditor to rule on whether LSP warrants its own
  capability value later (a closed-enum extension under SEC-4 if so).
- **The gate cannot run until a TypeScript-editing benchmark suite exists** (none
  does today). Building that suite is a sequenced prerequisite to a real
  `ablate lsp` verdict; the AGT-17/18 behavior lands and is dogfoodable on this
  repo before the verdict.
- Symbol-lookup tools are read-only and join the PERM-1 default-allow set,
  widening it beyond the four current read-only tools.
- Rejected alternative (1) is recorded so a future contributor does not add a
  second ablation path: if a runtime capability ever genuinely cannot be
  expressed as a config-only pack, revisit here — do not fork ablation silently.
