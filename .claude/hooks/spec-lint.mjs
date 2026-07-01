#!/usr/bin/env node
// PostToolUse hook: lint spec docs after Edit/Write.
// Enforces the PRD's own rule on the PRD: every requirement clause has an
// *Obligation:* line, and clause IDs are globally unique across docs/.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const input = JSON.parse(readFileSync(0, 'utf8'))
const edited = input.tool_input?.file_path ?? ''
if (!/docs\/(specs|adr)\/.+\.md$/.test(edited)) process.exit(0)

const CLAUSE = /^[-|] \*\*([A-Z]{2,}-\d+)[.\s]/ // "- **TEL-1.**" or "- **OSS-1 Packaging.**"
const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
const specDirs = ['docs/specs', 'docs/adr']

const defs = new Map() // id -> [file:line, ...]
const missing = [] // clauses without obligations
for (const dir of specDirs) {
  let files = []
  try { files = readdirSync(join(root, dir)).filter((f) => f.endsWith('.md')) } catch { continue }
  for (const f of files) {
    const lines = readFileSync(join(root, dir, f), 'utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(CLAUSE)
      if (!m) continue
      const id = m[1]
      const loc = `${dir}/${f}:${i + 1}`
      defs.set(id, [...(defs.get(id) ?? []), loc])
      // block = lines until next clause bullet, heading, or blank line
      let hasObligation = false
      for (let j = i; j < lines.length; j++) {
        if (j > i && (/^[-|] \*\*/.test(lines[j]) || /^#/.test(lines[j]) || lines[j].trim() === '')) break
        if (lines[j].includes('*Obligation:*')) hasObligation = true
      }
      if (!hasObligation) missing.push(`${loc} ${id}`)
    }
  }
}

const dupes = [...defs].filter(([, locs]) => locs.length > 1)
if (missing.length || dupes.length) {
  const msgs = [
    ...missing.map((m) => `missing *Obligation:* line → ${m}`),
    ...dupes.map(([id, locs]) => `duplicate clause ID ${id} → ${locs.join(', ')}`),
  ]
  console.error(`spec-lint: ${msgs.length} problem(s):\n${msgs.join('\n')}\nA requirement without an obligation is vague by definition (PRD §7.2). Fix the clause, don't remove the check.`)
  process.exit(2)
}
process.exit(0)
