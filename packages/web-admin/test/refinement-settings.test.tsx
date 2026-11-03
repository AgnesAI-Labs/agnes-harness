/** @vitest-environment happy-dom */
import { DEFAULT_REFINEMENT_SETTINGS, type RefinementSettings } from '@agnes/protocol'
import { settingsSections } from '@agnes/web-client'
import {
  createDocumentLocaleSource,
  installFeedbackSink,
  type OperationFeedback,
  UiLocaleProvider,
} from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import {
  type RefinementSettingsApi,
  RefinementSettingsPanel,
  registerRefinementSettingsSection,
} from '../src/settings/refinement.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Root[] = []
const disposers: Array<() => void> = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  for (const dispose of disposers.splice(0)) dispose()
  document.body.replaceChildren()
  document.documentElement.lang = 'en'
})

const OFF: RefinementSettings = { ...DEFAULT_REFINEMENT_SETTINGS }
const REV0 = '0'.repeat(64)
const REV1 = '1'.repeat(64)
const REV2 = '2'.repeat(64)

/** Collects what the settings page publishes to the shell, as the shell's toast would receive it. */
function feedbackSpy(): OperationFeedback[] {
  const published: OperationFeedback[] = []
  disposers.push(installFeedbackSink({ publish: (result) => published.push(result), resolve: () => {} }))
  return published
}
const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 20))

type FakeApi = RefinementSettingsApi & {
  read: ReturnType<typeof vi.fn<RefinementSettingsApi['read']>>
  save: ReturnType<typeof vi.fn<RefinementSettingsApi['save']>>
}
function fakeApi(stored: RefinementSettings = OFF): FakeApi {
  const revisions = [REV1, REV2]
  return {
    read: vi.fn(async () => ({ revision: REV0, settings: structuredClone(stored) })),
    save: vi.fn(async () => ({ revision: revisions.shift() ?? REV2 })),
  }
}

async function mount(api: RefinementSettingsApi) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  const locale = createDocumentLocaleSource({})
  disposers.push(locale.dispose)
  await act(async () =>
    root.render(
      createElement(
        UiLocaleProvider,
        { source: locale.source },
        createElement(RefinementSettingsPanel, { api }),
      ),
    ),
  )
  await act(async () => {})
  return host
}
const query = (host: HTMLElement, testid: string) =>
  host.querySelector<HTMLElement>(`[data-testid="${testid}"]`)
