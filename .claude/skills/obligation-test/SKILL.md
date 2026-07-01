---
name: obligation-test
description: Compile a Keel spec clause's *Obligation:* line into an executable test. Use whenever writing tests for this repo — any vitest/fast-check test, any time a PRD/UX clause (TEL-*, EVAL-*, RTR-*, ART-*, SPEC-*, PIPE-*, LOOP-*, CTX-*, SEC-*, OSS-*, UX-*) needs its obligation implemented, when asked to "add tests" for kernel/CLI code, or when a new clause lands via spec-sync and has no test yet. Tests in this repo are obligation tests first; don't write ad-hoc test files without checking which clause they discharge.
---

# Obligation Test

Every behavioral requirement in the spec suite carries an `*Obligation:*` line naming its executable check. This skill turns that line into a test with a stable, greppable link back to the clause.

## Conventions

- **Location & naming:** `packages/<pkg>/test/obligations/<CLAUSE-ID>.test.ts` — one file per clause (e.g. `packages/kernel/test/obligations/TEL-1.test.ts`). The filename IS the trace link; `keel` tooling will later parse it (ERD §3 Obligation.target_ref).
- **Describe block quotes the clause:**
  ```ts
  describe('TEL-1: session end emits one step record per SDLC step', () => { ... })
  ```
- **Multiple checks per obligation** (e.g. EVAL-2's accept/reject/underpowered cases) are `it()` blocks in the same file, not separate files.
- **Determinism:** fixed fast-check seeds only when reproducing a failure; otherwise let fast-check explore. Statistical obligations (EVAL-2) use fixed seeds and known distributions — they test the *math*, not randomness.

## Pattern by obligation kind

**PBT (fast-check):** derive generators from the ERD's domain constraints, assert the property.
```ts
it('parsing yields exactly N step records summing to transcript total', () => {
  fc.assert(fc.property(syntheticTranscript(), (t) => {
    const records = parseTranscript(t)
    expect(records).toHaveLength(t.stepBoundaries.length)
    expect(sum(records.map(r => r.tokensIn + r.tokensOut))).toBe(t.totalTokens)
  }))
})
```

**Fault-injection / integration:** arrange the failure (kill the collector, corrupt the store), assert the required degradation (KERN-1: session continues, degraded marker present, excluded from gates).

**Schema/permission (write-surface rules like RTR-5, LOOP-4):** attempt the forbidden write through the real API, assert rejection + audit entry. Never test these by inspecting prompts or docs — the PRD requires structural enforcement.

**Golden set with threshold (TEL-4, SEC-5):** fixture corpus in `test/fixtures/<CLAUSE-ID>/`, assert the rate (`≥ 0.9` agreement), and print the failing items on miss — threshold tests that fail silently are undebuggable.

**State machine conformance (LOOP-5):** generate action sequences from the model's transitions, drive the implementation, assert same end state. (TLA+ model checking itself runs in CI, not vitest.)

## Working rules

- Read the clause AND its obligation from the spec doc before writing — the obligation text defines pass/fail, not your intuition. If the obligation is untestable as written, that's a spec bug: fix it via the spec-sync skill first.
- A PR that implements clause X without `<X>.test.ts` is incomplete — the clause-auditor agent will flag it.
- Don't pad: one obligation line = one focused test file. Coverage beyond the obligation belongs to ordinary tests, added only when there's a concrete failure mode to pin.
