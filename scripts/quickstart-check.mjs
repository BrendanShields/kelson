#!/usr/bin/env node
// OSS-5: the README quickstart executes end-to-end in CI — these are exactly
// the commands under the quickstart-ci marker, run in a clean temp dir.
// OSS-1's clean-machine install test rides the same script.
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const readme = readFileSync('README.md', 'utf8')
if (!readme.includes('quickstart-ci')) {
  console.error('quickstart-check: README lost its quickstart-ci marker')
  process.exit(1)
}

const dir = mkdtempSync(join(tmpdir(), 'kelson-quickstart-'))
const repo = process.cwd()
const run = (cmd) => {
  console.log(`$ ${cmd}`)
  execSync(cmd, { stdio: 'inherit', cwd: repo })
}
run(`bun packages/cli/src/index.ts init --dir ${dir}`)
run(`bun packages/cli/src/index.ts init --dir ${dir}`) // idempotent, non-destructive
run('bun packages/cli/src/index.ts route explain --step build --tier T0 --task-type mechanical')
run(`bun packages/cli/src/index.ts loop status --db ${join(dir, '.kelson', 'kelson.db')}`)
// Publish-READY, never published: pack the tarball dry.
run('cd packages/cli && bun pm pack --dry-run')
console.log('quickstart-check: README quickstart executed end-to-end')
