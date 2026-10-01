/** @vitest-environment happy-dom */

import type { ConfigSnapshot } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import { unmountRegion } from '@agnes/web-ui'
import { SettingsBuiltin, SettingsPaneBuiltin } from '@agnes/web-units'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { createSettingsController } from '../src/settings.js'

afterEach(() => {
  document.body.replaceChildren()
})

it('operates the React settings pane and account dialog without losing native form semantics', async () => {
  const dialog = document.createElement('dialog')
  dialog.id = 'config'
  document.body.append(dialog)
  const shellRoot = createRoot(dialog)
  flushSync(() => shellRoot.render(createElement(SettingsBuiltin, { options: {} })))
  const paneSlot = dialog.querySelector<HTMLElement>('#settings-pane-slot-model')
  if (!paneSlot) throw new Error('model pane slot missing')
  const paneRoot = createRoot(paneSlot)
  flushSync(() => paneRoot.render(createElement(SettingsPaneBuiltin, { pane: 'model' })))

  const snapshot: ConfigSnapshot = {
    profile: 'local-dev',
    revision: 1,
    configured: true,
    provider: null,
    accounts: [
      {
        accountId: 'work',
        label: 'Work',
        providerId: 'openai',
        route: 'account-work',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt',
        models: [{ id: 'gpt', name: 'GPT' }],
        enabled: true,
        credentialConfigured: true,
        authType: 'api-key',
      },
    ],
    defaultAccountId: 'work',
    effect: 'new-sessions',
  }
  const controller = createSettingsController({
    client: {
      config: {
        get: async () => snapshot,
        providers: async () => ({
          providers: [
            {
              id: 'openai',
              label: 'OpenAI',
              api: 'openai-completions',
              baseUrl: 'https://api.openai.com/v1',
            },
          ],
        }),
      },
    } as unknown as Client,
    onSaved: vi.fn(async () => undefined),
    onError: vi.fn(),
  })
  try {
    await controller.open()
    expect(dialog.querySelectorAll('.config-account')).toHaveLength(1)
    expect(dialog.querySelector('#config-accounts button[aria-label="编辑 Work"]')).toBeTruthy()
    dialog.querySelector<HTMLButtonElement>('#config-add-account')?.click()
    expect(dialog.querySelector<HTMLDialogElement>('#account-dialog')?.open).toBe(true)
    expect(dialog.querySelector<HTMLSelectElement>('#config-provider')?.value).toBe('openai')
    expect(dialog.querySelector('#config-api-key')?.closest('label')).toBeTruthy()
    expect(dialog.querySelector<HTMLButtonElement>('#config-save')?.disabled).toBe(true)
    dialog.querySelector<HTMLButtonElement>('#account-dialog-close')?.click()
    expect(dialog.querySelector<HTMLDialogElement>('#account-dialog')?.open).toBe(false)
  } finally {
    controller.close()
    for (const host of dialog.querySelectorAll<HTMLElement>(
      '#config-accounts, .agnes-ui-button-host, .agnes-ui-field-host',
    ))
      unmountRegion(host)
    paneRoot.unmount()
    shellRoot.unmount()
  }
})
