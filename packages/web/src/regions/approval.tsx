import { SlotOutlet, type SlotRegistry, SlotsProvider } from '@agnes/web-client'
import { createRegionRenderer } from '@agnes/web-ui'
import { Approval, type ApprovalHandle, type ApprovalView } from '@agnes/web-units/shell'
import type { ReactElement } from 'react'
import { flushSync } from 'react-dom'
import { registerSessionApprovalPanel } from '../workbench/approval-panel.js'
import { workbenchApproval } from '../workbench/approval-store.js'
import { APPROVAL_SLOT, type EmptyStateRegionMount } from './contracts.js'
export interface ApprovalRegionMount extends EmptyStateRegionMount, ApprovalHandle {}
export const APPROVAL_DSH_CHILDREN = Object.freeze({
  'conversation.approval.detail': { kind: 'single', scope: 'session' },
} as const)
export function ApprovalDshFrame({
  setHandle,
}: {
  setHandle: (value: ApprovalHandle | null) => void
}): ReactElement {
  return (
    <Approval
      ref={setHandle}
      detail={<SlotOutlet name={'conversation.approval.detail'} hideWhenEmpty={true} />}
    />
  )
}
/** Mount the component-owned approval card behind the live-region section and slot boundary. */
export function mountApprovalRegion(registry: SlotRegistry, container: HTMLElement): ApprovalRegionMount {
  const removePanel = registerSessionApprovalPanel()
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
  const root = createRegionRenderer(container)
  flushSync(() => {
    root.render(
      <SlotsProvider registry={registry}>
        <SlotOutlet name={APPROVAL_SLOT} />
      </SlotsProvider>,
    )
  })
  let disposed = false
  return {
    render(next) {
      workbenchApproval.set(next)
      view = next
      container.hidden = next === undefined
      if (next) container.dataset.key = next.key
      else container.removeAttribute('data-key')
      handle.current?.render(next)
    },
    focus() {
      handle.current?.focus()
    },
    dispose() {
      if (disposed) return
      disposed = true
      workbenchApproval.set(undefined)
      root.unmount()
      removeBuiltin()
      removePanel()
    },
  }
}
