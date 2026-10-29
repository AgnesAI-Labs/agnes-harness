/** @vitest-environment happy-dom */
import type { RuntimeAdminSnapshot } from '@agnes/protocol'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { settingsCatalog } from '../src/settings/locales.js'
import { ProvidersPanel } from '../src/settings/runtime-panels.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})

const provider = (id: string, capabilities: string[]) => ({
  kind: 'model-adapter',
  id,
  version: '1.0.0',
  sourcePackage: '@agnes/ai',
  capabilities,
  restartRequired: false,
  required: false,
  pinned: false,
  active: false,
  selectedFor: [],
})
const t = (locale: 'en' | 'zh-CN') => (key: string) => settingsCatalog[locale][key] ?? key

async function rows(locale: 'en' | 'zh-CN', providers: ReturnType<typeof provider>[]) {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const snapshot = { providers, presets: [] } as unknown as RuntimeAdminSnapshot
  await act(async () =>
    root?.render(createElement(ProvidersPanel, { snapshot, t: t(locale), kinds: ['model-adapter'] })),
  )
  return [...host.querySelectorAll('[data-testid="providers-model-adapter"] article')].map((row) => ({
    title: row.querySelector('h4')?.textContent ?? '',
    summary: row.querySelector('.agh-meta')?.textContent ?? '',
  }))
}

it('says in the model adapter list that the built-in Jev adapter takes payloads only', async () => {
  const jev = provider('typesafe-systemone', ['payload', 'payloadOnly'])
  // The summary keeps three items, so the line that matters is the one shown, not only listed below.
  expect(await rows('en', [jev])).toEqual([
    { title: 'TypeSafe Jev (side calls)', summary: 'Available · 1.0.0 · Payload requests only, no chat' },
  ])
  await act(async () => root?.unmount())
  document.body.replaceChildren()
  expect(await rows('zh-CN', [jev])).toEqual([
    { title: 'TypeSafe Jev（旁路调用）', summary: expect.stringContaining('仅载荷请求，不用于对话') },
  ])
})

it('names a mixed adapter by the payload capability alone', async () => {
  const [row] = await rows('en', [provider('acme', ['payload'])])
  expect(row?.summary).toBe('Available · 1.0.0 · Payload requests')
})
