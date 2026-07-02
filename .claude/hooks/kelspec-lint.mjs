#!/usr/bin/env node
// Proto-spec-compiler (dogfoods SPEC-1/DSL-1 structurally before Phase 1).
// Validates fenced kelspec blocks in edited *.spec.md files: block kinds,
// required keys, clause vagueness rule (check or signed unverifiable).
// Structural only — predicate compilation and generators arrive in Phase 1.
import { readFileSync } from 'node:fs'

const input = JSON.parse(readFileSync(0, 'utf8'))
const p = input.tool_input?.file_path ?? ''
if (!/\.spec\.md$/.test(p)) process.exit(0)

const KINDS = ['component', 'domain', 'clause', 'invariant']
const EARS = ['ubiquitous', 'event', 'state', 'unwanted', 'optional']
const errs = []
const src = readFileSync(p, 'utf8')
const blocks = [...src.matchAll(/```kelspec\n([\s\S]*?)```/g)].map((m) => m[1])
if (blocks.length === 0) process.exit(0)

const key = (b, k) => b.match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1]?.trim()

blocks.forEach((b, i) => {
  const at = `block ${i + 1}`
  const kind = key(b, 'kind')
  if (!KINDS.includes(kind)) return errs.push(`${at}: kind must be one of ${KINDS.join('|')}, got "${kind}"`)
  if (!key(b, 'id')) errs.push(`${at}: missing id`)
  if (i === 0 && kind !== 'component') errs.push(`${at}: first block must be kind: component (DSL §2.1)`)
  if (kind === 'clause') {
    const ears = key(b, 'ears')
    if (!EARS.includes(ears)) errs.push(`${at}: ears must be one of ${EARS.join('|')}, got "${ears}"`)
    if (['event', 'unwanted'].includes(ears) && !key(b, 'trigger'))
      errs.push(`${at}: ears ${ears} requires a trigger`)
    const hasCheck = /^check:/m.test(b)
    const unver = key(b, 'unverifiable')
    if (!hasCheck && (!unver || unver === 'null'))
      errs.push(`${at} (${key(b, 'id')}): no check predicate and no signed unverifiable — vague by definition (SPEC-1/DSL-4)`)
  }
  if (kind === 'invariant' && !/^check:/m.test(b)) errs.push(`${at}: invariant requires check`)
})

if (errs.length) {
  console.error(`kelspec-lint: ${p}\n${errs.join('\n')}`)
  process.exit(2)
}
process.exit(0)
