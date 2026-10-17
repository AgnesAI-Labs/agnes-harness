import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { discoverLocalExamples } from '../src/packages/local-examples.js'

const roots: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
it.each([false, true])('discovers optional pinned helper even with broken examples=%s', async (broken) => {
  // Fake only Date, before discovery, so the catalog clock can cross the snapshot ttl below.
  vi.useFakeTimers({ toFake: ['Date'] })
  const start = Date.now()
  const root = mkdtempSync(join(tmpdir(), 'agnes-builtin-catalog-'))
  roots.push(root)
  if (broken) mkdirSync(join(root, 'examples', 'packages'), { recursive: true })
  const catalog = await discoverLocalExamples(root)
  const result = await catalog.read({ offline: true })
  expect(result.entries).toHaveLength(25)
  const examples = result.entries.filter((entry) => entry.sourceId === 'official-examples')
  expect(examples).toHaveLength(17)
  expect(examples.filter((entry) => entry.id.startsWith('@agnes-fde/'))).toHaveLength(12)
  expect(examples.map((entry) => entry.id)).toEqual(
    expect.arrayContaining(['@agnes-example/dag-loop', '@agnes-example/react-loop', '@community/tool-panel']),
  )
  expect(
    examples.every((entry) => entry.integrity && entry.source.ref.startsWith('file:./bundled-examples/')),
  ).toBe(true)
  expect(result.entries[0]).toMatchObject({
    id: '@agnes/skill-helper',
    version: '0.3.0',
    sourceId: 'builtin-plugins',
    source: { type: 'file', ref: 'file:./bundled-plugins/skill-helper' },
  })
  expect(result.entries[1]).toMatchObject({
    id: '@agnes/mcp-helper',
    version: '0.1.0',
    source: { ref: 'file:./bundled-plugins/mcp-helper' },
  })
  expect(result.entries[3]).toMatchObject({
    id: '@agnes/goal-ui',
    version: '0.1.0',
    source: { ref: 'file:./bundled-plugins/goal-ui' },
  })
  expect(result.entries[4]).toMatchObject({
    id: '@agnes/interaction-ui',
    version: '0.1.0',
    source: { ref: 'file:./bundled-plugins/interaction-ui' },
  })
  expect(result.entries[5]).toMatchObject({
    id: '@agnes/deliverables-ui',
    version: '0.1.0',
    source: { ref: 'file:./bundled-plugins/deliverables-ui' },
  })
  expect(result.entries[6]).toMatchObject({
    id: '@agnes/document-reader',
    version: '0.1.2',
    source: { ref: 'file:./bundled-plugins/document-reader' },
  })
  expect(result.entries.find((entry) => entry.id === '@agnes/eval-studio')).toMatchObject({
    sourceId: 'builtin-plugins',
    version: '0.1.0',
    source: { ref: 'file:./bundled-plugins/eval-studio' },
  })
  expect(JSON.stringify(result.entries)).not.toContain('github.com')
  expect(result.sources.find((source) => source.sourceId === 'builtin-plugins')?.status).toBe('cached')
  if (broken)
    expect(result.sources.find((source) => source.sourceId === 'local-examples')?.status).toBe('unavailable')

  // Bundled snapshots never go stale: they are served from cache until ttlMs, and an offline read
  // after that reloads them instead of emptying the catalog. A source that never loaded stays out.
  const ids = (read: typeof result) => read.entries.map((entry) => `${entry.id}@${entry.version}`)
  const status = (read: typeof result, sourceId: string) =>
    read.sources.find((source) => source.sourceId === sourceId)?.status
  vi.setSystemTime(start + 86_399_999)
  const cached = await catalog.read({ offline: true })
  expect({ ids: ids(cached), builtin: status(cached, 'builtin-plugins') }).toEqual({
    ids: ids(result),
    builtin: 'cached',
  })
  vi.setSystemTime(start + 86_400_001)
  const expired = await catalog.read({ offline: true })
  expect({ ids: ids(expired), builtin: status(expired, 'builtin-plugins') }).toEqual({
    ids: ids(result),
    builtin: 'fresh',
  })
  if (broken) expect(status(expired, 'local-examples')).toBe('unavailable')
})
