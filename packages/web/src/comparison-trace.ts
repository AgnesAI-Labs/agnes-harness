import type { UITimeline } from '@agnes/protocol'

import { Trace, type TraceHandle, type TracePanelOptions } from '@agnes/web-units'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'

type ComparisonTimeline = Omit<UITimeline, 'generation'> & { generation?: number }

/** One native trace instance per lane; only committed journal projections enter it. */
export function createComparisonTrace(
  host: HTMLElement,
  options: {
    sessionId: string
    toggle: HTMLButtonElement
    chatToggle: HTMLButtonElement
    conversation: HTMLElement
    readToolDetail: NonNullable<TracePanelOptions['readToolDetail']>
  },
) {
  let disposed = false
  let committed: ComparisonTimeline | undefined
  const nodeAt = (sessionId: string, callSeq: number, resultSeq?: number) => {
    if (disposed || sessionId !== options.sessionId || committed?.sessionId !== sessionId) return undefined
    if (callSeq > committed.upto || (resultSeq !== undefined && resultSeq > committed.upto)) return undefined
    return committed.nodes.find(
      (node) => node.kind === 'tool' && node.seq === callSeq && node.resultSeq === resultSeq,
    )
  }
  const readToolDetail: NonNullable<TracePanelOptions['readToolDetail']> = async (
    sessionId,
    callSeq,
    resultSeq,
    signal,
  ) => {
    signal?.throwIfAborted()
    const node = nodeAt(sessionId, callSeq, resultSeq)
    if (node?.kind !== 'tool') throw new Error('工具详情不属于当前显示的账本位置。')
    const projection = committed
    const result = await options.readToolDetail(sessionId, callSeq, resultSeq, signal)
    signal?.throwIfAborted()
    const current = nodeAt(sessionId, callSeq, resultSeq)
    if (
      current?.kind !== 'tool' ||
      current.id !== node.id ||
      committed?.upto !== projection?.upto ||
      committed?.generation !== projection?.generation
    )
      throw new DOMException('轨迹位置已改变，忽略过期详情。', 'AbortError')
    if (
      result.call.toolUseId !== node.toolUseId ||
      (resultSeq === undefined) !== (result.result === undefined) ||
      (result.result !== undefined && (resultSeq === undefined || result.result.toolUseId !== node.toolUseId))
    )
      throw new Error('工具详情与当前账本记录不匹配。')
    return result
  }
  const handle = { current: null as TraceHandle | null }
  const root = createRoot(host)
  flushSync(() => {
    root.render(
      createElement(Trace, {
        ref: handle,
        root: host,
        options: {
          scope: 'embedded',
          toggle: options.toggle,
          chatToggle: options.chatToggle,
          conversation: options.conversation,
          readToolDetail,
        },
      }),
    )
  })
  return {
    setOpen(open: boolean) {
      if (!disposed) handle.current?.setOpen(open)
    },
    render(value: ComparisonTimeline, cut: number) {
      if (disposed) return
      if (value.sessionId !== options.sessionId || value.upto !== cut)
        throw new Error('轨迹投影与当前会话或账本位置不匹配。')
      committed = value
      host.dataset.cut = String(cut)
      handle.current?.render(value.nodes, value.turns, {
        sessionId: options.sessionId,
        throughSeq: cut,
        ...(value.generation === undefined ? {} : { generation: value.generation }),
        hasEarlier: false,
      })
    },
    dispose() {
      if (disposed) return
      disposed = true
      committed = undefined
      root.unmount()
    },
  }
}
