import { SlotOutlet, type SlotRegistry, SlotsProvider } from '@agnes/web-client'
import { createRegionHost, createRegionRenderer } from '@agnes/web-ui'
import type { ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { DSH_ROOT_CHILDREN, type EmptyStateRegionMount } from './contracts.js'
export interface DshShellRegionMount extends EmptyStateRegionMount {}
/**
 * Register the DSH root tree once for the page.  The legacy `ui:*` regions remain the visible
 * compatibility boundaries; their built-ins below forward into this tree so a DSH contribution
 * can replace a top-level surface without making the old app shell disappear.
 */
export function mountDshShellRegion(registry: SlotRegistry, hostOverlay?: ReactNode): DshShellRegionMount {
  if (registry.spec('root')) throw new Error('DSH shell root is already mounted')
  registry.declare('root', { kind: 'single', scope: 'root' }, 'web-shell')
  // The composer can remain selected when a different conversation frame owns main.conversation.
  registry.declare('conversation.composer', { kind: 'chain', scope: 'session' }, 'web-shell')
  registry.declare('conversation.composer.bar', { kind: 'single', scope: 'session-maybe' }, 'web-shell')
  const removeRoot = registry.register(
    {
      name: 'root',
      id: 'builtin-dsh-root',
      owner: '@agnes/web-shell',
      priority: 0,
      children: DSH_ROOT_CHILDREN,
    },
    () => null,
  )
  const removeMain = registry.register(
    {
      name: 'main',
      key: 'default',
      id: 'builtin-dsh-main',
      owner: '@agnes/web-shell',
      priority: 1,
      children: { 'main.conversation': { kind: 'single', scope: 'session-maybe' } },
    },
    () => <SlotOutlet name="main.conversation" hideWhenEmpty={true} />,
  )
  const overlayHost = createRegionHost(document.body, 'div')
  overlayHost.dataset.agnesDshShellOverlay = 'true'
  const overlayRoot = createRegionRenderer(overlayHost)
  flushSync(() => {
    overlayRoot.render(
      <SlotsProvider registry={registry}>
        <SlotOutlet name="shell.overlay" hideWhenEmpty={true} />
        {hostOverlay}
      </SlotsProvider>,
    )
  })
  let disposed = false
  return {
    dispose() {
      if (disposed) return
      disposed = true
      overlayRoot.unmount()
      overlayHost.remove()
      removeMain()
      removeRoot()
    },
  }
}
