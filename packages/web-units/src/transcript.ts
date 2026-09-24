import type { UINode, UITurn } from '@agnes/protocol'
import {
  createElement,
  type ForwardedRef,
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from 'react'
/** Whether older records exist before the loaded window, and how to load a page of them. */
export type TranscriptMeta = { hasEarlier: boolean; loadEarlier?: () => void }

export interface TranscriptRenderer {
  render(nodes: readonly UINode[], turns?: readonly UITurn[], meta?: TranscriptMeta): void
  reset(): void
  pinToBottom(): void
  dispose?(): void
}

export interface TranscriptDependencies {
  createRenderer(options: {
    transcript: HTMLElement
    scrollContainer: HTMLElement
    newContentButton: HTMLButtonElement
    onFork?: (turn: UITurn) => Promise<void>
  }): TranscriptRenderer
  observeCards(container: HTMLElement): () => void
}

export interface TranscriptHandle extends Omit<TranscriptRenderer, 'dispose'> {}

export interface TranscriptProps {
  newContentButton?: HTMLButtonElement
  onFork?: (turn: UITurn) => Promise<void>
  dependencies?: TranscriptDependencies
}

/**
 * Transcript owns the timeline leaf and the imperative renderer that updates it.
 * The display-contents wrapper preserves the direct-child layout expected by the existing skin.
 */
export const Transcript = forwardRef<TranscriptHandle, TranscriptProps>(function Transcript(
  { newContentButton, onFork, dependencies }: TranscriptProps,
  ref: ForwardedRef<TranscriptHandle>,
) {
  const content = useRef<HTMLDivElement>(null)
  const renderer = useRef<TranscriptRenderer | undefined>(undefined)

  useImperativeHandle(
    ref,
    () => ({
      render(nodes: readonly UINode[], turns?: readonly UITurn[], meta?: TranscriptMeta) {
        renderer.current?.render(nodes, turns, meta)
      },
      reset() {
        renderer.current?.reset()
      },
      pinToBottom() {
        renderer.current?.pinToBottom()
      },
    }),
    [],
  )

  useLayoutEffect(() => {
    const element = content.current
    // SlotOutlet adds a ledger wrapper between this leaf and the real viewport. Keep DOM ownership
    // in #transcript-content, but bind scrolling to the stable region surface rather than that wrapper.
    const scrollContainer = element?.closest<HTMLElement>('#transcript') ?? element?.parentElement
    if (!element || !scrollContainer || !newContentButton) return
    if (!dependencies) return
    const nextRenderer = dependencies.createRenderer({
      transcript: element,
      scrollContainer,
      newContentButton,
      ...(onFork ? { onFork } : {}),
    })
    renderer.current = nextRenderer
    const stopObserving = dependencies.observeCards(element)
    return () => {
      stopObserving()
      nextRenderer.reset()
      nextRenderer.dispose?.()
      if (renderer.current === nextRenderer) renderer.current = undefined
    }
  }, [dependencies, newContentButton, onFork])

  return createElement(
    'div',
    {
      style: { display: 'contents' },
      'data-agnes-region-owner': 'builtin',
      'data-agnes-region-unit': 'transcript',
    },
    createElement('div', { ref: content, id: 'transcript-content' }),
  )
})
