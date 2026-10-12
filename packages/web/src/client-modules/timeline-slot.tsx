import {
  type SlotEntry,
  SlotOutlet,
  type SlotOutletProps,
  type SlotRegistry,
  SlotsProvider,
} from '@agnes/web-client'
import { toolCardsLocaleCatalog } from '@agnes/web-foundation/locales/tool-cards'
import type { AntdRoot } from '@agnes/web-ui'
import { createRegionHost, createRegionRenderer, renderRegion, unmountRegion } from '@agnes/web-ui'
import type { ClaimResolver } from './boot.js'

/** 与 protocol `kind:'slot'` 节点同形的最小切片。 */
export interface SlotNodeView {
  kind: 'slot'
  fill: { slot: string; extId: string; payload: unknown }
}

export interface SlotCardContext {
  registry: SlotRegistry
  claim: ClaimResolver
  /** Locale for the unclaimed-slot fallback copy; optional, defaults to English. */
  locale?: import('@agnes/web-client').LocaleService
}

let cardContext: SlotCardContext | undefined

/** boot 启动后绑定；未绑定时 slot 节点只画静态占位。 */
export function bindSlotCardContext(context: SlotCardContext): void {
  cardContext = context
}

export function getSlotCardContext(): SlotCardContext | undefined {
  return cardContext
}

interface SlotMount {
  element: HTMLElement
  update(next: SlotNodeView): void
  dispose(): void
}

const roots = new WeakMap<HTMLElement, { root: AntdRoot; node: SlotNodeView }>()

function releaseSlotCard(element: HTMLElement): void {
  const entry = roots.get(element)
  if (!entry) return
  roots.delete(element)
  // A transcript can disappear during its parent React root's commit. Unmount the
  // independent card root after that commit so React can complete both cleanups.
  queueMicrotask(() => entry.root.unmount())
}

export function mountSlotCard(options: {
  node: SlotNodeView
  context?: SlotCardContext | undefined
}): SlotMount {
  const element = createRegionHost(document.body, 'div')
  element.remove()
  element.setAttribute('data-slot-node', options.node.fill.slot)
  element.setAttribute('data-agnes-region', 'slot-card')
  const context = options.context
  if (!context) {
    element.setAttribute('data-slot-state', 'empty')
    renderRegion(
      element,
      cardContext?.locale?.t('slot.notReady') ??
        toolCardsLocaleCatalog[document.documentElement.lang === 'zh-CN' ? 'zh-CN' : 'en']['slot.notReady'],
    )
    return {
      element,
      update(next: SlotNodeView) {
        element.setAttribute('data-slot-node', next.fill.slot)
      },
      dispose() {
        queueMicrotask(() => unmountRegion(element))
      },
    }
  }
  const root = createRegionRenderer(element)
  roots.set(element, { root, node: options.node })
  render(root, context, options.node)

  return {
    element,
    update(next: SlotNodeView) {
      const entry = roots.get(element)
      if (!entry) return
      entry.node = next
      render(root, context, next)
    },
    dispose() {
      releaseSlotCard(element)
    },
  }
}

function render(root: AntdRoot, context: SlotCardContext, node: SlotNodeView): void {
  const outletProps: SlotOutletProps<'tool.card.inline'> = {
    name: 'tool.card.inline',
    props: { fill: { slot: node.fill.slot, extId: node.fill.extId, payload: node.fill.payload } },
    filterEntry: (entry: SlotEntry) => context.claim(entry, node.fill.extId),
  }
  root.render(
    <SlotsProvider registry={context.registry}>
      <SlotOutlet {...outletProps} />
    </SlotsProvider>,
  )
}

/**
 * 时间线容器移除节点时回收 React root（React root 不随 DOM 移除自动释放）。
 * 在 boot 后由宿主对时间线容器调用一次。
 */
export function observeSlotCards(container: HTMLElement): () => void {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const removed of mutation.removedNodes) {
        if (removed instanceof HTMLElement && roots.has(removed)) releaseSlotCard(removed)
        if (removed instanceof HTMLElement) {
          removed.querySelectorAll<HTMLElement>('[data-slot-node]').forEach((child) => {
            releaseSlotCard(child)
          })
        }
      }
    }
  })
  observer.observe(container, { childList: true, subtree: true })
  return () => observer.disconnect()
}
