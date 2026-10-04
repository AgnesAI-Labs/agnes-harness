import type { ComparisonLane, EventEnvelope } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import type { ComparisonReplayLane } from './comparison-replay.js'

/** Pages belong to an authenticated comparison cut, never an implicitly opened session. */
export function createComparisonCutLedger(
  client: Client,
  identity: { id: string; side: ComparisonLane['side']; sessionId: string },
  update: (value: ComparisonReplayLane, note: string) => void,
) {
  const events: EventEnvelope[] = []
  let target: { atSeq: number; throughSeq: number } | undefined
  let loading = false
  let disposed = false
  let error: string | undefined
  const after = () => events.at(-1)?.seq ?? 0
  const complete = () => target !== undefined && after() >= target.throughSeq
  function publish() {
    if (disposed) return
    update(
      { events: [...events], complete: complete(), loading },
      error ??
        (complete()
          ? `已载入完整账本 #0–${after()}；当前展示范围见回放位置。`
          : `${loading ? '正在读取' : '部分历史'} #0–${after()} / ${target?.throughSeq ?? 0}；尚未读全，缺失不表示未执行。`),
    )
  }
  async function read() {
    if (disposed || loading || !target || complete()) return
    loading = true
    error = undefined
    publish()
    const cut = target
    try {
      for (let index = 0; index < 4 && after() < cut.throughSeq; index++) {
        const start = after()
        const page = await client.comparison.events({
          id: identity.id,
          side: identity.side,
          atSeq: cut.atSeq,
          afterSeq: start,
          limit: 500,
          maxBytes: 2_097_152,
        })
        if (disposed) return
        if (
          page.id !== identity.id ||
          page.side !== identity.side ||
          page.atSeq !== cut.atSeq ||
          page.sessionId !== identity.sessionId ||
          page.throughSeq !== cut.throughSeq ||
          page.afterSeq !== start
        )
          throw new Error('账本分页返回了不同的对比位置')
        if (
          page.events.length > 500 ||
          new TextEncoder().encode(JSON.stringify(page.events)).byteLength > 2_097_152
        )
          throw new Error('账本分页超过读取限制')
        let next = start
        for (const event of page.events) {
          if (event.seq !== next + 1 || event.seq > cut.throughSeq) throw new Error('账本分页序号不连续')
          next = event.seq
        }
        if (page.nextAfterSeq !== next || page.complete !== (next === cut.throughSeq) || next === start)
          throw new Error('账本前缀未完整返回')
        events.push(...page.events)
      }
    } catch (failure) {
      error = `历史读取失败：${failure instanceof Error ? failure.message : String(failure)}`
    } finally {
      loading = false
      publish()
      // A journal update during this page must not leave the new tail stranded.
      if (!disposed && !error && target !== cut && !complete()) void read()
    }
  }
  return {
    read,
    head(_seq: number) {
      /* Only committed journal cuts can extend this reader. */
    },
    cut(atSeq: number, throughSeq: number) {
      if (disposed) return
      if (!Number.isSafeInteger(atSeq) || !Number.isSafeInteger(throughSeq) || atSeq < 0 || throughSeq < 0)
        throw new Error('无效的共享账本位置')
      if (target && (atSeq < target.atSeq || throughSeq < target.throughSeq))
        throw new Error('共享账本水位回退')
      if (target?.atSeq === atSeq && target.throughSeq === throughSeq) {
        // A later refresh may recover a failed read, but never duplicate an in-flight or successful read.
        if (error && !loading) void read()
        return
      }
      target = { atSeq, throughSeq }
      publish()
      void read()
    },
    dispose() {
      disposed = true
    },
  }
}
