/** @vitest-environment happy-dom */
import { createElement } from 'react'
import { afterEach, expect, it } from 'vitest'
import { mountRegion, SettingsOptionSelect, setSettingsSelectOptions } from '../src/index.js'

let dispose: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
})

it('renders grouped settings options through React before the native picker reads them', () => {
  const host = document.createElement('div')
  document.body.append(host)
  dispose = mountRegion(host, createElement(SettingsOptionSelect, { id: 'config-provider' }))
  const select = host.querySelector<HTMLSelectElement>('#config-provider')
  if (!select) throw new Error('provider select missing')

  setSettingsSelectOptions(
    select,
    [{ label: '选择 Provider', value: '' }],
    [
      { label: 'API Key', options: [{ label: 'OpenAI', value: 'openai' }] },
      { label: '订阅登录', options: [{ label: 'OpenAI · 订阅登录', value: 'openai:oauth' }] },
    ],
  )

  expect(select.querySelectorAll('optgroup')).toHaveLength(2)
  expect([...select.options].map(({ value }) => value)).toEqual(['', 'openai', 'openai:oauth'])
  select.value = 'openai:oauth'
  setSettingsSelectOptions(
    select,
    [{ label: '选择 Provider', value: '' }],
    [{ label: '订阅登录', options: [{ label: 'OpenAI · 订阅登录', value: 'openai:oauth' }] }],
  )
  expect(select.value).toBe('openai:oauth')
  expect(select.querySelector('optgroup')?.label).toBe('订阅登录')
})
