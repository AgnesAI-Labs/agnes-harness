import type { UITurn } from '@agnes/protocol'
import { ConversationTurnActions, type ConversationTurnFeedback } from '@agnes/web-ui/assistant-ui'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import type { Translate } from '../locales/index.js'
import type { ConversationFeedback } from './feedback.js'

export interface ConversationMessageActions {
  readonly element: HTMLElement
  readonly feedback: ConversationFeedback
  update(state: ConversationMessageActionState): void
  dispose(): void
}

export interface ConversationMessageActionState {
  readonly turn: UITurn
  readonly finalText: string
  readonly settled: boolean
  readonly localeTag?: string
}

export interface ConversationMessageActionOptions {
  onFork?(turn: UITurn): Promise<void>
  /** Locale-bound translator supplied by the owning transcript. */
  t?: Translate
  /** Compatibility override; otherwise the renderer owns outside-click dismissal and cleanup. */
  bindAutoDismiss?(element: HTMLDetailsElement): void
}

// The legacy factory exposes its disclosure before the first update. This hidden placeholder is
// replaced by the first real projection; no turn facts are displayed or sent from the bridge.
const initialTurn: UITurn = {
  id: '',
  turn: 0,
  startSeq: 0,
  startedAt: '',
  status: 'running',
  nodeIds: [],
  usage: {
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    reasoningComplete: true,
    billingComplete: true,
    calls: [],
  },
  inherited: false,
  forkable: false,
}

/** Synchronous bridge for the default timeline; the React component owns every visible control. */
export function createConversationMessageActions(
  options: ConversationMessageActionOptions = {},
): ConversationMessageActions {
  const element = document.createElement('div')
  element.style.display = 'contents'
  const root = createRoot(element)
  const feedbackRef: { current: ConversationTurnFeedback | null } = { current: null }
  let disposed = false
  let stopDismiss: (() => void) | undefined
  const bindAutoDismiss = (details: HTMLDetailsElement) => {
    if (options.bindAutoDismiss) return options.bindAutoDismiss(details)
    const doc = details.ownerDocument
    const dismiss = (event: Event) => {
      if (details.isConnected && details.open && !event.composedPath().includes(details)) details.open = false
    }
    doc.addEventListener('click', dismiss)
    stopDismiss = () => doc.removeEventListener('click', dismiss)
  }
  const render = ({ turn, finalText, settled, localeTag }: ConversationMessageActionState) =>
    flushSync(() =>
      root.render(
        createElement(ConversationTurnActions, {
          turn,
          finalText,
          settled,
          ...(options.t ? { t: options.t } : {}),
          ...(localeTag ? { localeTag } : {}),
          ...(options.onFork ? { onFork: options.onFork } : {}),
          bindAutoDismiss,
          feedbackRef,
        }),
      ),
    )
  render({ turn: initialTurn, finalText: '', settled: false })
  const feedbackElement = element.querySelector<HTMLElement>('.turn-feedback')
  if (!feedbackElement) throw new Error('missing React turn feedback')
  const clearFeedback = () => {
    if (!disposed) flushSync(() => feedbackRef.current?.clear())
  }
  const feedback: ConversationFeedback = {
    element: feedbackElement,
    clear: clearFeedback,
    report(message, durationMs) {
      if (!disposed) flushSync(() => feedbackRef.current?.report(message, durationMs))
    },
    dispose: clearFeedback,
  }
  return {
    element,
    feedback,
    update(state) {
      if (!disposed) render(state)
    },
    dispose() {
      if (disposed) return
      disposed = true
      stopDismiss?.()
      stopDismiss = undefined
      // Cancel the component's timer now, even when its root must unmount after an outer commit.
      feedbackRef.current?.clear()
      // The default Transcript can retire this bridge from another React root's layout cleanup.
      // Let that commit finish before unmounting the independent compatibility root.
      queueMicrotask(() => {
        flushSync(() => feedbackRef.current?.clear())
        root.unmount()
      })
    },
  }
}
