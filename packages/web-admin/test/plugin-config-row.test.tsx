/** @vitest-environment happy-dom */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { PluginConfigApi } from '../src/admin/plugins/config-api.js'
import { PluginConfigPanel } from '../src/admin/plugins/config-panel.js'

it('locks a bound load to its declared row while ordinary details default to the first row', async () => {
  const entries = ['old-row', 'declared-row'].map((rowId) => ({
    rowId,
    schema: { type: 'object' },
    value: {},
    reload: 'next-session',
  }))
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    if (String(url).endsWith('/get')) return Response.json({ revision: 'test', entries, audit: [] })
    return Response.json({ issues: [] })
  })
  const api = new PluginConfigApi({ profile: 'local', clientId: 'browser-client' }, fetcher)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const unavailable = vi.fn()
  try {
    await act(async () => root.render(<PluginConfigPanel key="ordinary" api={api} id="one" canSave />))
    expect(host.querySelector<HTMLSelectElement>('[data-testid="plugin-config-entry"]')?.value).toBe(
      'old-row',
    )
    await act(async () =>
      root.render(
        <PluginConfigPanel
          key="declared"
          api={api}
          id="one"
          canSave
          exactRow={{ rowId: 'declared-row', isCurrent: () => true, onMissing: unavailable }}
        />,
      ),
    )
    expect(host.querySelector('[data-testid="plugin-config-exact-row"]')?.textContent).toBe('declared-row')
    expect(host.querySelector('[data-testid="plugin-config-entry"]')).toBeNull()
    expect(unavailable).not.toHaveBeenCalled()
    await act(async () =>
      root.render(
        <PluginConfigPanel
          key="missing"
          api={api}
          id="one"
          canSave
          exactRow={{ rowId: 'different-row', isCurrent: () => true, onMissing: unavailable }}
        />,
      ),
    )
    expect(unavailable).toHaveBeenCalled()
    expect(
      host.querySelector('[data-testid="plugin-config-entry"], [data-testid="plugin-config-save"]'),
    ).toBeNull()
  } finally {
    await act(async () => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})
