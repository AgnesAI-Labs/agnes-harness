import type { UITurn } from '@agnes/protocol'
import { createRegionHost, createRegionRenderer } from '@agnes/web-ui'
import { ConversationTurnActions, type ConversationTurnFeedback } from '@agnes/web-ui/conversation'
import { flushSync } from 'react-dom'
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
  const element = createRegionHost(document.body, 'div')
  element.remove()
  element.style.display = 'contents'
  const root = createRegionRenderer(element)
  const feedbackRef: { current: ConversationTurnFeedback | null } = { current: null }
  let disposed = false
  const render = ({ turn, finalText, settled, localeTag }: ConversationMessageActionState) =>
    flushSync(() =>
      root.render(
        <ConversationTurnActions
          turn={turn}
          finalText={finalText}
          settled={settled}
          {...(options.t ? { t: options.t } : {})}
          {...(localeTag ? { localeTag } : {})}
          {...(options.onFork ? { onFork: options.onFork } : {})}
          feedbackRef={feedbackRef}
        />,
      ),
    )
  render({ turn: initialTurn, finalText: '', settled: false })
  const feedbackElement = element.querySelector<HTMLElement>('.turn-feedback')
  if (!feedbackElement) throw new Error('missing React turn feedback')
  const clearFeedback = () => {
    if (!disposed) flushSync(() => feedbackRef.current?.clear())
  }
  const feedback: ConversationFeedback = {
    // Feedback changes between an empty host and an actionable error banner. Resolve the
    // currently rendered node rather than retaining the placeholder from the initial render.
    get element() {
      return element.querySelector<HTMLElement>('.turn-feedback') ?? feedbackElement
    },
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
