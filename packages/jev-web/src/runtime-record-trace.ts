import type { DiagnosticsEventsResult, EventEnvelope, RuntimeIdentity } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import { createJevDecisionGraph, type JevReplayCut } from './jev-decision-graph.js'
import type { JevStatsEvidence } from './jev-stats.js'

/** Read-only ledger observation shared by normal chat and comparison lanes. */
export function createRuntimeRecordTrace(
  host: HTMLElement,
  client: Pick<Client, 'call'>,
  onRecords?: (evidence: JevStatsEvidence) => void,
  options: { onCut?: (cut: JevReplayCut | undefined) => void } = {},
) {
  const previousHidden = host.hidden
  const graph = createJevDecisionGraph(host, options.onCut ? { onCut: options.onCut } : {})
  const note = document.createElement('p')
  note.className = 'runtime-trace-coverage'
  note.setAttribute('role', 'status')
  const more = document.createElement('button')
  more.type = 'button'
  more.textContent = '继续读取历史'
  const details = document.createElement('details')
  const summary = document.createElement('summary')
  summary.textContent = '原始运行循环记录'
  const rows = document.createElement('ol')
  rows.className = 'runtime-record-rows'
  details.append(summary, rows)
  const footer = document.createElement('footer')
  footer.className = 'runtime-trace-footer'
  footer.append(note, more, details)
  host.append(footer)
  host.hidden = true
  let sessionId: string | undefined
  let runtime: RuntimeIdentity | undefined
  let disposed = false
  let generation = 0
  let bound: number | undefined
  let afterSeq = 0
  let complete = false
  let loading = false
  let latestHead = 0
  let failure: string | undefined
  const records = new Map<number, EventEnvelope>()
  function render() {
    const ordered = [...records.values()].sort((a, b) => a.seq - b.seq)
    onRecords?.({
      runtime,
      events: ordered,
      complete:
        sessionId !== undefined &&
        complete &&
        !loading &&
        failure === undefined &&
        latestHead <= (bound ?? 0) &&
        ordered.every((event) => event.seq <= (bound ?? 0)),
    })
    graph.update(ordered, sessionId ?? '')
    // Raw JSON is a secondary inspector; the diagram retains read records for causal projection.
    rows.replaceChildren(
      ...ordered.slice(-100).map((event) => {
        const row = document.createElement('li')
        const item = document.createElement('details')
        const title = document.createElement('summary')
        const data = event.data as { record?: { kind?: unknown } }
        title.textContent = `#${event.seq} ${event.type}${typeof data.record?.kind === 'string' ? ` · ${data.record.kind}` : ''}`
        const raw = document.createElement('pre')
        const text = JSON.stringify(event.data, null, 2)
        raw.textContent = text.length > 16_384 ? `${text.slice(0, 16_384)}\n（此记录显示已截断）` : text
        item.append(title, raw)
        row.append(item)
        return row
      }),
    )
    summary.textContent = `原始记录 · ${records.size}`
    note.textContent =
      failure ??
      (complete
        ? `完整账本前缀 #0–${bound ?? 0}`
        : `${loading ? '正在读取' : '部分历史'}：账本 #0–${afterSeq} / ${bound ?? '待确定'}；尚未读全，缺失记录不表示未执行。`)
    note.title = '只读查看已持久化的运行记录；回放不会重新执行任务。原始记录最多显示最近 100 条。'
    more.hidden = complete || sessionId === undefined
    more.disabled = loading
    more.textContent = failure ? '重试读取历史' : '继续读取历史'
  }
  function remember(event: EventEnvelope) {
    if (event.type !== 'runtime/record' && event.type !== 'runtime/cancel') return
    const previous = records.get(event.seq)
    if (
      previous &&
      (previous.id !== event.id ||
        previous.type !== event.type ||
        JSON.stringify(previous.data) !== JSON.stringify(event.data))
    )
      throw new Error(`账本 #${event.seq} 身份冲突；请重新打开会话`)
    records.set(event.seq, event)
  }
  async function readHistory() {
    if (disposed || !sessionId || loading || complete) return
    const ticket = generation
    const id = sessionId
    const startingAfterSeq = afterSeq
    loading = true
    failure = undefined
    render()
    try {
      // Four bounded pages per batch; explicit continuation prevents unbounded background work.
      for (let pageNumber = 0; pageNumber < 4 && !complete; pageNumber++) {
        const page = await client.call<DiagnosticsEventsResult>('_agnes/v1/diagnostics.events', {
          sessionId: id,
          afterSeq,
          limit: 500,
          maxBytes: 2_097_152,
        })
        if (ticket !== generation) return
        if (bound === undefined) bound = page.lastSeq
        if (page.lastSeq < bound) throw new Error('账本水位回退；请重新打开会话')
        let previous = afterSeq
        for (const event of page.events) {
          if (!Number.isSafeInteger(event.seq) || event.seq <= previous) throw new Error('账本分页顺序无效')
          previous = event.seq
          if (event.seq <= bound) remember(event)
        }
        const next = page.nextAfterSeq
        if (next === null && previous < bound) throw new Error('账本前缀未完整返回')
        if (previous >= bound) {
          afterSeq = bound
          complete = true
        } else {
          if (next === null || next <= afterSeq || next !== previous) throw new Error('账本分页游标未前进')
          afterSeq = next
        }
      }
    } catch (error) {
      if (ticket !== generation) return
      failure = `历史读取失败，当前仅为部分证据：${error instanceof Error ? error.message : String(error)}`
    } finally {
      if (ticket === generation) {
        loading = false
        const catchUp = complete && latestHead > (bound ?? 0)
        if (catchUp) {
          bound = undefined
          complete = false
        }
        render()
        // A newer head may arrive while the fixed prefix is loading. Catch up only
        // after completing that prefix; an unfinished four-page batch stays bounded.
        if (catchUp && afterSeq > startingAfterSeq) void readHistory()
      }
    }
  }
  more.addEventListener('click', () => void readHistory())
  return {
    dispose() {
      if (disposed) return
      this.select()
      disposed = true
      generation++
      graph.dispose()
      footer.remove()
      host.hidden = previousHidden
    },
    select(id?: string, head = 0, identity?: RuntimeIdentity) {
      if (disposed) return
      generation++
      sessionId = id
      runtime = identity
      bound = undefined
      afterSeq = 0
      complete = false
      loading = false
      latestHead = head
      failure = undefined
      records.clear()
      details.open = false
      host.hidden = id === undefined
      render()
      if (id) void readHistory()
    },
    head(seq: number) {
      if (disposed) return
      latestHead = Math.max(latestHead, seq)
      if (complete && latestHead > (bound ?? 0)) {
        bound = undefined
        complete = false
        void readHistory()
      }
    },
    observe(event: EventEnvelope) {
      if (disposed) return
      if (!sessionId || (event.type !== 'runtime/record' && event.type !== 'runtime/cancel')) return
      try {
        remember(event)
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }
      render()
    },
  }
}
