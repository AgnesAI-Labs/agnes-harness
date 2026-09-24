import { readFileSync } from 'node:fs'
import { validateEvent } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import {
  EnvelopeBuilder,
  importClaudeCode,
  importCodex,
  importPi,
  parseJsonl,
  readClaudeCodeHeader,
  readCodexHeader,
  readPiHeader,
  Tolerance,
} from '../../src/convert/index.js'

const fixture = (name: string) => readFileSync(new URL(`../../fixtures/import/${name}`, import.meta.url))
const build = (source: 'claude-code' | 'codex' | 'pi') =>
  new EnvelopeBuilder({ source, sessionKey: 'k', now: () => 0, rng: () => 0.5, agnesVersion: '0' })
const valid = (events: ReturnType<EnvelopeBuilder['finish']>) => {
  for (const event of events) expect(validateEvent(event).ok, event.type).toBe(true)
}

describe('source importers', () => {
  it('maps Claude messages/tools/images and accounts for sidechains and unsupported rows', () => {
    const report = new Tolerance()
    const rows = parseJsonl(fixture('claude-code/basic.jsonl'), report)
    const b = build('claude-code')
    const header = readClaudeCodeHeader(rows)
    expect(header).toEqual({ sourceId: 'abc', cwd: '/w' })
    b.start(header as NonNullable<typeof header>)
    importClaudeCode(rows, b, report)
    const events = b.finish()
    valid(events)
    expect(events.find((event) => event.type === 'tool/call')?.data).toMatchObject({
      toolUseId: 'toolu_1',
      name: 'mcp_server_tool',
      args: { command: 'ls' },
    })
    expect(events.find((event) => event.type === 'tool/result')?.data).toMatchObject({
      structured: { stdout: 'a.txt\nb.txt' },
      enforcement: { level: 'none', scope: [] },
      authz: { decisionId: 'n/a' },
    })
    expect(events.map((event) => event.type)).toContain('x/agnes/import/compaction')
    expect(events.map((event) => event.type)).toContain('x/agnes/import/unmapped')
    expect(JSON.stringify(events)).not.toContain('sidechain answer')
    expect(report.finish('claude-code', events.length)).toMatchObject({
      branches: { dropped: 1 },
      unsupported: { progress: 1 },
    })
  })

  it('maps Codex reasoning/calls/results and preserves side records without duplicating event_msg', () => {
    const report = new Tolerance()
    const rows = parseJsonl(fixture('codex/basic.jsonl'), report)
    const b = build('codex')
    const header = readCodexHeader(rows)
    expect(header).toEqual({ sourceId: 'sess-1', cwd: '/w', forkedFrom: 'parent-1' })
    b.start(header as NonNullable<typeof header>)
    importCodex(rows, b, report)
    const events = b.finish()
    valid(events)
    expect(events.find((event) => event.type === 'tool/call')?.data).toMatchObject({
      name: 'shell',
      args: { command: ['ls'] },
    })
    expect(events.find((event) => event.type === 'tool/result')?.data).toMatchObject({
      toolUseId: 'call_1',
      isError: false,
    })
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'x/agnes/import/origin',
        'x/agnes/import/turn-context',
        'x/agnes/import/usage',
        'x/agnes/import/compaction',
        'x/agnes/import/unmapped',
      ]),
    )
    expect(JSON.stringify(events)).not.toContain('duplicate UI event')
    expect(report.finish('codex', events.length).unsupported).toEqual({ event_msg: 1 })
  })

  it('keeps Codex custom-tool string input verbatim instead of treating it as broken JSON', () => {
    const report = new Tolerance()
    const rows = [
      { line: 1, value: { type: 'session_meta', payload: { id: 'c', cwd: '/w' } } },
      {
        line: 2,
        value: {
          type: 'response_item',
          payload: { type: 'custom_tool_call', call_id: 'call', name: 'apply_patch', input: 'patch' },
        },
      },
    ]
    const b = build('codex')
    b.start({ sourceId: 'c', cwd: '/w' })
    importCodex(rows, b, report)
    expect(b.finish().find((event) => event.type === 'tool/call')?.data).toMatchObject({ args: 'patch' })
    expect(report.finish('codex', 0).repaired).toEqual([])
  })

  it('imports the legacy Codex header and direct message rows', () => {
    const report = new Tolerance()
    const rows = [
      {
        line: 1,
        value: { id: 'legacy', timestamp: '2020-01-01T00:00:00Z', instructions: 'system' },
      },
      { line: 2, value: { record_type: 'state' } },
      {
        line: 3,
        value: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      },
    ]
    expect(readCodexHeader(rows)).toEqual({ sourceId: 'legacy', cwd: '/' })
    const b = build('codex')
    b.start({ sourceId: 'legacy', cwd: '/' })
    importCodex(rows, b, report)
    expect(JSON.stringify(b.finish())).toContain('hi')
    expect(report.finish('codex', 0).unsupported).toEqual({ state: 1 })
  })

  it('takes pi newest branch and maps tools plus model/compaction records', () => {
    const report = new Tolerance()
    const rows = parseJsonl(fixture('pi/branching.jsonl'), report)
    const b = build('pi')
    const header = readPiHeader(rows)
    expect(header).toEqual({ sourceId: 'pi-1', cwd: '/w' })
    b.start(header as NonNullable<typeof header>)
    importPi(rows, b, report)
    const events = b.finish()
    valid(events)
    expect(JSON.stringify(events)).not.toContain('old branch answer')
    expect(JSON.stringify(events)).toContain('one file')
    expect(events.find((event) => event.type === 'tool/call')?.data).toMatchObject({
      name: 'bash_tool',
    })
    expect(events.find((event) => event.type === 'tool/result')?.data).toMatchObject({
      structured: { exitCode: 0 },
    })
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['x/agnes/import/model-change', 'x/agnes/import/compaction']),
    )
    expect(report.finish('pi', events.length).branches.dropped).toBe(1)
  })

  it('requires the real header fields instead of inventing source identities', () => {
    const rows = (value: unknown) => [{ line: 1, value }]
    expect(readClaudeCodeHeader(rows({ type: 'assistant', sessionId: 'x' }))).toBeNull()
    expect(readCodexHeader(rows({ type: 'session_meta', payload: {} }))).toBeNull()
    expect(readPiHeader(rows({ type: 'session', cwd: '/w' }))).toBeNull()
  })
})
