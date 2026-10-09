import { SlotOutlet, type SlotRegistry, SlotsProvider } from '@agnes/web-client'
import { createAntdRoot } from '@agnes/web-ui'
import { Approval, type ApprovalHandle, type ApprovalView } from '@agnes/web-units'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { APPROVAL_SLOT, type EmptyStateRegionMount } from './contracts.js'

export interface ApprovalRegionMount extends EmptyStateRegionMount, ApprovalHandle {}

export const APPROVAL_DSH_CHILDREN = Object.freeze({
  'conversation.approval.detail': { kind: 'single', scope: 'session' },
} as const)

export function ApprovalDshFrame({
  setHandle,
}: {
  setHandle: (value: ApprovalHandle | null) => void
}): ReturnType<typeof createElement> {
  return createElement(Approval, {
    ref: setHandle,
    detail: createElement(SlotOutlet, { name: 'conversation.approval.detail', hideWhenEmpty: true }),
  })
}

/** Mount the component-owned approval card behind the live-region section and slot boundary. */
export function mountApprovalRegion(registry: SlotRegistry, container: HTMLElement): ApprovalRegionMount {
  const handle = { current: null as ApprovalHandle | null }
  let view: ApprovalView | undefined
  const setHandle = (value: ApprovalHandle | null): void => {
    handle.current = value
    if (value) value.render(view)
  }
  registry.declare(APPROVAL_SLOT as string, { kind: 'single', scope: 'session-maybe' }, 'web-shell')
  const removeBuiltin = registry.register(
    {
      name: APPROVAL_SLOT as string,
      id: 'builtin-approval',
      owner: '@agnes/web-approval',
      priority: 0,
      children: APPROVAL_DSH_CHILDREN,
    },
    () => ApprovalDshFrame({ setHandle }),
  )
  container.replaceChildren()
  const root = createAntdRoot(container)
  flushSync(() => {
    root.render(
      createElement(SlotsProvider, { registry }, createElement(SlotOutlet, { name: APPROVAL_SLOT })),
    )
  })
  let disposed = false
  return {
    render(next) {
      view = next
      container.hidden = next === undefined
      if (next) container.dataset.key = next.key
      else container.removeAttribute('data-key')
      handle.current?.render(next)
    },
    dispose() {
      if (disposed) return
      disposed = true
      root.unmount()
      removeBuiltin()
    },
  }
}
