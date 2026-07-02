# Spec: Kelspec — the Spec DSL

- **Status:** Draft for review
- **Date:** 2026-07-02
- **Upstream:** [PRD §7](./2026-07-02-agent-harness-prd.md) (SPEC-1..8). Resolves PRD resolved-question 2.
- **Clause family:** `DSL-*`

## 1. Format Decision

A kelspec is a **Markdown file containing fenced `kelspec` YAML blocks**, stored in the target repo at `docs/kelspec/<component>.spec.md`. Markdown carries the human narrative (context, rationale, diagrams); the fenced blocks carry every machine-read clause. The spec compiler parses only the fenced blocks; prose is never load-bearing.

Why this shape: PRs review it like prose (UX-P6), one YAML grammar keeps the parser trivial, and narrative-next-to-clause keeps rationale from drifting away from requirements. A dedicated file format was rejected (new tooling for zero expressive gain); pure YAML was rejected (rationale gets deleted or exiled to comments).

- **DSL-1.** The spec compiler shall treat fenced `kelspec` blocks as the sole source of clauses, and shall reject a spec file whose blocks fail schema validation, reporting file, block index, and field path per error.
  *Obligation:* golden corpus — malformed blocks (bad enum, missing field, wrong type) each produce an error naming the exact field path; prose-only files parse as empty specs without error.

## 2. Block Grammar

Each block declares one of: `component`, `domain`, `clause`, or `invariant`. Zod schemas in `packages/schemas` are the normative grammar (this section is their rendering; on any discrepancy the Zod schema wins and this doc must be fixed via spec-sync).

### 2.1 `component` — one per spec file, first block

```yaml
kind: component
id: rate-limiter            # kebab-case, unique per repo
tier: T1                    # T0|T1|T2 — floor; compiler may raise per SPEC-6, never lower
authority: authored         # authored|inferred|confirmed (SPEC-7)
state:                      # persistent state variables (drives SPEC-6 tier escalation)
  - name: window_counts
    mutated_by: [request_received, window_rolled]
domains_of_concern: []      # e.g. [money, security, data_loss] — any entry forces T2
```

### 2.2 `domain` — named value spaces; generators derive from these (SPEC-2)

```yaml
kind: domain
id: RequestRate
type: int                   # int|float|string|enum|struct|list|map
unit: requests_per_minute   # required for numeric domains
min: 0
max: 100000
```

`string` domains take `pattern` (RE2 syntax) and/or `max_length`; `enum` takes `values`; `struct` takes `fields` (name → domain ref); `list` takes `of` + `max_items`; `map` takes `keys`/`values` domain refs. Every constraint is generator-facing: the compiler derives a fast-check arbitrary from exactly these fields.

- **DSL-2.** The spec compiler shall derive a property-based generator from every domain block such that all generated values satisfy the domain's declared constraints, and shall reject numeric domains lacking `unit` or bounds.
  *Obligation:* PBT-of-PBT (extends SPEC-2's) — for each domain fixture, 10,000 sampled values all satisfy the constraints; a boundless numeric domain is rejected at compile.

### 2.3 `clause` — one EARS requirement

```yaml
kind: clause
id: RL-1                    # <FAMILY>-<n>; family unique per component; IDs immutable
ears: event                 # ubiquitous|event|state|unwanted|optional
trigger: request_received   # required for event/unwanted; must name a declared event
text: >
  When a request arrives and the caller's window count equals the limit,
  the rate limiter shall reject the request with retry_after set to the
  window remainder.
inputs:  { rate: RequestRate }        # named domain refs usable in `check`
observe: [response.status, response.retry_after, window_counts]  # observable surface
check: |                              # TypeScript predicate — the executable obligation
  (ctx) => ctx.when(ctx.count === ctx.rate)
             .expect(ctx.response.status === 429
                  && ctx.response.retry_after === ctx.windowRemainder)
nondeterministic: []        # observable fields excluded from divergence comparison
unverifiable: null          # or { signed_by: <human>, reason: <text> } per SPEC-3
```

The `check` predicate is a TypeScript arrow function over a typed context whose bindings come from `inputs` + `observe`. The compiler wraps it in a fast-check property using the derived generators. This is the **compile-to-obligation rule made concrete**: no parseable `check` (and no signed `unverifiable`) → the clause is vague → the spec is rejected (SPEC-1).

- **DSL-3.** The spec compiler shall compile every clause's `check` predicate into an executable property over the clause's declared inputs and observables, and shall reject clauses whose predicate references anything outside those declarations.
  *Obligation:* fixture matrix — an out-of-scope reference (undeclared variable) is a compile error naming the variable; compiled fixtures execute under `bun test` and fail when the implementation is mutated to violate them.
- **DSL-4.** If a clause omits `check` and carries no signed `unverifiable` annotation, then the spec compiler shall reject the spec listing that clause ID (implements SPEC-1/SPEC-3 at the grammar level).
  *Obligation:* covered by SPEC-1's golden corpus, extended with grammar-level fixtures.

### 2.4 `invariant` — must hold in every reachable state

```yaml
kind: invariant
id: RL-INV-1
text: The sum of window counts never exceeds limit × active_callers.
over: [window_counts]       # state variables quantified over
check: |
  (s) => sum(s.window_counts.values()) <= s.limit * s.window_counts.size
model: tla/RateLimiter.tla  # required at T1+ — the formal model file (SPEC-6 rigor ladder)
```

- **DSL-5.** While a component is tier T1 or above, the spec compiler shall require every invariant to reference a formal model file that exists and model-checks in CI, and shall require the TypeScript `check` to be registered as a runtime conformance probe for PIPE-7 continuous verification.
  *Obligation:* integration test — a T1 fixture with a missing/failing model is rejected; the probe registry contains one entry per T1+ invariant after compile.

## 3. Traceability Binding

Clause IDs are the join key everywhere: obligation test files (`test/obligations/<ID>.test.ts`), TRACE_LINK rows (ERD §3), commit messages, and drift events. A kelspec file's content hash is the ARTIFACT hash; each fenced block hashes independently so clause-level staleness (ART-2) works without whole-file churn.

- **DSL-6.** The spec compiler shall emit, for every compiled spec, a manifest mapping each clause ID to its block hash, obligation target, and tier, and the artifact store shall ingest this manifest as clause-level artifacts.
  *Obligation:* round-trip test — editing one block changes exactly that clause's hash in the manifest and flags exactly its downstream trace links.

## 4. Complete Example

`docs/kelspec/rate-limiter.spec.md` in a target repo would contain the §2 blocks above plus narrative. The compiler output: 1 component, 1 domain, 1 clause → 1 fast-check property, 1 invariant → 1 runtime probe + 1 TLA+ CI obligation, and a manifest with 4 hashed entries. This example is normative test fixture #1 for the Phase 1 compiler (`packages/kernel/test/fixtures/DSL/rate-limiter.spec.md`).

## 5. What Kelspec Does Not Do (v1)

- No cross-component clauses (compose at the component boundary; a clause naming two components is a compile error — split it or lift it to a new component).
- No temporal-logic operators in `check` (that's what the `model` file is for; TypeScript predicates stay state-at-a-point).
- No custom EARS forms beyond the five.
