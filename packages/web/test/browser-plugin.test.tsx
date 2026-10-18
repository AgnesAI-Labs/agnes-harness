/** @vitest-environment happy-dom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })

import { Context } from '@agnes/cordis'
import { browserViews, PresentationRoleRegistry, SessionService, workbenchPanels } from '@agnes/web-client'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
// @ts-expect-error Shipped ESM is exercised directly, without release-generated declarations.
import * as transport from '../../package-manager/bundled-plugins/browser-runtime/src/client.js'
// @ts-expect-error Shipped ESM is exercised directly, without release-generated declarations.
import * as viewer from '../../package-manager/bundled-plugins/browser-ui/src/client.js'

it('enables transport and panel together, tolerates the legacy viewer, and disconnects on switch or disable', async () => {
  const roles = new PresentationRoleRegistry()
  const session = new SessionService(new Context(), 'one')
  const closed = vi.fn()
  const query = vi.fn(async (_name, { sessionId }) => ({
    state: 'ready',
    ticket: `ticket-${sessionId}`,
    url: `https://${sessionId}.example`,
  }))
  const open = vi.fn(async () => ({ onFrame: () => () => {}, onDisconnect: () => () => {}, close: closed }))
  const ctx = (owner: string) => ({
    session,
    locale: { locale: 'zh-CN' },
    profile: { services: { query }, streams: { open } },
    workbenchPanels,
    presentationRoles: {
      register: (provider: { role: string; mount: (context: unknown) => () => void }) =>
        roles.register(owner, { ...provider, mount: () => provider.mount(ctx(owner)) }),
    },
  })
  expect(workbenchPanels.get('browser')).toBeUndefined()
  const stopTransport = transport.apply(ctx('backend'))
  expect(browserViews.entries()).toHaveLength(1)
  expect(workbenchPanels.get('browser')).toBeDefined()
  expect(query).not.toHaveBeenCalled()
  const ownPanel = workbenchPanels.get('browser')
  const stopViewer = viewer.apply(ctx('viewer'))
  expect(workbenchPanels.get('browser')).toBe(ownPanel)
  expect(roles.getSnapshot()).toEqual([])
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    const panel = workbenchPanels.get('browser')
    if (!panel) throw new Error('Browser panel missing')
    await act(async () => {
      root.render(createElement(panel.component, { context: { t: (key) => key } }))
    })
    expect(query).toHaveBeenCalledWith('browser.observe', { sessionId: 'one' }, { sessionReads: ['one'] })
    expect(open).toHaveBeenCalledWith(
      'browser.frames',
      { ticket: 'ticket-one' },
      { signal: expect.any(AbortSignal) },
    )
    expect(host.textContent).toContain('https://one.example')
    expect(host.textContent).toContain('仅观看')
    await act(async () => session.setSession('two'))
    expect(closed).toHaveBeenCalledWith('viewer-closed')
    expect(host.textContent).toContain('https://two.example')
    expect(host.textContent).not.toContain('https://one.example')
    await act(async () => {
      root.unmount()
    })
    expect(workbenchPanels.get('browser')).toBe(ownPanel)
    // Even an installed legacy viewer must disappear when the browser plugin is disabled.
    stopTransport()
    expect(workbenchPanels.get('browser')).toBeUndefined()
    expect(browserViews.entries()).toHaveLength(0)
  } finally {
    stopViewer()
    stopTransport()
    host.remove()
  }
})
