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
    'accounts.defaultThinkingLabel': '思考等级 · translated',
    'accounts.contextBudgetLabel': '上下文预算 · translated',
    'accounts.contextBudgetPlaceholder': '自动预算 · translated',
    'accounts.modelSettingsHint': '新会话沿用默认值 · translated',
  }

  try {
    flushSync(() =>
      root.render(
        createElement(SettingsAccountDialog, {
          t: (key) => translatedLabels[key] ?? key,
        }),
      ),
    )
    const advanced = host.querySelector<HTMLElement>('#config-account-advanced')!
    expect(advanced.dataset.open).toBe('false')
    for (const id of [
      'config-account-name',
      'config-base-url',
      'config-auth-method',
      'config-context-window',
    ])
      expect(advanced.querySelector(`#${id}`)).not.toBeNull()
    // The key, its test result, the default model and thinking effort are the main area.
    for (const id of ['config-api-key', 'config-model', 'config-thinking', 'config-state', 'config-error']) {
      expect(host.querySelector(`#${id}`)).not.toBeNull()
      expect(advanced.querySelector(`#${id}`)).toBeNull()
    }
    // The status line sits between the key and the model it unlocks.
    const order = [...host.querySelectorAll('#config-api-key, #config-state, #config-model')].map(
      (element) => element.id,
    )
    expect(order).toEqual(['config-api-key', 'config-state', 'config-model'])
    expect(host.querySelectorAll('.agh-btn--primary')).toHaveLength(1)
    expect(host.querySelector('#config-provider')?.closest('label')?.textContent).toContain(
      'Provider · translated',
    )
    expect(host.querySelector('#config-base-url')?.closest('label')?.textContent).toContain('服务地址')
    expect(host.querySelector('#config-api-key')?.closest('label')?.textContent).toContain(
      'API Key · translated',
    )
    expect(host.querySelector('#config-thinking')?.closest('label')?.textContent).toContain(
      '思考等级 · translated',
    )
    expect(host.querySelector('#config-context-window')?.closest('label')?.textContent).toContain(
      '上下文预算 · translated',
    )
    expect(host.querySelector('#config-context-window')?.getAttribute('placeholder')).toBe(
      '自动预算 · translated',
    )
    expect(host.querySelector('#config-model-settings-hint')?.textContent).toBe(
      '新会话沿用默认值 · translated',
    )
    const key = host.querySelector<HTMLInputElement>('#config-api-key')!
    expect(key.type).toBe('password')
    expect(key.autocomplete).toBe('new-password')
    expect(key.getAttribute('aria-describedby')).toBe('config-key-hint')
    expect(host.querySelector<HTMLInputElement>('#config-account-name')?.maxLength).toBe(128)
    expect(host.querySelector<HTMLInputElement>('#config-context-window')?.maxLength).toBe(32)
    expect(host.querySelector<HTMLButtonElement>('#config-save')?.getAttribute('form')).toBe('config-form')
  } finally {
    root.unmount()
    host.remove()
  }
})
