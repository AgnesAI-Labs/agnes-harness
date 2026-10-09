import { SlotOutlet, type SlotRegistry, SlotsProvider } from '@agnes/web-client'
import { createAntdRoot } from '@agnes/web-ui'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { type EmptyStateRegionMount, DSH_ROOT_CHILDREN } from './contracts.js'

export interface DshShellRegionMount extends EmptyStateRegionMount {}

/**
 * Register the DSH root tree once for the page.  The legacy `ui:*` regions remain the visible
 * compatibility boundaries; their built-ins below forward into this tree so a DSH contribution
 * can replace a top-level surface without making the old app shell disappear.
 */
export function mountDshShellRegion(registry: SlotRegistry): DshShellRegionMount {
  if (registry.spec('root')) throw new Error('DSH shell root is already mounted')
  registry.declare('root', { kind: 'single', scope: 'root' }, 'web-shell')
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
    () =>
      createElement(SlotOutlet, {
        name: 'main.conversation',
        hideWhenEmpty: true,
      }),
  )

  const overlayHost = document.createElement('div')
  overlayHost.dataset.agnesDshShellOverlay = 'true'
  document.body.append(overlayHost)
  const overlayRoot = createAntdRoot(overlayHost)
  flushSync(() => {
    overlayRoot.render(
      createElement(
        SlotsProvider,
        { registry },
        createElement(SlotOutlet, { name: 'shell.overlay', hideWhenEmpty: true }),
      ),
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
