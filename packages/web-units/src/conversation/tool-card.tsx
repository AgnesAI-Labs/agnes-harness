import type { UINode } from '@agnes/protocol'
import { baseToolTitle, createRegionHost, createRegionRenderer } from '@agnes/web-ui'
import { ConversationToolCard as ReactToolCard, toolOutcome } from '@agnes/web-ui/conversation'
import type { ElementType, ReactNode } from 'react'
import { flushSync } from 'react-dom'
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
function reactIcon(element: Element, key?: number): ReactNode {
  const properties: Record<string, string | number> = {}
  if (key !== undefined) properties.key = key
  for (const attribute of element.attributes) {
    if (/^on/i.test(attribute.name) || /^(?:style|href|xlink:href)$/i.test(attribute.name)) continue
    const name = attribute.name === 'class' ? 'className' : attribute.name
    properties[name] = attribute.value
  }
  const children = Array.from(element.childNodes, (child, index) => {
    if (child.nodeType === 3) return child.textContent
    if (child.nodeType === 1) return reactIcon(child as Element, index)
    return null
  })
  const Tag = element.localName as ElementType
  return <Tag {...properties}>{children}</Tag>
}

/** Synchronous compatibility bridge; the shared React component owns the visible card. */
export function createConversationToolCard(
  element: HTMLElement,
  node: ToolNode,
  options: ConversationToolCardOptions,
): ConversationToolCard {
  // The legacy DSH adapter moves the article's children into its native fallback container.
  // Give React a host that moves intact, so it never loses children from its own root.
  const host = createRegionHost(element, 'div')
  host.style.display = 'contents'
  const root = createRegionRenderer(host)
  let disposed = false
  let iconName = node.name
  let icon = reactIcon(options.icon(iconName))
  const render = (next: ToolNode) => {
    if (next.name !== iconName) {
      iconName = next.name
      icon = reactIcon(options.icon(iconName))
    }
    element.dataset.status = next.status
    // Include the tool name in the accessible label: status alone does not identify the call to screen-reader users.
    element.setAttribute(
      'aria-label',
      options.translate('tool.card.aria', {
        name: baseToolTitle(next.name, options.translate) ?? next.presentation?.title ?? next.name,
        status: toolOutcome(next, options.translate).label,
      }),
    )
    flushSync(() =>
      root.render(
        <ReactToolCard
          node={next}
          icon={icon}
          t={options.translate}
          onExpandedChange={(expanded: boolean) => {
            element.dataset.expanded = String(expanded)
          }}
        />,
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
