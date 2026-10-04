/** @vitest-environment happy-dom */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ConfigSnapshot } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import { unmountRegion } from '@agnes/web-ui'
import { SettingsBuiltin, SettingsPaneBuiltin } from '@agnes/web-units'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { createSettingsController } from '../src/settings.js'
import { zhT } from './helpers/locale.js'

const stylePath = resolve(import.meta.dirname, '../public/style.css')

function styleRule(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^\\s*${escapedSelector} \\{([^}]*)\\}`, 'm').exec(css)
  expect(match, `missing rule ${selector}`).not.toBeNull()
  return match?.[1] ?? ''
}

afterEach(() => {
  document.body.replaceChildren()
})

it('keeps the account dialog close control anchored and the action footer visible in short viewports', () => {
  const css = readFileSync(stylePath, 'utf8')
  const close = styleRule(css, '#account-dialog .account-dialog-close')
  const body = styleRule(css, '.account-dialog-body')
  const content = styleRule(css, '#account-dialog .config-detail-grid')
  const footer = styleRule(css, '#account-dialog .config-detail-footer')

  // Ant Design loads after style.css and gives `.ant-btn` position: relative. The account-scoped
  // selector must therefore win on specificity or the close control falls back into the left edge.
  expect(close).toContain('position: absolute')
  expect(close).toContain('right: 0.75rem')

  // Only the middle section may scroll. Keeping the footer outside that scrollport prevents a
  // short browser window from clipping the save action below the dialog edge.
  expect(body).toContain('display: flex')
  expect(body).toContain('flex-direction: column')
  expect(body).toContain('overflow: hidden')
  expect(content).toContain('overflow-y: auto')
  expect(footer).toContain('flex: 0 0 auto')
  expect(footer).not.toContain('position: sticky')

  const narrowViewport = css.slice(css.indexOf('@media (max-width: 480px)'))
  expect(styleRule(narrowViewport, '#account-dialog .config-detail-footer')).toContain(
    'flex-direction: column',
  )
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
    t: zhT,
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

it('translates static settings pane text and placeholders when the pane is first mounted', () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    flushSync(() => root.render(createElement(SettingsPaneBuiltin, { pane: 'archived', translate: zhT })))
    expect(host.querySelector('#archived-settings-pane h2')?.textContent).toBe('已归档会话')
    expect(host.querySelector<HTMLInputElement>('#archived-search')?.placeholder).toBe('搜索已归档会话')
  } finally {
    root.unmount()
    host.remove()
  }
})
