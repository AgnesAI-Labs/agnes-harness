import type { UINode } from '@agnes/protocol'
import { ConversationToolCard as ReactToolCard, toolOutcome } from '@agnes/web-ui/assistant-ui'
import { createElement, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import type { Translate } from '../locales/index.js'

type ToolNode = Extract<UINode, { kind: 'tool' }>

export interface ConversationToolCard {
  update(node: ToolNode): void
  dispose(): void
}

export interface ConversationToolCardOptions {
  icon(name: string): Element
  /** Locale-bound translate; called on every render so a locale switch refreshes the card. */
  translate: Translate
}

/** Copy an existing icon into a React-owned tree without adopting its DOM nodes. */
function reactIcon(element: Element): ReactNode {
  const properties: Record<string, string> = {}
  for (const attribute of element.attributes) {
    if (/^on/i.test(attribute.name) || /^(?:style|href|xlink:href)$/i.test(attribute.name)) continue
    const name = attribute.name === 'class' ? 'className' : attribute.name
    properties[name] = attribute.value
  }
  const children = Array.from(element.childNodes, (child) => {
    if (child.nodeType === 3) return child.textContent
    if (child.nodeType === 1) return reactIcon(child as Element)
    return null
  })
  return createElement(element.localName, properties, ...children)
}

/** Synchronous compatibility bridge; the shared React component owns the visible card. */
export function createConversationToolCard(
  element: HTMLElement,
  node: ToolNode,
  options: ConversationToolCardOptions,
): ConversationToolCard {
  // The legacy DSH adapter moves the article's children into its native fallback container.
  // Give React a host that moves intact, so it never loses children from its own root.
  const host = element.ownerDocument.createElement('div')
  host.style.display = 'contents'
  element.append(host)
  const root = createRoot(host)
  let disposed = false
  let iconName = node.name
  let icon = reactIcon(options.icon(iconName))
  const render = (next: ToolNode) => {
    if (next.name !== iconName) {
      iconName = next.name
      icon = reactIcon(options.icon(iconName))
    }
    element.dataset.status = next.status
    element.setAttribute(
      'aria-label',
      options.translate('tool.detail.status', { status: toolOutcome(next, options.translate).label }),
    )
    flushSync(() =>
      root.render(
        createElement(ReactToolCard, {
          node: next,
          icon,
          t: options.translate,
          onExpandedChange: (expanded: boolean) => {
            element.dataset.expanded = String(expanded)
          },
        }),
      ),
    )
  }
  render(node)
  return {
    update(next) {
      if (!disposed) render(next)
    },
    dispose() {
      if (disposed) return
      disposed = true
      // A legacy transcript may retire this root during a parent React commit.
      queueMicrotask(() => {
        root.unmount()
        host.remove()
      })
    },
  }
}
