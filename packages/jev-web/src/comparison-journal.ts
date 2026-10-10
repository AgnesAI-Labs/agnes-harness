import type { ComparisonJournalEntry, ComparisonLane } from '@agnes/protocol'
import { type Client, JsonRpcError } from '@agnes/sdk/browser'
import type { Translate } from './jev-locale.js'

export type ComparisonJournalState = {
  mode: 'loading' | 'journal' | 'per-lane-only' | 'error'
  entries: readonly ComparisonJournalEntry[]
  throughSeq: number
  loading: boolean
  error?: string
}
const sides = ['left', 'right'] as const
const maxBytes = 2_097_152
const limit = 500

/** Publish only a fully read fixed prefix. A failed refresh keeps the last verified journal intact. */
export function createComparisonJournal(
  client: Pick<Client, 'comparison'>,
  id: string,
  lanes: readonly ComparisonLane[],
  update: (state: ComparisonJournalState) => void,
  t: Translate,
) {
  let entries: ComparisonJournalEntry[] = []
  let mode: ComparisonJournalState['mode'] = 'loading'
  let loading = false
  let stopped = false
  let requested = false
  let error: string | undefined
  const publish = () => {
    if (!stopped)
      update({ mode, entries, throughSeq: entries.at(-1)?.seq ?? 0, loading, ...(error ? { error } : {}) })
  }
  async function read() {
    if (stopped) return
    if (loading) {
      requested = true
      return
    }
    loading = true
    error = undefined
    publish()
    try {
      const next = [...entries]
      let afterSeq = next.at(-1)?.seq ?? 0
      let throughSeq: number | undefined
      let bytes = 0
      for (let number = 0; number < 256; number++) {
        const page = await client.comparison.journal({
          id,
          afterSeq,
          ...(throughSeq === undefined ? {} : { throughSeq }),
          limit,
          maxBytes,
        })
        if (stopped) return
        throughSeq ??= page.throughSeq
        if (
          page.id !== id ||
          page.afterSeq !== afterSeq ||
          page.throughSeq !== throughSeq ||
          !Number.isSafeInteger(throughSeq) ||
          throughSeq < afterSeq
        )
          throw new Error('共享 journal 分页返回了不同的固定前缀')
        const size = new TextEncoder().encode(JSON.stringify(page.entries)).byteLength
        bytes += size
        if (size > maxBytes || page.entries.length > limit || bytes > 64 * 1024 * 1024)
          throw new Error('共享 journal 分页超过读取限制，尚未读全')
        for (const entry of page.entries) {
          const previous = next.at(-1)
          if (entry.seq !== (previous?.seq ?? 0) + 1 || entry.seq > throughSeq)
            throw new Error('共享 journal 分页序号不连续')
          for (const side of sides) {
            if (!Number.isSafeInteger(entry.cuts[side]) || entry.cuts[side] < (previous?.cuts[side] ?? 0))
              throw new Error('共享 journal lane cut 无效或回退')
            if (entry.fact.kind === 'coordinator' && entry.cuts[side] !== (previous?.cuts[side] ?? 0))
              throw new Error('共享 journal 协调事实改变了 lane cut')
          }
          const fact = entry.fact
          if (fact.kind === 'lane') {
            const binding = lanes.find((lane) => lane.side === fact.side)
            const other = fact.side === 'left' ? 'right' : 'left'
            if (
              binding?.sessionId !== fact.sessionId ||
              fact.localSeq !== (previous?.cuts[fact.side] ?? 0) + 1 ||
              entry.cuts[fact.side] !== fact.localSeq ||
              entry.cuts[other] !== (previous?.cuts[other] ?? 0)
            )
              throw new Error('共享 journal lane 事实与会话或累计 cut 不匹配')
          } else if (fact.kind === 'coordinator') {
            for (const side of sides) {
              const binding = fact.lanes[side]
              const lane = lanes.find((item) => item.side === side)
              if (
                binding &&
                (binding.sessionId !== lane?.sessionId ||
                  binding.runtime.id !== lane.runtime.id ||
                  binding.runtime.version !== lane.runtime.version)
              )
                throw new Error('共享 journal 会话运行循环身份不匹配')
            }
          }
          next.push(entry)
        }
        const cursor = next.at(-1)?.seq ?? 0
        if (
          page.nextAfterSeq !== cursor ||
          page.complete !== (cursor === throughSeq) ||
          (!page.complete && cursor <= afterSeq)
        )
          throw new Error('共享 journal 前缀未完整返回')
        if (page.complete) {
          entries = next
          mode = throughSeq === 0 ? 'per-lane-only' : 'journal'
          return
        }
        afterSeq = cursor
      }
      throw new Error('共享 journal 分页超过读取限制，尚未读全')
    } catch (failure) {
      if (failure instanceof JsonRpcError && failure.code === -32601 && entries.length === 0)
        mode = 'per-lane-only'
      else {
        mode = entries.length > 0 ? 'journal' : 'error'
        error = t('journal.readFailed', {
          message: failure instanceof Error ? failure.message : String(failure),
        })
      }
    } finally {
      loading = false
      publish()
      if (requested && !stopped) {
        requested = false
        void read()
      }
    }
  }
  return {
    read,
    dispose() {
      stopped = true
    },
  }
}
