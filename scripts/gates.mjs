#!/usr/bin/env node
// Single entry point for every gate — used identically by CI and by manual
// runs when hooks aren't active. A gate not in this list doesn't exist.
import { execSync } from 'node:child_process'

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
const run = (cmd, opts = {}) => execSync(cmd, { cwd: root, stdio: 'inherit', ...opts })
const gates = []
const gate = (name, fn) => gates.push([name, fn])

gate('doctor', () => run('node scripts/doctor.mjs'))
gate('spec-lint', () =>
  run(`echo '{"tool_input":{"file_path":"docs/specs/gates.md"}}' | node .claude/hooks/spec-lint.mjs`))
gate('kelspec-lint', () => {
  const files = execSync(`find . -name '*.spec.md' -not -path './node_modules/*'`, { cwd: root })
    .toString().trim().split('\n').filter(Boolean)
  for (const f of files)
    run(`echo '{"tool_input":{"file_path":"${f}"}}' | node .claude/hooks/kelspec-lint.mjs`)
})
gate('schema-consistency', () => run('node scripts/schema-consistency.mjs'))
gate('typecheck', () => run('bunx tsc --noEmit'))
gate('biome', () => run('bunx biome check .'))
gate('test', () => {
  const hasTests = execSync(`find packages -name '*.test.ts' | head -1`, { cwd: root }).toString().trim()
  if (hasTests) run('bun test')
  else console.log('test: no test files yet (skipped until P0-2)')
})
// the SPA build is a gate so a publish can never ship stale/broken assets (UX §8)
gate('ui-build', () => run('bun run --cwd packages/ui build'))

let failed = 0
for (const [name, fn] of gates) {
  try { fn(); console.log(`gate ${name}: PASS`) }
  catch { console.error(`gate ${name}: FAIL`); failed++ }
}
process.exit(failed ? 1 : 0)
