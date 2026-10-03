import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import {
  exerciseMemory,
  type MemoryContractBinding,
} from '../../../../packages/extension-api/testkit/runtime/contracts/memory.js'
import {
  exerciseRetrieval,
  type RetrievalContractBinding,
} from '../../../../packages/extension-api/testkit/runtime/contracts/retrieval.js'

it('keeps reference storage and indexing independent of default sources', () => {
  const normalized = (text: string) =>
    new Set(
      text
        .split('\n')
        .map((line) => line.replace(/\s/g, ''))
        .filter(Boolean),
    )
  for (const service of ['memory', 'retrieval']) {
    const load = (paths: readonly string[]) =>
      paths.map((path) => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n')
    const reference = load([
      './' + service + '.ts',
      './memory-store.ts',
      ...(service === 'retrieval' ? ['./retrieval-remote.ts'] : []),
    ])
    const defaults = load([
      '../../../../packages/core/src/runtime/providers/' + service + '.ts',
      '../../../../packages/core/src/runtime/memory/access.ts',
      '../../../../packages/core/src/runtime/memory/storage.ts',
      '../../../../packages/host/src/runtime/providers/memory-storage.ts',
      ...(service === 'retrieval'
        ? [
            '../../../../packages/core/src/runtime/retrieval/index-revisions.ts',
            '../../../../packages/core/src/runtime/retrieval/storage.ts',
            '../../../../packages/core/src/runtime/retrieval/remote.ts',
          ]
        : []),
    ])
    expect(reference).not.toMatch(/from.*(?:@agnes\/core|packages\/core)/)
    const a = normalized(reference),
      b = normalized(defaults)
    expect([...a].filter((line) => b.has(line)).length / Math.min(a.size, b.size)).toBeLessThanOrEqual(0.5)
    if (service === 'retrieval') {
      expect(reference).toContain('postings')
      expect(reference).not.toContain('USING fts5')
    }
  }
})

it('selects both actual implementations with the same normal and refusal contract', async () => {
  const module: {
    memoryBinding(id: 'default' | 'reference', command: string): MemoryContractBinding
    retrievalBinding(id: 'default' | 'reference', command: string): RetrievalContractBinding
  } = await import(
    new URL('../../../../tools/acceptance/runtime/platform/memory-conformance.ts', import.meta.url).href
  )
  for (const provider of ['default', 'reference'] as const)
    for (const scenario of ['normal', 'deny'] as const) {
      await exerciseMemory(module.memoryBinding(provider, 'vitest reference cross contract'), scenario)
      await exerciseRetrieval(module.retrievalBinding(provider, 'vitest reference cross contract'), scenario)
    }
})
