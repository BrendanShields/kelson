---
name: obligation-test
description: Compile a Kelson spec clause's *Obligation:* line into an executable test. Use whenever writing tests for this repo — any bun-test/fast-check test, any time a PRD/UX clause (TEL-*, EVAL-*, RTR-*, ART-*, SPEC-*, PIPE-*, LOOP-*, CTX-*, SEC-*, OSS-*, UX-*, DSL-*, PACK-*, EVP-*, RPOL-*, SIG-*, AGT-*, PERM-*, SES-*, PROV-*) needs its obligation implemented, when asked to "add tests" for kernel/CLI code, or when a new clause lands via spec-sync and has no test yet. Tests in this repo are obligation tests first; don't write ad-hoc test files without checking which clause they discharge.
---

# Obligation Test

Every behavioral requirement in the spec suite carries an `*Obligation:*` line naming its executable check. This skill turns that line into a test with a stable, greppable link back to the clause.

## Conventions

- **Location & naming:** `packages/<pkg>/test/obligations/<CLAUSE-ID>.test.ts` — one file per clause (e.g. `packages/kernel/test/obligations/TEL-1.test.ts`). The filename IS the trace link; `kelson` tooling will later parse it (ERD §3 Obligation.target_ref).
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

**State machine conformance (LOOP-5):** generate action sequences from the model's transitions, drive the implementation, assert same end state. (TLA+ model checking itself runs in CI, not bun test.)

## Working rules

- Read the clause AND its obligation from the spec doc before writing — the obligation text defines pass/fail, not your intuition. If the obligation is untestable as written, that's a spec bug: fix it via the spec-sync skill first.
- **Arbitrary domain = valid domain, exactly.** Generators must produce the clause's full valid input domain and nothing outside it. Wider (arb generates inputs the schema shouldn't accept) makes the property seed-dependent; narrower hides real inputs. A PBT that fails only on CI means seed-dependent truth: suspect arb/schema domain mismatch first, and treat the failure as a finding to record, never a flake to re-run (postmortem: F-039 — a CI seed generated `__proto__`, exposing a silent data drop local runs never hit).
- **Coincidence triggers get pinned examples.** If a property's triggering condition is a coincidence between independently generated values (equality of two draws, an exact sum), random generation makes falsification seed-dependent — the test passes or fails by luck. Pin the triggering case as an explicit fc `examples` entry so the boundary is exercised every run (postmortem: F-042 — `count === rate` over 0..100000 fired on one gate run and not the next).
- **"Recorded" means read it back.** When a clause requires data to be recorded/persisted (an override, an attribution, an audit field), the test must read the stored values back out and assert them — asserting only a state flag structurally cannot catch a data drop (postmortem: F-043 — buildGate discarded `override.{by,reason}` while the test checked only `resolution`; the clause-auditor caught what the test couldn't).
- **Boundary clauses cover every crossing path.** When a clause guards a boundary (env isolation, write surface, network), the test must cover every code path that crosses it — grep the call sites. Testing one representative path while another bypasses the property is the self-referential pattern (postmortem: F-031, F-046 — SEC-1's temp-HOME test exercised `ws.exec` while `claudeExecutor` bypassed it unobserved).
- **Same function twice is no verification.** If the test's expected value comes from the same function the implementation used, on the same input, the assertion is `|x−x|=0` and discharges nothing (postmortem: F-064 — CTX-1's "actual" was the implementation's own countTokens call on the implementation's own string). Derive the expected value by a different decomposition of the same quantity.
- **Carry a `// revert-check:` line, and make it true.** Every guard/fixture test states, as a comment, which assertion on which line fails if the fix is mentally reverted — e.g. `// revert-check: drop the NO_COLOR check in theme.ts → line 71 (ANSI-present assertion) fails`. Writing the line forces the revert-reasoning the discriminating-fixture rule (CLAUDE.md rule 7) mandates but which is easy to skip at write time; a revert-check that names an assertion that *wouldn't* actually fail is itself the bug. This exists because the rule kept not self-triggering: F-100 (survival clock), then F-101 (NO_COLOR asserted only never-coloring renderers) and F-108 (resolver tested, its server wiring not) — three unfailable/non-discriminating fixtures across two sessions, each caught only by the auditor. `test_blindspot` is the #3 root cause in the findings log.
- **Hand-authored ULID fixtures use Crockford base32 — no `I L O U`.** A literal like `01JZUX13…` contains `U`, fails the `Ulid` schema regex `[0-9A-HJKMNP-TV-Z]`, and surfaces downstream as a 500 / undefined field rather than a clear error (cost a confusing retry this session). Derive from a valid seed or use only `0-9 A-H J K M N P-T V-Z`.
- **Proxies name their assumption.** An obligation test deliberately stronger than its clause (a proxy) must say so in a comment naming the assumption it encodes. When a later phase legitimately breaks the assumption, narrow the proxy in spec terms — never treat the collision as a regression or gut the check (postmortem: TEL-2's kernel-wide no-spawn scan vs. SEC-1's sandbox).
- **Check whether `<CLAUSE-ID>.test.ts` already exists before writing it** — earlier phases may own it; extend in place, never Write over it (a Phase 0 OSS-6 test was clobbered and recovered from git).
- **Synthetic clocks collide with wall-clock writes.** Simulation tests that inject synthetic timestamps break against code writing `new Date()` (the changelog's `at` vs synthetic session times in the LOOP-3 starved-stratum case) — align the fixture to the real writes or make the code's clock injectable before asserting time-windowed behavior.
- A PR that implements clause X without `<X>.test.ts` is incomplete — the clause-auditor agent will flag it.
- Don't pad: one obligation line = one focused test file. Coverage beyond the obligation belongs to ordinary tests, added only when there's a concrete failure mode to pin.
