import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { discoverLocalExamples } from '../src/packages/local-examples.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
it.each([false, true])('discovers optional pinned helper even with broken examples=%s', async (broken) => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-builtin-catalog-'))
  roots.push(root)
  if (broken) mkdirSync(join(root, 'examples', 'packages'), { recursive: true })
  const catalog = await discoverLocalExamples(root)
  const result = await catalog.read({ offline: true })
  expect(result.entries).toHaveLength(21)
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
    version: '0.1.1',
    sourceId: 'builtin-plugins',
    source: { type: 'file', ref: 'file:./bundled-plugins/skill-helper' },
  })
  expect(result.entries[1]).toMatchObject({
    id: '@agnes/mcp-helper',
    version: '0.1.0',
    source: { ref: 'file:./bundled-plugins/mcp-helper' },
  })
  expect(result.entries[3]).toMatchObject({
    id: '@agnes/document-reader',
    version: '0.1.2',
    source: { ref: 'file:./bundled-plugins/document-reader' },
  })
  expect(JSON.stringify(result.entries)).not.toContain('github.com')
  expect(result.sources.find((source) => source.sourceId === 'builtin-plugins')?.status).toBe('cached')
  if (broken)
    expect(result.sources.find((source) => source.sourceId === 'local-examples')?.status).toBe('unavailable')
})
