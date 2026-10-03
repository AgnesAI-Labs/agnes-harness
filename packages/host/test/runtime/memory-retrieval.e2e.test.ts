import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadMemoryBindings as loadBindings } from '../../../core/test/runtime/memory-fixture.js'
import type { MemoryContractBinding as MemoryBinding } from '../../../extension-api/testkit/runtime/contracts/memory.js'
import { exerciseMemory } from '../../../extension-api/testkit/runtime/contracts/memory.js'
import type { RetrievalContractBinding as RetrievalBinding } from '../../../extension-api/testkit/runtime/contracts/retrieval.js'
import {
  exerciseRemoteRetrieval,
  exerciseRetrieval,
} from '../../../extension-api/testkit/runtime/contracts/retrieval.js'

const loadMemoryBindings = () =>
  loadBindings<{
    memoryBinding(id: 'default' | 'reference', command: string): MemoryBinding
    retrievalBinding(id: 'default' | 'reference', command: string): RetrievalBinding
  }>()

describe.each(['default', 'reference'] as const)('%s real process recovery', (id) => {
  it('recovers memory, index revisions and pending deletions in a new process', async () => {
    const bindings = await loadMemoryBindings()
    await exerciseMemory(bindings.memoryBinding(id, 'vitest cold recovery'), 'recover')
    await exerciseRetrieval(bindings.retrievalBinding(id, 'vitest cold recovery'), 'recover')
    await exerciseRemoteRetrieval(bindings.retrievalBinding(id, 'vitest cold remote recovery'), 'recover')
  })
  it.each(['crash-write', 'crash-index-write'])('survives SIGKILL at %s before acknowledgement', (mode) => {
    const directory = mkdtempSync(join(tmpdir(), 'memory-crash-')),
      fixture = fileURLToPath(
        new URL('../../../../tools/acceptance/runtime/fixtures/memory-cold-process.ts', import.meta.url),
      )
    try {
      const write = spawnSync(process.execPath, ['--import', 'tsx', fixture, id, mode, directory], {
        timeout: 30000,
        encoding: 'utf8',
      })
      expect(write.error).toBeUndefined()
      expect(write.signal).toBe('SIGKILL')
      expect(write.stdout).toBe('committed')
      const read = spawnSync(process.execPath, ['--import', 'tsx', fixture, id, 'retrieval', directory], {
        timeout: 30000,
        encoding: 'utf8',
      })
      expect(read.status, read.stderr).toBe(0)
      const state = JSON.parse(read.stdout)
      expect(state.result.ok).toBe(true)
      expect(state.result.value.items).toHaveLength(1)
      expect(state.watermark).toBe(2)
      expect(state.pending).toBe(0)
      expect(state.indexRevision).toBe(2)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
