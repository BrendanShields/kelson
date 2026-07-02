#!/usr/bin/env node
// PostToolUse hook: a migration that creates a table the ERD has never heard
// of is a missed spec ripple — the class the auditor caught twice
// (postmortem: F-047, F-061). The ERD owns the data model; new tables land
// in both places in the same edit.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const input = JSON.parse(readFileSync(0, 'utf8'))
const p = input.tool_input?.file_path ?? ''
if (!/packages\/[^/]+\/migrations\/[^/]+\.sql$/.test(p)) process.exit(0)

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
const erdPath = join(root, 'docs/specs/2026-07-02-agent-harness-erd.md')
if (!existsSync(erdPath)) process.exit(0)

const sql = readFileSync(p, 'utf8')
const erd = readFileSync(erdPath, 'utf8').toLowerCase()
const tables = [...sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/gi)].map((m) => m[1])
const missing = tables.filter((t) => !erd.includes(t.toLowerCase()))

if (missing.length) {
  console.error(
    `erd-ripple: migration creates table(s) the ERD never mentions: ${missing.join(', ')}\n` +
    `Update ${erdPath} in the same edit (spec-sync) — the ERD owns the data model (F-047, F-061).`,
  )
  process.exit(2)
}
process.exit(0)
