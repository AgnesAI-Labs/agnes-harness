import { ConversationMarkdown, type ConversationMarkdownProps } from '@agnes/web-ui/assistant-ui'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'

export type MarkdownState = { streaming?: boolean }
export type MarkdownRenderer = {
  update(source: string, state?: MarkdownState): void
  dispose(options?: { defer?: boolean }): void
}
type MarkdownOptions = Omit<ConversationMarkdownProps, 'source' | 'part' | 'onRelease' | 'syntax'> & {
  part?: 'body' | 'thinking'
}

/** Synchronous compatibility facade. Its React root alone owns the supplied container. */
export function createMarkdownRenderer(
  element: HTMLElement,
  initial = '',
  options: MarkdownOptions = {},
): MarkdownRenderer {
  element.classList.add('markdown')
  const root = createRoot(element)
  let disposed = false
  let streaming = options.streaming ?? false
  const render = (source: string) =>
    flushSync(() =>
      root.render(
        createElement(ConversationMarkdown, {
          ...options,
          source,
          part: options.part ?? 'body',
          streaming,
          onRelease: flushSync,
          syntax: 'immediate',
        }),
      ),
    )
  render(initial)
  return {
    update(source, state) {
      if (disposed) return
      streaming = state?.streaming ?? streaming
      render(source)
    },
    dispose(options) {
      if (disposed) return
      disposed = true
      options?.defer ? queueMicrotask(() => flushSync(() => root.unmount())) : flushSync(() => root.unmount())
    },
  }
}
