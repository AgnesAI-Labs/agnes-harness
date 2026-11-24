import { humanGuard } from './human-guard.js'
import type { CommitGuard, MemoryPipeline } from './pipeline.js'
import {
  attributedBlocks,
  type MemoryBlock,
  memoryBlocks,
  normalize,
  provenanceObserver,
} from './provenance.js'

const bullet = /^-\s+([a-z0-9_.-]{2,48})\s*:\s*(.+)$/i
const assignment = /^(?:preference:\s*)?([a-z0-9_.-]{2,48})\s*=\s*(.+)$/i

function* preferences(block: MemoryBlock) {
  for (const line of block.text.split('\n')) {
    const trimmed = line.trim()
    const match = bullet.exec(trimmed) ?? assignment.exec(trimmed)
    if (match) yield { key: match[1]!.toLowerCase(), value: normalize(match[2]!) }
  }
}

export const preferenceConflictGuard: CommitGuard = (intent, ctx) => {
  if (intent.origin === 'human') return { kind: 'allow' }
  const existing = new Map<string, number>()
  const protectedValues = new Map<string, Set<string>>()
  function protect(key: string, value: string) {
    const values = protectedValues.get(key) ?? new Set<string>()
    values.add(value)
    protectedValues.set(key, values)
  }
  for (const block of attributedBlocks(intent.before, ctx)) {
    for (const { key, value } of preferences(block)) {
      const line = JSON.stringify([block.id, key, value])
      existing.set(line, (existing.get(line) ?? 0) + 1)
      if (block.origin === 'human') protect(key, value)
    }
  }
  if (ctx.userEnabled) {
    for (const file of ctx.userFiles ?? []) {
      for (const block of memoryBlocks(file.content)) {
        if (block.id) continue
        for (const { key, value } of preferences(block)) protect(key, value)
      }
    }
  }
  for (const block of memoryBlocks(intent.candidate.content)) {
    for (const { key, value } of preferences(block)) {
      const line = JSON.stringify([block.id, key, value])
      const count = existing.get(line) ?? 0
      if (count > 0) {
        existing.set(line, count - 1)
        continue
      }
      const values = protectedValues.get(key)
      if (values && (values.size > 1 || !values.has(value)))
        return {
          kind: 'refuse',
          code: 'MEMORY_PREFERENCE_CONFLICT',
          detail: `The preference "${key}" conflicts with a human-authored value.`,
        }
    }
  }
  return { kind: 'allow' }
}

const protectedPipelines = new WeakSet<MemoryPipeline>()

export function registerMemoryProtection(pipeline: MemoryPipeline): void {
  if (protectedPipelines.has(pipeline)) return
  protectedPipelines.add(pipeline)
  pipeline.addGuard(humanGuard)
  pipeline.addGuard(preferenceConflictGuard)
  pipeline.addObserver(provenanceObserver)
}
