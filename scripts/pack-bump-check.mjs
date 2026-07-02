#!/usr/bin/env bun
// PACK-3 CI half: for every pack changed since the merge base, the declared
// version bump must satisfy the required bump. Extracts the base version of
// the pack to a temp dir and runs the same kernel diff the CLI uses.
import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { loadPack, requiredBump, bumpSatisfies } from '../packages/kernel/src/index.ts'

const base = process.argv[2]
if (!base) {
  console.error('usage: pack-bump-check.mjs <base-ref>')
  process.exit(1)
}
const changed = execSync(`git diff --name-only ${base} -- packs/`).toString().trim()
if (!changed) {
  console.log('pack-bump-check: no pack changes')
  process.exit(0)
}
const packs = [...new Set(changed.split('\n').map((p) => p.split('/')[1]))]
let failed = false
for (const pack of packs) {
  const baseFiles = execSync(`git ls-tree -r --name-only ${base} -- packs/${pack}`).toString().trim()
  if (!baseFiles) {
    console.log(`pack-bump-check: ${pack} is new — no previous version to diff`)
    continue
  }
  const prevDir = mkdtempSync(join(tmpdir(), `pack-prev-${pack}-`))
  for (const file of baseFiles.split('\n')) {
    const rel = file.slice(`packs/${pack}/`.length)
    mkdirSync(join(prevDir, dirname(rel)), { recursive: true })
    writeFileSync(join(prevDir, rel), execSync(`git show ${base}:${file}`))
  }
  const prev = loadPack(prevDir)
  const next = loadPack(`packs/${pack}`)
  const required = requiredBump(prev, next)
  const declared = { prev: prev.manifest.version, next: next.manifest.version }
  if (!bumpSatisfies(declared, required)) {
    console.error(`pack-bump-check FAIL (PACK-3): ${pack} requires "${required}" but declares ${declared.prev} -> ${declared.next}`)
    failed = true
  } else console.log(`pack-bump-check: ${pack} ok — required "${required}", ${declared.prev} -> ${declared.next}`)
}
process.exit(failed ? 1 : 0)
