#!/usr/bin/env node
// PACK-5 CI half: an existing changelog line differing from its content on
// the base ref is a history rewrite — the base must be a byte-prefix of HEAD.
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const PATH = '.kelson/changelog.jsonl'
const ref = process.argv[2] ?? 'HEAD'

const current = existsSync(PATH) ? readFileSync(PATH, 'utf8') : ''
try {
  execSync(`git rev-parse --verify --quiet ${ref}^{commit}`, { stdio: ['ignore', 'pipe', 'pipe'] })
} catch {
  console.error(`changelog-check: base ref ${ref} does not resolve — refusing to skip the tamper check (PACK-5)`)
  process.exit(1)
}
let base = ''
try {
  base = execSync(`git show ${ref}:${PATH}`, { stdio: ['ignore', 'pipe', 'pipe'] }).toString()
} catch {
  // Ref resolves but the changelog does not exist there — nothing to protect yet.
  process.exit(0)
}
if (!current.startsWith(base)) {
  console.error(`changelog-check: ${PATH} rewrites history relative to ${ref} (PACK-5/I5) — the changelog is append-only`)
  process.exit(1)
}
const seqs = current.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).seq)
if (!seqs.every((s, i) => s === i + 1)) {
  console.error(`changelog-check: seqs not contiguous from 1: ${seqs.join(',')} (PACK-5)`)
  process.exit(1)
}
process.exit(0)
