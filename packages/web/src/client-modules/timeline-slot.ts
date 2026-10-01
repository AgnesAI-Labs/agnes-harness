/**
 * 时间线内联卡片（WC9）：接通现成的 `kind:'slot'` 节点。
 *
 * `webView()` 不再过滤 slot 节点；时间线为每个 slot 节点保留稳定容器并挂
 * `<SlotOutlet name="tool.card.inline">`。认领（WC9 按包认领，producer 匹配见 WC12）
 * 走 ClaimResolver——真源是名册 extIds（P1a），缺省一律未认领显示占位。
 * 容器始终在（占位骨架常驻），注册表/认领变化让占位原地变卡片，无需重拉时间线。
 * 底座未启动（boot 未运行）时降级为静态占位，不挂 React。
 */

import {
  type SlotEntry,
  SlotOutlet,
  type SlotOutletProps,
  type SlotRegistry,
  SlotsProvider,
} from '@agnes/web-client'
import type { AntdRoot } from '@agnes/web-ui'
import { createAntdRoot } from '@agnes/web-ui'
import { createElement, type ReactElement } from 'react'
import type { ClaimResolver } from './boot.js'

/** 与 protocol `kind:'slot'` 节点同形的最小切片。 */
export interface SlotNodeView {
  kind: 'slot'
  fill: { slot: string; extId: string; payload: unknown }
}

export interface SlotCardContext {
  registry: SlotRegistry
  claim: ClaimResolver
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
  const element = document.createElement('div')
  element.setAttribute('data-slot-node', options.node.fill.slot)
  element.setAttribute('data-agnes-region', 'slot-card')
  const context = options.context
  if (!context) {
    element.setAttribute('data-slot-state', 'empty')
    element.textContent = '此卡片的插件未就绪'
    return {
      element,
      update(next: SlotNodeView) {
        element.setAttribute('data-slot-node', next.fill.slot)
      },
      dispose() {},
    }
  }
  const root = createAntdRoot(element)
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
    createElement(
      SlotsProvider,
      { registry: context.registry },
      createElement(
        SlotOutlet as unknown as (props: SlotOutletProps<'tool.card.inline'>) => ReactElement,
        outletProps,
      ),
    ),
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
