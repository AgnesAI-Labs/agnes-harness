/** @vitest-environment happy-dom */
import type { JevConfigSnapshot, JevSettings } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import { JEV_SETTINGS_MARKUP } from '@agnes/web-ui'
import { afterEach, expect, it, vi } from 'vitest'
import { createJevSettingsController } from '../src/jev-settings.js'

const settings: JevSettings = {
  transport: 'native',
  endpoint: 'https://jev.example.invalid/decision',
  model: 'jev',
  authentication: 'bearer',
  enabled: true,
}
const snapshot: JevConfigSnapshot = {
  profile: 'test',
  revision: 2,
  settings,
  configured: true,
  credentialConfigured: true,
  source: 'profile',
  effect: 'new-sessions',
}
const field = (id: string) => document.getElementById(id) as HTMLInputElement
const click = (id: string) => document.getElementById(id)?.click()
const change = (id: string, value: string) => {
  field(id).value = value
  field(id).dispatchEvent(new Event('change', { bubbles: true }))
}
function fixture(onSaved?: () => Promise<void>) {
  document.body.innerHTML = `<dialog id="config"><button id="config-close"></button>${JEV_SETTINGS_MARKUP}</dialog>`
  const jevGet = vi.fn(async () => snapshot)
  const jevTest = vi.fn(async () => ({ verified: true, model: 'jev-test' }))
  const jevSave = vi.fn(async (_input: unknown) => ({
    ...snapshot,
    revision: 3,
    effect: 'restart-required' as const,
  }))
  const controller = createJevSettingsController(
    {
      config: { jevGet, jevTest, jevSave },
    } as unknown as Client,
    onSaved,
  )
  return { controller, jevGet, jevTest, jevSave }
}
afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

it('loads only non-secret fields, derives the fixed Cloudflare target, tests and saves the memory-only key', async () => {
  const { controller, jevTest, jevSave } = fixture()
  await controller.refresh()
  expect(field('jev-key').value).toBe('')
  change('jev-transport', 'cloudflare')
  change('jev-account', 'a'.repeat(32))
  expect(field('jev-endpoint').value).toBe(
    `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/ai/run`,
  )
  expect(field('jev-endpoint').readOnly).toBe(true)
  expect(field('jev-auth').disabled).toBe(true)
  expect(field('jev-model').value).toBe('typesafe/jev')
  field('jev-key').value = 'synthetic-key'
  click('jev-test')
  await vi.waitFor(() => expect(field('jev-save').disabled).toBe(false))
  expect(jevTest).toHaveBeenCalledWith(
    expect.objectContaining({
      apiKey: 'synthetic-key',
      settings: expect.objectContaining({ transport: 'cloudflare', authentication: 'bearer' }),
    }),
  )
  expect(field('jev-key').value).toBe('')
  click('jev-save')
  await vi.waitFor(() => expect(field('jev-state').textContent).toContain('手动重启'))
  expect(jevSave).toHaveBeenCalledWith(
    expect.objectContaining({ expectedRevision: 2, apiKey: 'synthetic-key' }),
  )
  expect(field('jev-key').value).toBe('')
})

it('invalidates the tested key on target changes and supports an independently replaced pane', async () => {
  const { controller, jevSave } = fixture()
  await controller.refresh()
  document.getElementById('jev-settings-pane')?.remove()
  document.getElementById('config')?.insertAdjacentHTML('beforeend', JEV_SETTINGS_MARKUP)
  await controller.refresh()
  field('jev-key').value = 'synthetic-key'
  click('jev-test')
  await vi.waitFor(() => expect(field('jev-save').disabled).toBe(false))
  change('jev-endpoint', 'https://another.example.invalid/decision')
  click('jev-save')
  await vi.waitFor(() => expect(jevSave).toHaveBeenCalled())
  expect(jevSave.mock.calls[0]?.[0]).not.toHaveProperty('apiKey')
})

it('shows save progress in the fixed footer and refreshes runtime state after a successful save', async () => {
  const refreshed = vi.fn(async () => undefined)
  const { controller, jevSave } = fixture(refreshed)
  let finish!: () => void
  jevSave.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ ...snapshot, revision: 3, effect: 'restart-required' })
      }),
  )
  await controller.refresh()
  click('jev-save')
  expect(field('jev-state').textContent).toContain('正在保存')
  expect(field('jev-state').closest('.jev-settings-actions')).not.toBeNull()
  expect(field('jev-save').disabled).toBe(true)
  expect(refreshed).not.toHaveBeenCalled()
  finish()
  await vi.waitFor(() => expect(refreshed).toHaveBeenCalledOnce())
  expect(field('jev-state').textContent).toContain('已保存')
})

it('does not describe persisted configuration as a failed save when runtime refresh fails', async () => {
  const { controller } = fixture(async () => {
    throw new Error('runtime refresh failed')
  })
  await controller.refresh()
  click('jev-save')
  await vi.waitFor(() => expect(field('jev-error').textContent).toContain('运行方式列表刷新失败'))
  expect(field('jev-state').textContent).toContain('已保存')
  expect(field('jev-save').disabled).toBe(false)
})

it('clears a Cloudflare target when switching to native so the wrong wire shape cannot be saved', async () => {
  const { controller, jevSave } = fixture()
  await controller.refresh()
  change('jev-transport', 'cloudflare')
  change('jev-account', 'a'.repeat(32))
  expect(field('jev-endpoint').value).toContain('api.cloudflare.com')
  change('jev-transport', 'native')
  expect(field('jev-endpoint').value).toBe('')
  expect(field('jev-model').value).toBe('jev-latest')
  field('jev-key').value = 'synthetic-key'
  click('jev-save')
  await vi.waitFor(() => expect(jevSave).toHaveBeenCalled())
  expect(jevSave.mock.calls[0]?.[0]).toMatchObject({
    settings: { transport: 'native', authentication: 'bearer', endpoint: '' },
  })
})

