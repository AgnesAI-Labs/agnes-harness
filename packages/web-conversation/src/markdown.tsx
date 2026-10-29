import { createRegionRenderer } from '@agnes/web-ui'
import { ConversationMarkdown, type ConversationMarkdownProps } from '@agnes/web-ui/conversation'
import { flushSync } from 'react-dom'
export type MarkdownState = {
  streaming?: boolean
}
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
  const root = createRegionRenderer(element)
  let disposed = false
  let streaming = options.streaming ?? false
  const render = (source: string) =>
    flushSync(() =>
      root.render(
        <ConversationMarkdown
          {...options}
          source={source}
          part={options.part ?? 'body'}
          streaming={streaming}
          onRelease={flushSync}
          syntax={'immediate'}
        />,
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