const field = (host: HTMLElement, testid: string) => {
  const node = query(host, testid)
  if (!node) throw new Error(`missing ${testid}`)
  return node
}
async function toggle(host: HTMLElement, testid: string) {
  await act(async () => field(host, testid).click())
}
async function choose(host: HTMLElement, testid: string, value: string) {
  await act(async () => {
    const select = field(host, testid) as HTMLSelectElement
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

it('the settings panel saves with revision and shows the permission text', async () => {
  const api = fakeApi()
  const host = await mount(api)
  // Off by default, in manual mode; nothing has been saved by opening the section.
  expect(field(host, 'refinement-enabled').getAttribute('aria-checked')).toBe('false')
  expect((field(host, 'refinement-mode') as HTMLSelectElement).value).toBe('manual')
  expect(api.save).not.toHaveBeenCalled()
  // What turning it on allows, one by one, each marked as not available yet.
  const permissions = field(host, 'refinement-permissions').textContent ?? ''
  expect(permissions).toContain('Install proven skills in the workspace')
  expect(permissions).toContain('Let the model save skills in the workspace')
  expect(permissions).toContain('Let the model save memory in the workspace')
  expect(permissions.match(/Not available yet/g)).toHaveLength(3)
  expect(field(host, 'refinement-allows-undo').textContent).toContain('Nothing is brought back')
  // The expectations the user should have, said plainly.
  expect(host.textContent).toContain('Turning it on reaches the tools the next time the host starts')
  expect(host.textContent).toContain('Turning it off takes effect at once')
  expect(field(host, 'refinement-approvals').textContent).toContain('more commands')

  await toggle(host, 'refinement-enabled')
  expect(api.save).toHaveBeenLastCalledWith({ enabled: true, mode: 'manual' }, REV0)
  expect(field(host, 'refinement-enabled').getAttribute('aria-checked')).toBe('true')
  expect(query(host, 'refinement-restart')?.textContent).toContain('Restart')
  // The next save carries the revision the first one returned.
  await choose(host, 'refinement-mode', 'auto')
  expect(api.save).toHaveBeenLastCalledWith({ enabled: true, mode: 'auto' }, REV1)
  // Turning it off is immediate: no restart note is left behind.
  await toggle(host, 'refinement-enabled')
  expect(api.save).toHaveBeenLastCalledWith({ enabled: false, mode: 'auto' }, REV2)
  expect(query(host, 'refinement-restart')).toBeNull()
})

it('does not claim a restart is needed for a switch that was already on', async () => {
  const host = await mount(fakeApi({ enabled: true, mode: 'auto' }))
  expect(field(host, 'refinement-enabled').getAttribute('aria-checked')).toBe('true')
  expect((field(host, 'refinement-mode') as HTMLSelectElement).value).toBe('auto')
  expect(query(host, 'refinement-restart')).toBeNull()
})

it('a revision conflict keeps its banner and reports no success, once the real queue has run', async () => {
  const published = feedbackSpy()
  const api = fakeApi()
  api.read
    .mockResolvedValueOnce({ revision: REV0, settings: structuredClone(OFF) })
    .mockResolvedValueOnce({ revision: REV2, settings: { enabled: false, mode: 'auto' } })
  api.save.mockRejectedValueOnce(
    Object.assign(new Error('conflict'), {
      data: { code: 'SEMANTIC_REJECTED', reason: 'CONFIG_REVISION_CONFLICT' },
    }),
  )
  const host = await mount(api)
  // As in a browser: no act() around the click, so React renders on its own schedule and the save's
  // continuation runs before the re-render that replaces the section.
  const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  env.IS_REACT_ACT_ENVIRONMENT = false
  try {
    field(host, 'refinement-enabled').click()
    await macrotask()
    await macrotask()
  } finally {
    env.IS_REACT_ACT_ENVIRONMENT = true
  }
  expect(query(host, 'refinement-conflict')).not.toBeNull()
  expect(published).toEqual([])
  expect(field(host, 'refinement-enabled').getAttribute('aria-checked')).toBe('false')
  expect(query(host, 'settings-save-failed')).toBeNull()
})

it('reports the saved switch, with a restart notice when it was turned on', async () => {
  const published = feedbackSpy()
  const host = await mount(fakeApi())
  await toggle(host, 'refinement-enabled')
  await macrotask()
  expect(published).toHaveLength(1)
  expect(published[0]).toMatchObject({ outcome: 'success', effect: { kind: 'restart-required' } })
  await toggle(host, 'refinement-enabled')
  await macrotask()
  expect(published.at(-1)?.outcome).toBe('success')
  expect(published.at(-1)?.effect).toBeUndefined()
})

it('reloads after a revision conflict and says so', async () => {
  const api = fakeApi()
  api.read
    .mockResolvedValueOnce({ revision: REV0, settings: structuredClone(OFF) })
    .mockResolvedValueOnce({ revision: REV2, settings: { enabled: false, mode: 'auto' } })
  api.save.mockRejectedValueOnce(
    Object.assign(new Error('conflict'), {
      data: { code: 'SEMANTIC_REJECTED', reason: 'CONFIG_REVISION_CONFLICT' },
    }),
  )
  const host = await mount(api)
  await toggle(host, 'refinement-enabled')
  expect(api.read).toHaveBeenCalledTimes(2)
  expect(query(host, 'refinement-conflict')).not.toBeNull()
  // The page shows what is stored now, not the edit that lost.
  expect(field(host, 'refinement-enabled').getAttribute('aria-checked')).toBe('false')
  expect((field(host, 'refinement-mode') as HTMLSelectElement).value).toBe('auto')
  // The next edit builds on the reloaded revision.
  await toggle(host, 'refinement-enabled')
  expect(api.save).toHaveBeenLastCalledWith({ enabled: true, mode: 'auto' }, REV2)
  expect(query(host, 'refinement-conflict')).toBeNull()
})

it('tells a failed save and a failed read apart from a conflict', async () => {
  const api = fakeApi()
  api.save.mockRejectedValueOnce(new Error('down'))
  const host = await mount(api)
  await toggle(host, 'refinement-enabled')
  expect(query(host, 'settings-save-failed')).not.toBeNull()
  expect(query(host, 'refinement-conflict')).toBeNull()
  expect(api.read).toHaveBeenCalledTimes(1)
  const broken = fakeApi()
  broken.read.mockRejectedValueOnce(new Error('down'))
  const failedHost = await mount(broken)
  expect(query(failedHost, 'refinement-enabled')).toBeNull()
  expect(failedHost.querySelector('[role="alert"], [data-tone="error"]')).not.toBeNull()
})

it('shows the section in Chinese', async () => {
  document.documentElement.lang = 'zh-CN'
  const host = await mount(fakeApi())
  const text = host.textContent ?? ''
  expect(text).toContain('开启要等宿主下次启动才会让工具出现')
  expect(text).toContain('关闭则立即生效')
  expect(text).toContain('可能出现更多命令审批')
  expect(field(host, 'refinement-permissions').textContent?.match(/暂未提供/g)).toHaveLength(3)
})

it('registers the section under General', () => {
  const dispose = registerRefinementSettingsSection(fakeApi())
  expect(settingsSections.get('refinement')).toMatchObject({
    group: 'general',
    titleKey: 'settings-shell.refinement',
    runtimeCatalog: false,
  })
  dispose()
  expect(settingsSections.get('refinement')).toBeUndefined()
})
