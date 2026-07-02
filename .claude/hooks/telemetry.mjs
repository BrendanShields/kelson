#!/usr/bin/env node
// Proto-telemetry (dogfoods TEL-1's shape before Phase 0 builds the real store).
// Appends one JSONL event per hook firing to .kelson/telemetry/events.jsonl.
// Never blocks or fails the session (KERN-1 discipline): always exit 0.
import { readFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

try {
  const input = JSON.parse(readFileSync(0, 'utf8'))
  const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
  const dir = join(root, '.kelson', 'telemetry')
  mkdirSync(dir, { recursive: true })
  const event = {
    ts: new Date().toISOString(),
    schema_version: 1,
    event: input.hook_event_name ?? process.argv[2] ?? 'unknown',
    session: (input.session_id ?? '').slice(0, 8),
    tool: input.tool_name,
    file: input.tool_input?.file_path,
    cmd: input.tool_input?.command?.slice(0, 120),
  }
  appendFileSync(join(dir, 'events.jsonl'), JSON.stringify(event) + '\n')
} catch { /* telemetry must never break a session */ }
process.exit(0)
