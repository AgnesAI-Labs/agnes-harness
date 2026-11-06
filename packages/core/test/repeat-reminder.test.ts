import type { ToolResult } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { withRepeatReminder } from '../src/execution/turn/repeat-reminder.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { actor, openSession, readTool } from './helpers/open-session.js'

const result = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })
const noteOf = (r: ToolResult) => {
  const last = r.content.at(-1)
  return last?.type === 'text' && last.text.includes('[Repeat') ? last.text : undefined
}
const notes = (owner: object, calls: Array<[string, unknown, string]>) =>
  calls.map(([name, args, text]) => noteOf(withRepeatReminder(owner, name, args, result(text))))

describe('repeat reminder', () => {
  it('notes the 3rd, 5th and 8th identical call in a row: gently first, then in detail', () => {
    const owner = {}
    const seen = notes(
      owner,
      Array.from({ length: 9 }, () => ['read', { path: 'a.txt' }, 'same']),
    )
    expect(
      seen.map((n) => (n === undefined ? '-' : n.includes('Repeated tool call detected') ? 'D' : 'G')),
    ).toEqual(['-', '-', 'G', '-', 'D', '-', '-', 'D', '-'])
    expect(seen[4]).toContain('read called 5 times in a row')
    expect(seen[4]).toContain('{"path":"a.txt"}')
  })

  it('does not count a call whose result changed: polling is not a loop', () => {
    const owner = {}
    const seen = notes(
      owner,
      Array.from(
        { length: 6 },
        (_, i) => ['job_output', { id: 'j1' }, `progress ${i}`] as [string, unknown, string],
      ),
    )
    expect(seen.every((n) => n === undefined)).toBe(true)
  })

  it('treats results that differ only in elapsed time as the same', () => {
    const owner = {}
    const seen = notes(owner, [
      ['bash', { cmd: 'npm test' }, '1 failed\nDone in 2.31s'],
      ['bash', { cmd: 'npm test' }, '1 failed\nDone in 2.34s'],
      ['bash', { cmd: 'npm test' }, '1 failed\nDone in 350ms'],
    ])
    expect(seen[2]).toBeDefined()
  })

  it('treats results that differ only in a timestamp or clock time as the same', () => {
    const owner = {}
    const seen = notes(owner, [
      ['bash', { cmd: 'run' }, 'error at 2026-11-06T10:21:03.120Z'],
      ['bash', { cmd: 'run' }, 'error at 2026-11-06 10:21:09+08:00'],
      ['bash', { cmd: 'run' }, 'error at 11:02:45'],
    ])
    expect(seen[2]).toBeDefined()
    const same = notes({}, [
      ['bash', { cmd: 'run' }, 'error at 2026-11-06T10:21:03Z'],
      ['bash', { cmd: 'run' }, 'error at 2027-01-01T00:00:00Z'],
      ['bash', { cmd: 'run' }, 'error at 2028-05-05T05:05:05Z'],
    ])
    expect(same[2]).toBeDefined()
  })

  it('still tells results apart when a count or a longer wait changes', () => {
    const owner = {}
    const counts = notes(owner, [
      ['bash', { cmd: 'npm test' }, '3 failed in 1.2s'],
      ['bash', { cmd: 'npm test' }, '2 failed in 1.3s'],
      ['bash', { cmd: 'npm test' }, '1 failed in 1.1s'],
    ])
    expect(counts[2]).toBeUndefined()
    const minutes = notes({}, [
      ['job_output', { id: 'j1' }, 'running, 10 minutes left'],
      ['job_output', { id: 'j1' }, 'running, 5 minutes left'],
      ['job_output', { id: 'j1' }, 'running, 1 minutes left'],
    ])
    expect(minutes[2]).toBeUndefined()
  })

  it('starts again after a different call in between', () => {
    const owner = {}
    const same: [string, unknown, string] = ['read', { path: 'a.txt' }, 'same']
    const seen = notes(owner, [same, same, ['grep', { q: 'x' }, 'hit'], same, same, same])
    expect(seen.slice(0, 5).every((n) => n === undefined)).toBe(true)
    expect(seen[5]).toBeDefined()
  })

  it('treats argument key order as the same call', () => {
    const owner = {}
    const seen = notes(owner, [
      ['edit', { a: 1, b: 2 }, 'ok'],
      ['edit', { b: 2, a: 1 }, 'ok'],
      ['edit', { a: 1, b: 2 }, 'ok'],
    ])
    expect(seen[2]).toBeDefined()
  })

  it('counts each session on its own', () => {
    const a = {}
    const b = {}
    const call: [string, unknown, string] = ['read', {}, 'same']
    notes(a, [call, call])
    expect(notes(b, [call])[0]).toBeUndefined()
    expect(notes(a, [call])[0]).toBeDefined()
  })

  it('quotes at most 500 characters of the arguments', () => {
    const owner = {}
    const big = { body: 'x'.repeat(5000) }
    const seen = notes(
      owner,
      Array.from({ length: 5 }, () => ['write', big, 'ok']),
    )
    const quoted = seen[4]?.match(/x+/)?.[0] ?? ''
    expect(quoted.length).toBeLessThanOrEqual(500)
    expect(seen[4]?.length ?? 0).toBeLessThan(900)
  })

  it('leaves the result as it was when the arguments cannot be compared', () => {
    const owner = {}
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const r = result('same')
    expect(withRepeatReminder(owner, 'read', cyclic, r)).toBe(r)
  })

  it('reaches the ledger: the third identical result carries the note', async () => {
    const registry = new ToolRegistry()
    registry.add(
      readTool(async () => result('same')),
      { source: 'agnes/tools-core', trust: 'builtin' },
    )
    const provider = fakeProvider([
      toolTurn('read', {}),
      toolTurn('read', {}),
      toolTurn('read', {}),
      textTurn('done'),
    ])
    const { session, log } = await openSession({ provider, registry })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    const texts = (await log.scan({ type: 'tool/result', limit: 10 })).map((r) =>
      ((r.data as { content: Array<{ type: string; text?: string }> }).content ?? [])
        .map((b) => b.text ?? '')
        .join(''),
    )
    expect(texts).toHaveLength(3)
    expect(texts[0]).not.toContain('[Repeat')
    expect(texts[1]).not.toContain('[Repeat')
    expect(texts[2]).toContain('[Repeat')
  })
})
