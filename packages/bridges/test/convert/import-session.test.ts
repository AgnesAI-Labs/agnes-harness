import { readFileSync } from 'node:fs'
import { validateEvent } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { ImportError, importSession } from '../../src/convert/index.js'

const fixture = (name: string) => readFileSync(new URL(`../../fixtures/import/${name}`, import.meta.url))
const options = { now: () => 0, rng: () => 0.5, agnesVersion: 'test' }

describe('importSession', () => {
  it.each([
    ['claude-code/basic.jsonl', 'claude-code'],
    ['codex/basic.jsonl', 'codex'],
    ['pi/branching.jsonl', 'pi'],
  ] as const)('auto-detects and validates every event in %s', (name, source) => {
    const result = importSession(fixture(name), { ...options, from: 'auto' })
    expect(result.report.source).toBe(source)
    expect(result.report.imported).toBe(result.events.length)
    expect(result.events[0]).toMatchObject({
      type: 'session/start',
      origin: `import:${source}`,
      trust: 'untrusted',
      actor: { id: 'import', role: 'importer' },
    })
    for (const event of result.events) expect(validateEvent(event).ok, event.type).toBe(true)
  })

  it('passes a native stream through, skips its CLI result, and rejects malformed rows', () => {
    const own = importSession(fixture('pi/branching.jsonl'), { ...options, from: 'pi' }).events
    const bad = { ...own[1], seq: own[0]?.seq, type: 'not/allowed' }
    const bytes = new TextEncoder().encode(
      `${own.map((event) => JSON.stringify(event)).join('\n')}\n${JSON.stringify(bad)}\n` +
        '{"v":"agnes-cli-result/v1","sessionId":"k"}\n',
    )
    const result = importSession(bytes)
    expect(result.report.source).toBe('agnes')
    expect(result.events).toEqual(own)
    expect(result.report.unsupported).toEqual({ 'cli-result': 1 })
    expect(result.report.skipped).toHaveLength(1)
  })

  it('tolerates bad body lines but refuses unknown and headerless files', () => {
    const text = fixture('claude-code/basic.jsonl').toString('utf8')
    const damaged = text.replace(/\n/g, (match, offset) => (offset % 3 === 0 ? '\nnot-json\n' : match))
    const result = importSession(new TextEncoder().encode(damaged), {
      ...options,
      from: 'claude-code',
    })
    expect(result.report.skipped.length).toBeGreaterThan(0)
    expect(result.events.length).toBeGreaterThan(1)
    expect(() => importSession(new TextEncoder().encode('{"foo":1}\n'))).toThrowError(
      /E_IMPORT_UNKNOWN_FORMAT/,
    )
    expect(() =>
      importSession(new TextEncoder().encode('{"type":"summary","summary":"x"}\n'), {
        from: 'claude-code',
      }),
    ).toThrowError(ImportError)
  })

  it('records chain repairs as report entries and protocol-valid repair events', () => {
    const source = [
      { type: 'session', version: 3, id: 'p', timestamp: '2026-01-01T00:00:00Z', cwd: '/w' },
      {
        type: 'message',
        id: 'm1',
        parentId: 'missing',
        timestamp: '2026-01-01T00:00:01Z',
        message: { role: 'user', content: 'hello' },
      },
    ]
    const result = importSession(
      new TextEncoder().encode(source.map((row) => JSON.stringify(row)).join('\n')),
      { ...options, from: 'pi' },
    )
    expect(result.report.repaired).toHaveLength(1)
    expect(result.events.some((event) => event.type === 'x/agnes/import/repair')).toBe(true)
  })

  it('downgrades a mapped event that violates protocol instead of emitting invalid data', () => {
    const source = [
      {
        type: 'user',
        uuid: 'u',
        parentUuid: null,
        isSidechain: false,
        sessionId: 'c',
        cwd: '/w',
        message: {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { data: 'AA==', media_type: 'x'.repeat(129) },
            },
          ],
        },
      },
    ]
    const result = importSession(
      new TextEncoder().encode(source.map((row) => JSON.stringify(row)).join('\n')),
      { ...options, from: 'claude-code' },
    )
    expect(result.events.some((event) => event.type === 'x/agnes/import/unmapped')).toBe(true)
    for (const event of result.events) expect(validateEvent(event).ok).toBe(true)
  })
})
