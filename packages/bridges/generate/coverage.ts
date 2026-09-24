import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { CC_HOOK_EVENTS, type HooksMap, type HooksMapEntry } from '../src/data/types.js'

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function fieldCell(entry: HooksMapEntry): string {
  if (entry.to === null) return '—'
  const inputs = Object.entries(entry.fields?.in ?? {}).map(
    ([field, target]) => `\`${field}\` → ${escapeCell(target)}`,
  )
  const outputs = Object.entries(entry.fields?.out ?? {}).map(
    ([field, target]) => `\`${field}\` → ${escapeCell(target)}`,
  )
  return `in: ${inputs.join('; ') || '—'}<br>out: ${outputs.join('; ') || '—'}`
}

export function renderCoverage(map: Readonly<HooksMap>, version: string): string {
  const mapped = CC_HOOK_EVENTS.filter((event) => map.events[event]?.to !== null).length
  const lines = [
    `<!-- generated from @agnes/bridges@${version} — do not edit -->`,
    '# Claude Code hooks coverage',
    '',
    `Source table: \`data/hooks-map.json\` (${version}). Status: mapped ${mapped} / ${CC_HOOK_EVENTS.length}. Anything absent from this table is unsupported.`,
    '',
    '| CC event | status | harness events | supported field contract | unsupported fields | reason |',
    '|---|---|---|---|---|---|',
  ]
  for (const event of CC_HOOK_EVENTS) {
    const entry = map.events[event]
    if (!entry) throw new Error(`hooks-map missing ${event}`)
    const status = entry.to === null ? 'unmapped' : entry.unsupportedFields?.length ? 'partial' : 'supported'
    const targets = entry.to?.map((target) => `\`${target}\``).join(', ') ?? '—'
    const unsupported = entry.unsupportedFields?.map((field) => `\`${field}\``).join(', ') ?? '—'
    lines.push(
      `| \`${event}\` | ${status} | ${targets} | ${fieldCell(entry)} | ${unsupported} | ${escapeCell(entry.reason ?? '—')} |`,
    )
  }
  lines.push('', '## Always unsupported', '')
  for (const event of CC_HOOK_EVENTS) {
    const fields = map.events[event]?.unsupportedFields
    if (fields?.length) lines.push(`- ${fields.map((field) => `\`${field}\``).join(', ')} (${event})`)
  }
  lines.push('- `transcript_path` (all events): use `agnes export` to obtain the session.', '')
  return lines.join('\n')
}

export function syncGeneratedFile(options: { check: boolean; path: string; content: string }): boolean {
  const current = existsSync(options.path) ? readFileSync(options.path, 'utf8') : ''
  if (current === options.content) return true
  if (options.check) return false
  mkdirSync(dirname(options.path), { recursive: true })
  writeFileSync(options.path, options.content)
  return true
}
