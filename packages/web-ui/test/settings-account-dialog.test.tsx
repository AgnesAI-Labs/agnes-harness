/** @vitest-environment happy-dom */

import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { SettingsAccountDialog } from '../src/settings-account-dialog.js'

it('uses the injected catalog for provider, base URL and API key field labels', () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const translatedLabels: Record<string, string> = {
    'accounts.providerLabel': 'Provider · translated',
    'accounts.baseUrlLabel': '服务地址',
    'accounts.apiKeyLabel': 'API Key · translated',
  }

  try {
    flushSync(() =>
      root.render(
        createElement(SettingsAccountDialog, {
          t: (key) => translatedLabels[key] ?? key,
        }),
      ),
    )
    expect(host.querySelector('#config-provider')?.closest('label')?.textContent).toContain(
      'Provider · translated',
    )
    expect(host.querySelector('#config-base-url')?.closest('label')?.textContent).toContain('服务地址')
    expect(host.querySelector('#config-api-key')?.closest('label')?.textContent).toContain(
      'API Key · translated',
    )
  } finally {
    root.unmount()
    host.remove()
  }
})
