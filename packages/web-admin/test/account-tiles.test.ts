/** @vitest-environment happy-dom */
import { mountRegion } from '@agnes/web-ui'
import { afterEach, expect, it, vi } from 'vitest'
import { defaultAccountLabel, groupProviders, providerTiles } from '../src/settings/account-tiles.js'

const provider = (id: string, oauth = false) => ({
  id,
  label: id.toUpperCase(),
  authMethods: oauth ? ['api-key', 'oauth'] : ['api-key'],
})
const dispose: (() => void)[] = []
afterEach(() => {
  for (const stop of dispose.splice(0)) stop()
  document.body.replaceChildren()
})

it('offers Agnes AI first, then the popular providers, the relays, and folds a long remainder', () => {
  // The backend's own order is not the offer order.
  const all = [
    'xai',
    'openrouter',
    'minimax',
    'kimi-coding',
    'groq',
    'zai',
    'openai',
    'deepseek',
    'openai-compatible',
    'agnes-ai',
  ].map((id) => provider(id, id === 'openai'))
  const grouped = groupProviders(all)
  expect(grouped.popular.map((item) => item.id)).toEqual(['agnes-ai', 'deepseek', 'openai', 'zai'])
  expect(grouped.relay.map((item) => item.id)).toEqual(['openrouter'])
  expect(grouped.more.map((item) => item.id)).toEqual(['xai', 'minimax', 'kimi-coding', 'groq'])
  // A short remainder is not worth a fold.
  const few = groupProviders([provider('xai'), provider('agnes-ai'), provider('deepseek')])
  expect(few.popular.map((item) => item.id)).toEqual(['agnes-ai', 'deepseek', 'xai'])
  expect(few.more).toEqual([])

  const select = vi.fn()
  const host = document.createElement('div')
  document.body.append(host)
  dispose.push(
    mountRegion(
      host,
      providerTiles(all, (key) => key, select),
    ),
  )
  const tiles = (selector: string) =>
    [...(host.querySelector(selector)?.querySelectorAll('button') ?? [])].map((tile) => tile.dataset.provider)
  expect(tiles('.account-provider-groups > .account-provider-choices')).toEqual([
    'agnes-ai',
    'agnes-ai:international',
    'deepseek',
    'openai',
    'zai',
    'openai-compatible',
  ])
  expect(tiles('[data-testid="account-relays"]')).toEqual([
    'openrouter',
    'preset:siliconflow',
    'preset:302ai',
    'preset:aihubmix',
    'preset:volcengine-ark',
    'preset:dashscope',
  ])
  const top = host.querySelector('.account-provider-groups > .account-provider-choices')
  expect(top?.querySelector('[data-provider="agnes-ai"] small')?.textContent).toBe('accounts.recommended')
  expect(top?.querySelector('[data-provider="openai"] small')?.textContent).toBe('accounts.keyOrLoginHint')
  const more = host.querySelector<HTMLElement>('[data-testid="account-more-providers"]')
  expect(more?.dataset.open).toBe('false')
  expect(more?.querySelector('.agh-disclosure-meta')?.textContent).toBe('4')
  more?.querySelector<HTMLButtonElement>('[data-provider="xai"]')?.click()
  top?.querySelector<HTMLButtonElement>('[data-provider="openai-compatible"]')?.click()
  host.querySelector<HTMLButtonElement>('[data-provider="preset:siliconflow"]')?.click()
  top?.querySelector<HTMLButtonElement>('[data-provider="agnes-ai:international"]')?.click()
  expect(select.mock.calls).toEqual([
    ['xai'],
    ['openai-compatible'],
    ['openai-compatible', { label: 'accounts.preset.siliconflow', baseUrl: 'https://api.siliconflow.cn/v1' }],
    ['agnes-ai', { label: 'accounts.agnesInternational', baseUrl: 'https://apihub.agnes-ai.com/v1' }],
  ])
})

it('names a new account after its provider and numbers a second one', () => {
  expect(defaultAccountLabel('DeepSeek', [])).toBe('DeepSeek')
  expect(defaultAccountLabel('DeepSeek', ['DeepSeek'])).toBe('DeepSeek 2')
  expect(defaultAccountLabel('DeepSeek', ['DeepSeek', 'DeepSeek 2'])).toBe('DeepSeek 3')
  expect(defaultAccountLabel('', ['x'])).toBe('')
})
