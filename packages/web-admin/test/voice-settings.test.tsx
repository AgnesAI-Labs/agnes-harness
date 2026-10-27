/** @vitest-environment happy-dom */
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings, type VoiceSettingsSnapshot } from '@agnes/protocol'
import { settingsSections, type VoiceSettingsApi } from '@agnes/web-client'
import { createDocumentLocaleSource, UiLocaleProvider } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { registerVoiceSettingsSection, VoiceSettingsPanel } from '../src/settings/voice.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Root[] = []
const disposers: Array<() => void> = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  for (const dispose of disposers.splice(0)) dispose()
  document.body.replaceChildren()
  document.documentElement.lang = 'en'
  vi.useRealTimers()
})

const D: VoiceSettings = structuredClone(DEFAULT_VOICE_SETTINGS)
const REV0 = '0'.repeat(64)
const REV1 = '1'.repeat(64)
const REV2 = '2'.repeat(64)
const ACCOUNTS = [
  { route: 'account-siliconflow', label: '硅基流动' },
  { route: 'account-openai', label: 'OpenAI' },
]

type FakeApi = VoiceSettingsApi & {
  read: ReturnType<typeof vi.fn<VoiceSettingsApi['read']>>
  save: ReturnType<typeof vi.fn<VoiceSettingsApi['save']>>
  accounts: ReturnType<typeof vi.fn<VoiceSettingsApi['accounts']>>
  openSideModels: ReturnType<typeof vi.fn<VoiceSettingsApi['openSideModels']>>
}
function fakeApi(stored: VoiceSettings = D): FakeApi {
  const revisions = [REV1, REV2]
  return {
    read: vi.fn(
      async (): Promise<VoiceSettingsSnapshot> => ({ revision: REV0, settings: structuredClone(stored) }),
    ),
    save: vi.fn(async (settings: VoiceSettings): Promise<VoiceSettingsSnapshot> => {
      const revision = revisions.shift() ?? REV2
      return { revision, settings: structuredClone(settings) }
    }),
    accounts: vi.fn(async () => ACCOUNTS),
    openSideModels: vi.fn(),
  }
}

async function mount(api: VoiceSettingsApi) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  // The app provides the document language; without a provider the section reads English.
  const locale = createDocumentLocaleSource({})
  disposers.push(locale.dispose)
  await act(async () =>
    root.render(
      createElement(UiLocaleProvider, { source: locale.source }, createElement(VoiceSettingsPanel, { api })),
    ),
  )
  await act(async () => {})
  return host
}
const query = (host: HTMLElement, testid: string) =>
  host.querySelector<HTMLElement>(`[data-testid="${testid}"]`)
const field = (host: HTMLElement, testid: string) => {
  const node = host.querySelector<HTMLInputElement>(`[data-testid="${testid}"]`)
  if (!node) throw new Error(`missing ${testid}`)
  return node
}
const options = (host: HTMLElement, testid: string) =>
  [...(host.querySelector<HTMLSelectElement>(`[data-testid="${testid}"]`)?.options ?? [])].map(
    (option) => [option.value, option.textContent] as const,
  )
