/** @vitest-environment happy-dom */

import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { SettingsAccountDialog } from '../src/settings-account-dialog.js'

it('uses the injected catalog for provider, base URL and API key field labels', () => {
  const host = document.createElement('div')
  document.body.append(host)
  const inline = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const translatedLabels: Record<string, string> = {
    'accounts.providerLabel': '服务商 · translated',
    'accounts.connectNext': '填写密钥或登录，然后选择模型并保存。',
    'accounts.baseUrlLabel': '服务地址',
    'accounts.apiKeyLabel': 'API Key · translated',
    'accounts.keyPlaceholderNew': '粘贴 API Key · translated',
    'accounts.keyHelp': '在哪里获取 · translated',
    'accounts.keyHelpText': '密钥说明 · translated',
    'accounts.showKey': '显示密钥 · translated',
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
    // Advanced options hold only the account's name, its address and its timeouts.
    for (const id of ['config-account-name', 'config-base-url', 'config-account-network'])
      expect(advanced.querySelector(`#${id}`)).not.toBeNull()
    // The provider, how it connects, the key and its result, and the default model group with its
    // context budget are the main area.
    const main = [
      'config-provider-card',
      'config-auth-method',
      'config-api-key',
      'config-state',
      'config-error',
      'config-test',
      'config-model-lock',
      'config-model',
      'config-thinking',
      'config-context-window',
    ]
    for (const id of main) {
      expect(host.querySelector(`#${id}`)).not.toBeNull()
      expect(advanced.querySelector(`#${id}`)).toBeNull()
    }
    // Reading order: the provider, how it connects, the key, its result, then what it unlocks.
    const order = [
      ...host.querySelectorAll(
        '#config-provider-card, #config-auth-method, #config-api-key, #config-state, #config-model, #config-context-window, #config-account-advanced',
      ),
    ].map((element) => element.id)
    expect(order).toEqual([
      'config-provider-card',
      'config-auth-method',
      'config-api-key',
      'config-state',
      'config-model',
      'config-context-window',
      'config-account-advanced',
    ])
    expect(host.querySelectorAll('.agh-btn--primary')).toHaveLength(1)
    const labelOf = (id: string) => host.querySelector(`label[for="${id}"]`)?.textContent
    expect(labelOf('config-provider')).toContain('服务商 · translated')
    expect(host.textContent).toContain('填写密钥或登录，然后选择模型并保存。')
    expect(labelOf('config-base-url')).toContain('服务地址')
    expect(labelOf('config-api-key')).toContain('API Key · translated')
    expect(labelOf('config-thinking')).toContain('思考等级 · translated')
    // The budget names the model's capacity beside its label and its unit inside the field.
    expect(labelOf('config-context-window')).toContain('上下文预算 · translated')
    expect(host.querySelector('#config-model-capacity')?.closest('label')?.htmlFor).toBe(
      'config-context-window',
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
    // A new account asks for a key; the edit page's keep-current text is the controller's.
    expect(key.placeholder).toBe('粘贴 API Key · translated')
    expect(key.getAttribute('aria-describedby')).toBe('config-key-hint')
    // 「在哪里获取？」 opens its note in place, between the label and the key.
    const help = host.querySelector<HTMLButtonElement>('button[aria-controls="config-key-help"]')!
    expect(help.textContent).toBe('在哪里获取 · translated')
    expect(help.getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector<HTMLElement>('#config-key-help')?.hidden).toBe(true)
    flushSync(() => help.click())
    expect(help.getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelector<HTMLElement>('#config-key-help')?.hidden).toBe(false)
    expect(
      [...host.querySelectorAll('label[for="config-api-key"], #config-key-help, #config-api-key')].map(
        (element) => element.id || 'label',
      ),
    ).toEqual(['label', 'config-key-help', 'config-api-key'])
    // The key can be shown while it is typed.
    key.value = 'typed draft'
    flushSync(() =>
      host.querySelector<HTMLButtonElement>('button[aria-label="显示密钥 · translated"]')?.click(),
    )
    expect(key.type).toBe('text')
    expect(key.value).toBe('typed draft')
    expect(host.querySelector<HTMLInputElement>('#config-account-name')?.maxLength).toBe(128)
    expect(host.querySelector<HTMLInputElement>('#config-context-window')?.maxLength).toBe(32)
    expect(host.querySelector<HTMLButtonElement>('#config-save')?.getAttribute('form')).toBe('config-form')
    const body = host.querySelector<HTMLElement>('.account-dialog-body')!
    inline.append(body)
    const name = body.querySelector<HTMLInputElement>('#config-account-name')!
    name.value = 'Preserved inline draft'
    flushSync(() => advanced.querySelector<HTMLButtonElement>('.agh-disclosure-summary')?.click())
    expect(advanced.dataset.open).toBe('true')
    expect(name.value).toBe('Preserved inline draft')
    host.querySelector('#account-dialog')!.append(body)
    flushSync(() => advanced.querySelector<HTMLButtonElement>('.agh-disclosure-summary')?.click())
    expect(advanced.dataset.open).toBe('false')
    expect(name.value).toBe('Preserved inline draft')
  } finally {
    root.unmount()
    host.remove()
    inline.remove()
  }
})