it('names a transport mismatch instead of reporting a generic Jev failure', async () => {
  const { controller, jevSave } = fixture()
  await controller.refresh()
  jevSave.mockRejectedValueOnce({ data: { reason: 'CONFIG_JEV_TRANSPORT_MISMATCH' } })
  click('jev-save')
  await vi.waitFor(() => expect(field('jev-error').textContent).toContain('Cloudflare 地址须选择'))
  expect(field('jev-state').textContent).toContain('保存未完成')
})

it('explains a rejected credential and never submits a pasted Bearer prefix', async () => {
  const { controller, jevTest, jevSave } = fixture()
  await controller.refresh()
  field('jev-key').value = 'Bearer synthetic-key'
  click('jev-test')
  await vi.waitFor(() => expect(field('jev-error').textContent).toContain('不要包含'))
  expect(jevTest).not.toHaveBeenCalled()
  field('jev-key').value = 'synthetic-key'
  jevTest.mockRejectedValueOnce({ data: { reason: 'CONFIG_TEST_UNAUTHORIZED' } })
  click('jev-test')
  await vi.waitFor(() => expect(field('jev-error').textContent).toContain('上游拒绝了该密钥'))
  expect(field('jev-key').value).toBe('')
  jevSave.mockRejectedValueOnce({ data: { reason: 'CONFIG_TEST_UNAUTHORIZED' } })
  click('jev-save')
  await vi.waitFor(() => expect(field('jev-error').textContent).toContain('401/403'))
})

it('clears secrets on close or disconnect and ignores stale test completions', async () => {
  const { controller, jevTest } = fixture()
  let complete!: (value: { verified: boolean; model: string }) => void
  jevTest.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  await controller.refresh()
  field('jev-key').value = 'synthetic-key'
  click('jev-test')
  click('config-close')
  expect(field('jev-key').value).toBe('')
  complete({ verified: true, model: 'stale' })
  await Promise.resolve()
  expect(field('jev-state').textContent).not.toContain('stale')
  field('jev-key').value = 'another-key'
  controller.setConnected(false)
  expect(field('jev-key').value).toBe('')
  expect(field('jev-save').disabled).toBe(true)
})

it('selects and reloads Laya without reusing secrets, and retains each backend target draft', async () => {
  const { controller, jevGet, jevSave } = fixture()
  await controller.refresh()
  expect(field('jev-backend').value).toBe('jev')
  field('jev-key').value = 'synthetic-key'
  click('jev-test')
  await vi.waitFor(() => expect(field('jev-save').disabled).toBe(false))
  change('jev-backend', 'laya')
  expect(field('jev-transport').value).toBe('native')
  expect(field('jev-transport').disabled).toBe(true)
  expect(field('jev-endpoint').value).toBe('http://127.0.0.1:8791/v1/systemone')
  expect(field('jev-model').value).toBe('multilingual')
  expect(field('jev-auth').value).toBe('none')
  expect(field('jev-key').value).toBe('')
  click('jev-save')
  await vi.waitFor(() => expect(jevSave).toHaveBeenCalled())
  const saved = jevSave.mock.calls[0]?.[0] as { settings: JevSettings }
  expect(saved).toMatchObject({
    settings: { backend: 'laya', model: 'multilingual', transport: 'native', authentication: 'none' },
  })
  expect(saved).not.toHaveProperty('apiKey')
  change('jev-endpoint', 'http://127.0.0.1:8792/v1/systemone')
  change('jev-backend', 'jev')
  expect(field('jev-endpoint').value).toBe(settings.endpoint)
  expect(field('jev-model').value).toBe(settings.model)
  change('jev-backend', 'laya')
  expect(field('jev-endpoint').value).toContain(':8792/')
  jevGet.mockResolvedValueOnce({ ...snapshot, settings: saved.settings })
  await controller.refresh()
  expect(field('jev-backend').value).toBe('laya')
  expect(field('jev-model').value).toBe('multilingual')
  jevGet.mockResolvedValueOnce({
    ...snapshot,
    backends: [
      { backend: 'jev', settings, configured: true, credentialConfigured: true },
      { backend: 'laya', settings: saved.settings, configured: true, credentialConfigured: true },
    ],
  } as JevConfigSnapshot)
  await controller.refresh()
  change('jev-backend', 'laya')
  expect(field('jev-endpoint').value).toBe('http://127.0.0.1:8791/v1/systemone')
  change('jev-backend', 'jev')
  expect(field('jev-endpoint').value).toBe(settings.endpoint)
})

it('shows sanitized failures and revision conflict recovery without displaying upstream content', async () => {
  const { controller, jevTest, jevSave } = fixture()
  await controller.refresh()
  jevTest.mockRejectedValueOnce(new Error('synthetic-key upstream body'))
  field('jev-key').value = 'synthetic-key'
  click('jev-test')
  await vi.waitFor(() => expect(field('jev-error').textContent).toContain('请求失败'))
  expect(field('jev-key').value).toBe('')
  expect(field('jev-error').textContent).not.toContain('synthetic-key')
  jevSave.mockRejectedValueOnce({ data: { reason: 'CONFIG_REVISION_CONFLICT' } })
  click('jev-save')
  await vi.waitFor(() => expect(field('jev-error').textContent).toContain('其他客户端'))
})
