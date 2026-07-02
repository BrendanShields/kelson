#!/usr/bin/env node
// OSS-4: a pack merges only with manifest + eval evidence. Every pack under
// packs/ must have a schema-valid ledger entry for its exact version.
// (Full re-run reproducibility verification is the registry CI's half —
// recorded deferral; this repo-side gate checks presence + version match.)
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const failures = []
if (existsSync('packs')) {
  for (const pack of readdirSync('packs', { withFileTypes: true })) {
    if (!pack.isDirectory()) continue
    const manifestPath = join('packs', pack.name, 'pack.yaml')
    if (!existsSync(manifestPath)) {
      failures.push(`${pack.name}: missing pack.yaml (PACK-1)`)
      continue
    }
    const version = (readFileSync(manifestPath, 'utf8').match(/^version:\s*(\S+)/m) ?? [])[1]
    const name = (readFileSync(manifestPath, 'utf8').match(/^name:\s*(\S+)/m) ?? [])[1]
    if (!version || !name) {
      failures.push(`${pack.name}: manifest missing name/version`)
      continue
    }
    const ledgerPath = join('ledger', name, `${version}.json`)
    if (!existsSync(ledgerPath)) {
      failures.push(`${pack.name}: no eval evidence — expected ${ledgerPath} (OSS-4: the gate replaces maintainer taste)`)
      continue
    }
    const entry = JSON.parse(readFileSync(ledgerPath, 'utf8'))
    for (const field of ['run_manifest_hash', 'verdict', 'fpar_delta', 'cost_delta_pct', 'n'])
      if (!(field in entry)) failures.push(`${ledgerPath}: missing ${field}`)
    if (entry.pack !== name || entry.version !== version)
      failures.push(`${ledgerPath}: pack/version mismatch with manifest`)
  }
}
if (failures.length) {
  console.error(`contribution-check failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`)
  process.exit(1)
}
console.log('contribution-check: all packs carry manifests and eval evidence')
