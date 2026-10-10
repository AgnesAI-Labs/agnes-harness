import type { DiagnosticsEventsResult, EventEnvelope } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import type { ComparisonReplayLane } from './comparison-replay.js'
import type { Translate } from './jev-locale.js'

/** Bounded pages retain the real ledger prefix; live tails never fill a missing historical gap. */
export function createComparisonLedger(
  client: Pick<Client, 'call'>,
  sessionId: string,
  update: (value: ComparisonReplayLane, note: string) => void,
  t: Translate,
) {
  const records = new Map<number, EventEnvelope>()
  let after = 0
  let head = 0
  let bound: number | undefined
  let complete = false
  let loading = false
  let stopped = false
  let error: string | undefined
  function publish() {
    if (stopped) return
    update(
      {
        events: [...records.values()].filter((event) => event.seq <= after).sort((a, b) => a.seq - b.seq),
        complete,
        loading,
      },
      error ??
        (complete
          ? t('cledger.note.complete', { seq: after })
          : t('cledger.note.partial', {
              state: loading ? t('cledger.reading') : t('cledger.partialHistory'),
              after,
              total: bound ?? head,
            })),
    )
  }
  async function read() {
    if (stopped || loading || complete) return
    const startingAfter = after
    loading = true
    error = undefined
    publish()
    try {
      for (let pageNumber = 0; pageNumber < 4 && !complete; pageNumber++) {
        const page = await client.call<DiagnosticsEventsResult>('_agnes/v1/diagnostics.events', {
          sessionId,
          afterSeq: after,
          limit: 500,
          maxBytes: 2_097_152,
        })
        if (stopped) return
        bound ??= page.lastSeq
        head = Math.max(head, page.lastSeq)
        if (page.lastSeq < bound) throw new Error('账本水位回退')
        let previous = after
        for (const event of page.events) {
          if (!Number.isSafeInteger(event.seq) || event.seq !== previous + 1)
            throw new Error('账本分页序号不连续')
          previous = event.seq
          if (event.seq > bound) continue
          const prior = records.get(event.seq)
          if (prior && JSON.stringify(prior) !== JSON.stringify(event))
            throw new Error(`账本 #${event.seq} 身份冲突`)
          records.set(event.seq, event)
        }
        if (previous >= bound) {
          after = bound
          complete = true
        } else {
          if (page.nextAfterSeq === null || page.nextAfterSeq !== previous || previous <= after)
            throw new Error('账本前缀未完整返回')
          after = previous
        }
      }
    } catch (failure) {
      error = t('cledger.readFailed', {
        message: failure instanceof Error ? failure.message : String(failure),
      })
    } finally {
      loading = false
      const catchUp = complete && head > after
      if (catchUp) {
        complete = false
        bound = undefined
      }
      publish()
      if (catchUp && after > startingAfter && !stopped && !error) void read()
    }
  }
  return {
    read,
    head(seq: number) {
      head = Math.max(head, seq)
      if (complete && head > after) {
        complete = false
        bound = undefined
      }
      void read()
    },
    dispose() {
      stopped = true
    },
  }
}
