import type { EventEnvelope, UISpan, UITimeline } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import { createComparisonTrace } from './comparison-trace.js'
import { createJevDecisionGraph } from './jev-decision-graph.js'
import { createTimelineRenderer } from './timeline.js'

type Timeline = Omit<UITimeline, 'generation'>
function children(value: Timeline): string[] {
  const keys = new Set<string>()
  const visit = (span: UISpan) => {
    if (span.childSessionKey) keys.add(span.childSessionKey)
    for (const child of span.children) visit(child)
  }
  for (const turn of value.turns) if (turn.trace) visit(turn.trace)
  return [...keys]
}
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  return node
}

/** Archived children are comparison members, never loaded as live sessions. */
export function createComparisonChildHistory(
  host: HTMLElement,
  client: Client,
  scope: { id: string; side: 'left' | 'right' },
) {
  const links = element('div')
  links.className = 'comparison-child-history-links'
  host.append(links)
  const dialog = element('dialog')
  dialog.className = 'comparison-child-history'
  dialog.setAttribute('aria-label', '子任务历史')
  document.body.append(dialog)
  let generation = 0
  let selectedCut: number | null = null
  let disposeView = () => {}
  let disposed = false
  function close() {
    generation++
    disposeView()
    disposeView = () => {}
    if (dialog.open) dialog.close()
  }
  dialog.addEventListener('cancel', close)
  async function open(memberSessionId: string, atSeq: number) {
    close()
    const ticket = generation
    const header = element('header')
    const closeButton = element('button', '关闭子任务历史')
    closeButton.type = 'button'
    closeButton.addEventListener('click', close)
    const status = element('p', '正在读取已归档的子任务…')
    status.setAttribute('role', 'status')
    header.append(element('strong', '子任务历史'), closeButton)
    dialog.replaceChildren(header, status)
    dialog.showModal()
    const current = () => !disposed && ticket === generation && selectedCut === atSeq
    try {
      const input = { ...scope, atSeq, memberSessionId }
      const response = await client.comparison.projectUI({ ...input, surface: 'web' })
      if (!current()) return
      if (
        response.sessionId !== memberSessionId ||
        response.id !== scope.id ||
        response.side !== scope.side ||
        response.atSeq !== atSeq ||
        response.timeline.sessionId !== memberSessionId ||
        response.timeline.upto !== response.throughSeq
      )
        throw new Error('子任务历史位置不匹配。')
      const rows: EventEnvelope[] = []
      let afterSeq = 0
      while (afterSeq < response.throughSeq) {
        const page = await client.comparison.events({ ...input, afterSeq, limit: 128 })
        if (!current()) return
        if (
          page.id !== scope.id ||
          page.side !== scope.side ||
          page.atSeq !== atSeq ||
          page.sessionId !== memberSessionId ||
          page.throughSeq !== response.throughSeq ||
          page.nextAfterSeq <= afterSeq ||
          page.events.some((row, index) => row.seq !== afterSeq + index + 1) ||
          page.events.at(-1)?.seq !== page.nextAfterSeq ||
          page.nextAfterSeq > response.throughSeq
        )
          throw new Error('子任务历史记录不完整。')
        rows.push(...page.events)
        afterSeq = page.nextAfterSeq
      }
      const tabs = element('nav')
      const chat = element('button', '对话')
      const traceToggle = element('button', '轨迹')
      chat.type = traceToggle.type = 'button'
      tabs.append(chat, traceToggle)
      const graphHost = element('section')
      const transcript = element('section')
      transcript.className = 'transcript'
      const traceHost = element('section')
      const latest = element('button', '回到最新')
      latest.type = 'button'
      const renderer = createTimelineRenderer({
        transcript,
        newContentButton: latest,
        scrollContainer: dialog,
      })
      const trace = createComparisonTrace(traceHost, {
        sessionId: memberSessionId,
        toggle: traceToggle,
        chatToggle: chat,
        conversation: transcript,
        readToolDetail: (_id, callSeq, resultSeq, signal) =>
          client.comparison.toolDetail(
            {
              ...input,
              callSeq,
              ...(resultSeq === undefined ? {} : { resultSeq }),
            },
            {
              ...(signal ? { signal } : {}),
              expectedSource: { sessionId: memberSessionId, throughSeq: response.throughSeq },
            },
          ),
      })
      const graph = createJevDecisionGraph(graphHost)
      graphHost.hidden = !rows.some((row) => row.type === 'runtime/record')
      graph.update(rows, memberSessionId)
      renderer.render(response.timeline.nodes, response.timeline.turns)
      trace.render(response.timeline, response.throughSeq)
      const descendants = element('nav')
      drawLinks(descendants, response.timeline, atSeq)
      status.textContent = `已归档 · ${response.throughSeq} 条记录`
      dialog.append(descendants, tabs, graphHost, transcript, traceHost, latest)
      disposeView = () => {
        renderer.dispose?.()
        trace.dispose()
        graph.dispose()
      }
    } catch (error) {
      if (current())
        status.textContent = `读取子任务历史失败：${error instanceof Error ? error.message : '请重试'}`
    }
  }
  function drawLinks(target: HTMLElement, timeline: Timeline, atSeq: number) {
    target.replaceChildren(
      ...children(timeline).map((key, index) => {
        const button = element('button', `查看子任务 ${index + 1}`)
        button.type = 'button'
        button.title = key
        button.addEventListener('click', () => void open(key, atSeq))
        return button
      }),
    )
  }
  return {
    render(timeline: Timeline, atSeq: number | null, released: boolean) {
      if (selectedCut !== atSeq || !released) close()
      selectedCut = atSeq
      links.hidden = !released || atSeq === null
      if (released && atSeq !== null) drawLinks(links, timeline, atSeq)
      else links.replaceChildren()
    },
    dispose() {
      disposed = true
      close()
      links.remove()
      dialog.remove()
    },
  }
}