async function choose(host: HTMLElement, testid: string, value: string) {
  await act(async () => {
    const select = host.querySelector<HTMLSelectElement>(`[data-testid="${testid}"]`)
    if (!select) throw new Error(`missing ${testid}`)
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
async function toggle(host: HTMLElement, testid: string) {
  await act(async () => field(host, testid).click())
}
async function type(host: HTMLElement, testid: string, text: string, blur = true) {
  await act(async () => {
    const node = field(host, testid)
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(node, text)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
  if (blur)
    await act(async () => field(host, testid).dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
}

it('lists voice accounts by name and saves the route', async () => {
  const api = fakeApi()
  const host = await mount(api)
  expect(options(host, 'voice-account')).toEqual([
    ['', 'Automatic (the only voice account)'],
    ['account-siliconflow', '硅基流动'],
    ['account-openai', 'OpenAI'],
  ])
  await choose(host, 'voice-account', 'account-openai')
  expect(api.save).toHaveBeenCalledTimes(1)
  expect(api.save).toHaveBeenCalledWith({ ...D, account: 'account-openai' }, REV0)
  await choose(host, 'voice-account', '')
  // The second save carries the revision the first one returned.
  expect(api.save).toHaveBeenLastCalledWith(D, REV1)
})

it('keeps a saved account that is no longer listed visible instead of showing Automatic', async () => {
  const api = fakeApi({ ...D, account: 'account-gone' })
  const host = await mount(api)
  expect(host.querySelector<HTMLSelectElement>('[data-testid="voice-account"]')?.value).toBe('account-gone')
})

it('saves each switch at once, numbers on blur, and refuses an out-of-range value', async () => {
  const api = fakeApi()
  const host = await mount(api)
  await toggle(host, 'voice-auto-read')
  expect(api.save).toHaveBeenLastCalledWith({ ...D, reading: { ...D.reading, autoRead: true } }, REV0)
  await toggle(host, 'voice-input-enabled')
  expect(api.save).toHaveBeenLastCalledWith(
    { ...D, input: { ...D.input, enabled: false }, reading: { ...D.reading, autoRead: true } },
    REV1,
  )
  api.save.mockClear()
  // A decimal can be typed: the field keeps what was typed until it is valid.
  await type(host, 'voice-speed', '1.', false)
  expect(field(host, 'voice-speed').value).toBe('1.')
  await type(host, 'voice-speed', '1.5')
  expect(api.save.mock.calls.at(-1)?.[0].reading.speed).toBe(1.5)
  api.save.mockClear()
  await type(host, 'voice-speed', '5')
  expect(query(host, 'voice-speed-error')?.textContent).toMatch(/0\.25/)
  await type(host, 'voice-max-seconds', '4')
  await type(host, 'voice-pause', 'abc')
  expect(query(host, 'voice-max-seconds-error')).not.toBeNull()
  expect(query(host, 'voice-pause-error')).not.toBeNull()
  expect(api.save).not.toHaveBeenCalled()
  await type(host, 'voice-max-seconds', '60')
  await type(host, 'voice-pause', '2')
  expect(query(host, 'voice-max-seconds-error')).toBeNull()
  expect(api.save.mock.calls.at(-1)?.[0]).toMatchObject({
    input: { maxSeconds: 60 },
    conversation: { pauseSeconds: 2 },
  })
})

it('reverts only the invalid field, keeping a switch whose save is still on its way', async () => {
  const api = fakeApi()
  let release: (() => void) | undefined
  api.save.mockImplementationOnce(
    (settings) =>
      new Promise((resolve) => {
        release = () => resolve({ revision: REV1, settings: structuredClone(settings) })
      }),
  )
  const host = await mount(api)
  await toggle(host, 'voice-auto-read')
  expect(api.save).toHaveBeenCalledTimes(1)
  await type(host, 'voice-speed', '5')
  expect(query(host, 'voice-speed-error')).not.toBeNull()
  expect(field(host, 'voice-auto-read').getAttribute('aria-checked')).toBe('true')
  await act(async () => release?.())
  await act(async () => {})
  for (const [sent] of api.save.mock.calls) {
    expect(sent.reading.autoRead).toBe(true)
    expect(sent.reading.speed).toBe(D.reading.speed)
  }
  expect(field(host, 'voice-auto-read').getAttribute('aria-checked')).toBe('true')
})

it('saves a typed value after typing pauses, without a blur', async () => {
  const api = fakeApi()
  const host = await mount(api)
  vi.useFakeTimers()
  await type(host, 'voice-voice', 'anna', false)
  expect(api.save).not.toHaveBeenCalled()
  await act(async () => vi.advanceTimersByTime(1000))
  vi.useRealTimers()
  await act(async () => {})
  expect(api.save.mock.calls.at(-1)?.[0].reading.voice).toBe('anna')
})

it('accepts only a language code the daemon accepts, or an empty one', async () => {
  const api = fakeApi()
  const host = await mount(api)
  await type(host, 'voice-language', '中文')
  expect(query(host, 'voice-language-error')).not.toBeNull()
  expect(api.save).not.toHaveBeenCalled()
  await type(host, 'voice-language', 'zh-CN')
  expect(query(host, 'voice-language-error')).toBeNull()
  expect(api.save.mock.calls.at(-1)?.[0].input.language).toBe('zh-CN')
  await type(host, 'voice-language', '')
  expect(api.save.mock.calls.at(-1)?.[0].input.language).toBe('')
})

it('shows the privacy note and opens the side-model block', async () => {
  const api = fakeApi()
  const host = await mount(api)
  expect(query(host, 'voice-privacy')?.textContent).toBe(
    'Recordings and reply text are sent to the chosen provider',
  )
  await act(async () => query(host, 'voice-configure')?.click())
  expect(api.openSideModels).toHaveBeenCalledTimes(1)
})

it('shows the section in Chinese', async () => {
  document.documentElement.lang = 'zh-CN'
  const host = await mount(fakeApi())
  expect(query(host, 'voice-privacy')?.textContent).toBe('录音和回复文字会发给所选服务商')
  expect(options(host, 'voice-account')[0]).toEqual(['', '自动（唯一的语音账户）'])
  expect(query(host, 'voice-configure')?.textContent).toBe('去配置')
})

it('reloads after a revision conflict and says so', async () => {
  const api = fakeApi()
  api.read
    .mockResolvedValueOnce({ revision: REV0, settings: structuredClone(D) })
    .mockResolvedValueOnce({ revision: REV2, settings: { ...D, reading: { ...D.reading, speed: 2 } } })
  api.save.mockRejectedValueOnce(
    Object.assign(new Error('conflict'), {
      data: { code: 'SEMANTIC_REJECTED', reason: 'CONFIG_REVISION_CONFLICT' },
    }),
  )
  const host = await mount(api)
  await toggle(host, 'voice-auto-read')
  expect(api.read).toHaveBeenCalledTimes(2)
  expect(query(host, 'voice-conflict')).not.toBeNull()
  // The page shows what is stored now, not the edit that lost.
  expect(field(host, 'voice-speed').value).toBe('2')
  expect(field(host, 'voice-auto-read').getAttribute('aria-checked')).toBe('false')
  // The next edit builds on the reloaded revision.
  await toggle(host, 'voice-auto-read')
  expect(api.save).toHaveBeenLastCalledWith(
    { ...D, reading: { ...D.reading, speed: 2, autoRead: true } },
    REV2,
  )
  expect(query(host, 'voice-conflict')).toBeNull()
})

it('tells a failed save and a failed read apart from a conflict', async () => {
  const api = fakeApi()
  api.save.mockRejectedValueOnce(new Error('down'))
  const host = await mount(api)
  await toggle(host, 'voice-auto-read')
  expect(query(host, 'settings-save-failed')).not.toBeNull()
  expect(query(host, 'voice-conflict')).toBeNull()
  expect(api.read).toHaveBeenCalledTimes(1)
})

it('registers the voice section under General', () => {
  const dispose = registerVoiceSettingsSection(fakeApi())
  expect(settingsSections.get('voice')).toMatchObject({
    id: 'voice',
    group: 'general',
    order: 20,
    icon: 'mic',
    runtimeCatalog: false,
    titleKey: 'settings-shell.voice',
    groupTitleKey: 'settings-shell.group.general',
  })
  dispose()
  expect(settingsSections.get('voice')).toBeUndefined()
})
