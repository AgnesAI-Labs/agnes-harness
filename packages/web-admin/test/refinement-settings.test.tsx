/** @vitest-environment happy-dom */
import { DEFAULT_REFINEMENT_SETTINGS, type RefinementSettings } from '@agnes/protocol'
import { CREDENTIALS_CHANGED } from '@agnes/resource-control-web/credentials-api'
import {
  createDocumentLocaleSource,
  installFeedbackSink,
  type OperationFeedback,
  UiLocaleProvider,
} from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { type RefinementSettingsApi, RefinementSettingsPanel } from '../src/settings/refinement.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Root[] = []
const disposers: Array<() => void> = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  for (const dispose of disposers.splice(0)) dispose()
  document.body.replaceChildren()
  document.documentElement.lang = 'en'
})

const credentialRef = 'secret://generic/review'
const model = 'company/review-a'
const another = 'company/review-b'
const baseUrl = 'https://review.example/v1'
const alternateUrl = 'https://alternate-review.example/v1'
const catalogue = {
  models: [
    { id: model, name: 'Company Review A', contextWindow: 65536, maxTokens: 4096 },
    { id: another, name: 'Company Review B', contextWindow: 90000, maxTokens: 4096 },
  ],
}
const OFF: RefinementSettings = { enabled: false, mode: 'manual', credentialRef, model }
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
  models: ReturnType<typeof vi.fn<RefinementSettingsApi['models']>>
}
function fakeApi(stored: RefinementSettings = OFF): FakeApi {
  const revisions = [REV1, REV2]
  return {
    createKey: vi.fn(async () => credentialRef),
    models: vi.fn(async () => catalogue),
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
/** The help beside the switch: an icon reached by focus, its text read on hover or focus. */
const switchHelp = (host: HTMLElement) =>
  query(host, 'refinement-enabled')
    ?.closest('.agnes-settings-item')
    ?.querySelector<HTMLElement>('[role="note"]')
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
  // What turning it on allows, one by one; every grant is in force.
  const permissions = field(host, 'refinement-permissions').textContent ?? ''
  expect(permissions).toContain('Install proven skills in the workspace')
  expect(permissions).toContain('Let the model save skills in the workspace')
  expect(permissions).toContain('Let the model save memory in the workspace')
  expect(permissions).not.toMatch(/later release/)
  for (const name of [
    'allows-install',
    'allows-skill',
    'allows-memory',
    'allows-user',
    'allows-undo',
    'approvals',
    'cost',
  ]) {
    expect(field(host, `refinement-${name}`).matches('p.agnes-settings-note')).toBe(true)
  }
  expect(field(host, 'refinement-allows-undo').textContent).toContain('Nothing is brought back')
  // When it takes effect, said plainly in the help beside the switch, which keyboard users reach too.
  const help = switchHelp(host)
  expect(help?.getAttribute('aria-label')).toBe(
    'Applies to sessions opened after you turn it on; sessions already open are not affected. Turning it off applies to all sessions at once. To keep lessons for later sessions, also turn workspace memory on (Settings → General → Personalization → Memory: "Ask me first" or "Automatic"); while it is off, lessons last only for the session they were learned in.',
  )
  expect(help?.getAttribute('tabindex')).toBe('0')
  // How the reviews are paid for, beside the switch that agrees to it.
  const billing = field(host, 'refinement-billing')
  expect(billing.closest('.agnes-settings-item')).toBe(
    field(host, 'refinement-enabled').closest('.agnes-settings-item'),
  )
  expect(billing.textContent).toBe(
    'Reviews use your llm.sg key and are billed by usage. AGH does not know the price; the token budget limits how much each session uses.',
  )
  expect(field(host, 'refinement-approvals').textContent).toMatch(/^More command approvals: .*more commands/)

  await toggle(host, 'refinement-enabled')
  expect(api.save).toHaveBeenLastCalledWith({ credentialRef, model, enabled: true, mode: 'manual' }, REV0)
  expect(field(host, 'refinement-enabled').getAttribute('aria-checked')).toBe('true')
  // Turning it on needs no restart, so nothing asks for one.
  expect(host.textContent).not.toMatch(/restart/i)
  // The next save carries the revision the first one returned.
  await choose(host, 'refinement-mode', 'auto')
  expect(api.save).toHaveBeenLastCalledWith({ credentialRef, model, enabled: true, mode: 'auto' }, REV1)
  await toggle(host, 'refinement-enabled')
  expect(api.save).toHaveBeenLastCalledWith({ credentialRef, model, enabled: false, mode: 'auto' }, REV2)
  expect(host.textContent).not.toMatch(/restart/i)
})

it.each([true, false])('switches service addresses with the saved key (keeps model: %s)', async (keep) => {
  const initial = { credentialRef, model, mode: 'manual', enabled: true, baseUrl } as const
  const api = fakeApi(initial)
  api.read.mockResolvedValue({ revision: REV0, settings: initial, endpoints: [baseUrl, alternateUrl] })
  const selected = keep ? model : another
  let release = () => {}
  const nextCatalogue = new Promise<typeof catalogue>((resolve) => {
    release = () => resolve({ models: catalogue.models.filter(({ id }) => id === selected) })
  })
  api.models.mockResolvedValueOnce(catalogue).mockReturnValueOnce(nextCatalogue)
  const host = await mount(api)
  const endpointSelect = field(host, 'refinement-endpoint') as HTMLSelectElement
  const modelSelect = field(host, 'refinement-model') as HTMLSelectElement
  const enable = field(host, 'refinement-enabled') as HTMLButtonElement
  expect(Array.from(endpointSelect.options, ({ value }) => value)).toEqual([baseUrl, alternateUrl])
  expect(endpointSelect.value).toBe(baseUrl)
  expect(
    endpointSelect.closest('.agnes-settings-item')?.querySelector('.agnes-settings-item-description')
      ?.textContent,
  ).toBe('Switching pauses learning and reloads its models.')

  await choose(host, 'refinement-endpoint', alternateUrl)
  const paused = { ...initial, enabled: false, baseUrl: alternateUrl }
  expect(endpointSelect.value).toBe(alternateUrl)
  expect(api.save).toHaveBeenLastCalledWith(paused, REV0)
  expect(api.models).toHaveBeenCalledTimes(2)
  expect(api.createKey).not.toHaveBeenCalled()
  expect(enable.getAttribute('aria-checked')).toBe('false')
  expect(enable.disabled).toBe(true)
  expect(modelSelect.disabled).toBe(true)

  await act(async () => release())
  // The saved model stays saved, offered or not: only the person's own choice replaces it.
  expect(modelSelect.value).toBe(model)
  expect(api.save).toHaveBeenCalledTimes(1)
  if (!keep) {
    expect(host.textContent).toContain(`The saved model ${model} is not in the service's current list.`)
    expect(enable.disabled).toBe(true)
    await choose(host, 'refinement-model', selected)
    expect(api.save).toHaveBeenLastCalledWith({ ...paused, model: selected }, REV1)
  }
  expect(enable.disabled).toBe(false)
  await toggle(host, 'refinement-enabled')
  expect(api.save).toHaveBeenLastCalledWith({ ...paused, enabled: true, model: selected }, keep ? REV1 : REV2)
})

it('shows the sole service address before a key is saved', async () => {
  const api = fakeApi(DEFAULT_REFINEMENT_SETTINGS)
  api.read.mockResolvedValue({
    revision: REV0,
    settings: { ...DEFAULT_REFINEMENT_SETTINGS, baseUrl },
    endpoints: [baseUrl],
  })
  const select = field(await mount(api), 'refinement-endpoint') as HTMLSelectElement
  expect(select.value).toBe(baseUrl)
  expect(select.disabled).toBe(true)
  expect(
    select.closest('.agnes-settings-item')?.querySelector('.agnes-settings-item-description')?.textContent,
  ).toBe('Dedicated company review gateway.')
  expect(api.models).not.toHaveBeenCalled()
})

it('requires a saved service key, recovers a missing key and rotates it without showing its value, deleting the key it replaced', async () => {
  for (const missing of [false, true]) {
    const api = fakeApi(
      missing ? { ...OFF, credentialRef, model, enabled: true } : DEFAULT_REFINEMENT_SETTINGS,
    )
    const deleteKey = vi.fn(async (_ref: string) => {})
    api.deleteKey = deleteKey
    const host = await mount(api)
    if (missing) {
      expect((field(host, 'refinement-enabled') as HTMLButtonElement).disabled).toBe(false)
      api.read.mockResolvedValue({ revision: REV0, settings: OFF, credentialMissing: true })
      await act(async () => {
        window.dispatchEvent(new Event(CREDENTIALS_CHANGED))
      })
    }
    const toggle = field(host, 'refinement-enabled') as HTMLButtonElement
    expect(toggle.disabled).toBe(true)
    if (missing) expect(host.textContent).toContain('Service key missing')
    else {
      expect(api.models).not.toHaveBeenCalled()
      expect((field(host, 'refinement-model') as HTMLSelectElement).disabled).toBe(true)
    }
    const replace = 'secret://generic/new-review'
    const create = vi
      .fn()
      .mockResolvedValueOnce('secret://generic/first-review')
      .mockResolvedValueOnce(replace)
    api.createKey = create
    for (const [index, ref] of ['secret://generic/first-review', replace].entries()) {
      if (index) {
        await act(async () =>
          Array.from(host.querySelectorAll('button'))
            .find((b) => b.textContent === 'Replace key')
            ?.click(),
        )
      }
      const input = host.querySelector<HTMLInputElement>('input[type=password]')
      if (!input) throw new Error('Missing service-key input')
      expect(input.value).toBe('')
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'fixture-key')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () =>
        Array.from(host.querySelectorAll('button'))
          .find((b) => b.textContent === 'Save key')
          ?.click(),
      )
      expect(create).toHaveBeenCalledWith('Task experience service key', 'fixture-key')
      // Only the key is bound; a model is saved when the person picks one or turns learning on.
      expect(api.save).toHaveBeenCalledTimes(index + 1)
      expect(api.save).toHaveBeenLastCalledWith(
        { enabled: false, mode: 'manual', credentialRef: ref, ...(missing ? { model } : {}) },
        index ? REV1 : REV0,
      )
      // The key it replaced is deleted once the settings point to the new one.
      const replaced = index ? 'secret://generic/first-review' : missing ? credentialRef : undefined
      if (replaced) {
        expect(deleteKey).toHaveBeenLastCalledWith(replaced)
        expect(deleteKey.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
          api.save.mock.invocationCallOrder.at(-1) ?? Number.POSITIVE_INFINITY,
        )
      } else expect(deleteKey).not.toHaveBeenCalled()
      expect((field(host, 'refinement-model') as HTMLSelectElement).value).toBe(model)
      expect(toggle.disabled).toBe(false)
      expect(host.querySelector('input[type=password]')).toBeNull()
    }
    // Turning learning on saves the model the form proposed.
    await act(async () => toggle.click())
    expect(api.save).toHaveBeenLastCalledWith(
      { enabled: true, mode: 'manual', credentialRef: replace, model },
      REV2,
    )
  }
})

it('keeps the replaced key until the new one is bound, and never deletes a key it could not replace', async () => {
  const api = fakeApi()
  const deleteKey = vi.fn(async (_ref: string) => {
    throw new Error('referenced')
  })
  api.deleteKey = deleteKey
  api.createKey = vi.fn(async () => 'secret://generic/new-review')
  api.save.mockRejectedValueOnce(new Error('down'))
  const host = await mount(api)
  const click = (name: string) =>
    act(async () =>
      Array.from(host.querySelectorAll('button'))
        .find((b) => b.textContent === name)
        ?.click(),
    )
  await click('Replace key')
  const input = host.querySelector<HTMLInputElement>('input[type=password]')
  if (!input) throw new Error('Missing service-key input')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'fixture-key')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click('Save key')
  expect(api.save).toHaveBeenCalledTimes(1)
  expect(deleteKey).not.toHaveBeenCalled()
  // The retried save binds the new key; only then is the old one offered for deletion. The daemon
  // refuses a key something else still uses, and that refusal is not the binding's failure.
  await toggle(host, 'settings-save-retry')
  expect(api.save).toHaveBeenLastCalledWith({ ...OFF, credentialRef: 'secret://generic/new-review' }, REV0)
  expect(deleteKey).toHaveBeenCalledExactlyOnceWith(credentialRef)
  await act(async () => {})
  expect(query(host, 'settings-save-failed')).toBeNull()
})

it('handles rejected keys, retries model discovery and saves only an explicit selection', async () => {
  const api = fakeApi({ ...OFF, model: 'retired-review' })
  api.models
    .mockRejectedValueOnce(
      Object.assign(new Error('upstream'), { data: { reason: 'REFINEMENT_KEY_INVALID' } }),
    )
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ models: [] })
  const host = await mount(api)
  const modelSelect = field(host, 'refinement-model') as HTMLSelectElement
  const enabled = field(host, 'refinement-enabled') as HTMLButtonElement
  const retry = () =>
    act(async () => {
      const button = [...host.querySelectorAll('button')].find((item) => item.textContent === 'Reload models')
      if (!button) throw new Error('Missing model reload button')
      button.click()
    })
  expect(host.textContent).toContain('The service key is invalid or lacks access.')
  expect(modelSelect.disabled).toBe(true)
  expect(enabled.disabled).toBe(true)
  expect(api.save).not.toHaveBeenCalled()
  await retry()
  expect(host.textContent).toContain('Could not load the available models.')
  expect(enabled.disabled).toBe(true)
  await retry()
  expect(host.textContent).toContain('The service returned no chat models.')
  expect(enabled.disabled).toBe(true)
  await retry()
  expect(modelSelect.value).toBe('retired-review')
  expect(api.save).not.toHaveBeenCalled()
  expect(enabled.disabled).toBe(true)
  await choose(host, 'refinement-model', another)
  expect(api.save).toHaveBeenLastCalledWith({ ...OFF, model: another }, REV0)
  expect(modelSelect.value).toBe(another)
  expect(modelSelect.selectedOptions[0]?.textContent).toContain('Company Review B')
  expect(enabled.disabled).toBe(false)
  await toggle(host, 'refinement-enabled')
  expect(api.save).toHaveBeenLastCalledWith({ ...OFF, model: another, enabled: true }, REV1)
})

it.each([false, true])(
  'never switches a saved model the service no longer offers, and saves nothing (learning on: %s)',
  async (enabled) => {
    const stored: RefinementSettings = enabled
      ? { enabled: true, mode: 'manual', credentialRef, model: 'retired-review' }
      : { enabled: false, mode: 'manual', credentialRef, model: 'retired-review' }
    const api = fakeApi(stored)
    const host = await mount(api)
    await macrotask()
    const modelSelect = field(host, 'refinement-model') as HTMLSelectElement
    expect(modelSelect.value).toBe('retired-review')
    expect(modelSelect.selectedOptions[0]?.textContent).toBe('retired-review (not offered now)')
    expect(host.textContent).toContain(
      "The saved model retired-review is not in the service's current list. It stays as saved; choose another model to change it.",
    )
    expect(field(host, 'refinement-enabled').getAttribute('aria-checked')).toBe(String(enabled))
    expect(api.save).not.toHaveBeenCalled()
    document.documentElement.lang = 'zh-CN'
    await act(async () => {})
    expect(modelSelect.selectedOptions[0]?.textContent).toBe('retired-review（目前未提供）')
    expect(host.textContent).toContain('已保存的模型 retired-review 不在该服务当前的列表中。')
  },
)

it('a revision conflict keeps its banner and reports no success, once the real queue has run', async () => {
  const published = feedbackSpy()
  const api = fakeApi()
  api.read.mockResolvedValueOnce({ revision: REV0, settings: structuredClone(OFF) }).mockResolvedValueOnce({
    revision: REV2,
    settings: { credentialRef, model, enabled: false, mode: 'auto' },
  })
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

it('reports the saved switch, with no restart notice when it was turned on', async () => {
  const published = feedbackSpy()
  const host = await mount(fakeApi())
  await toggle(host, 'refinement-enabled')
  await macrotask()
  expect(published).toHaveLength(1)
  expect(published[0]?.outcome).toBe('success')
  expect(published[0]?.effect).toBeUndefined()
  await toggle(host, 'refinement-enabled')
  await macrotask()
  expect(published.at(-1)?.outcome).toBe('success')
  expect(published.at(-1)?.effect).toBeUndefined()
})

it('reloads after a revision conflict and says so', async () => {
  const api = fakeApi()
  api.read.mockResolvedValueOnce({ revision: REV0, settings: structuredClone(OFF) }).mockResolvedValueOnce({
    revision: REV2,
    settings: { credentialRef, model, enabled: false, mode: 'auto' },
  })
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
  expect(api.save).toHaveBeenLastCalledWith({ credentialRef, model, enabled: true, mode: 'auto' }, REV2)
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
  const api = fakeApi()
  api.read.mockResolvedValue({ revision: REV0, settings: OFF, endpoints: [baseUrl] })
  const host = await mount(api)
  expect(
    field(host, 'refinement-endpoint')
      .closest('.agnes-settings-item')
      ?.querySelector('.agnes-settings-item-description')?.textContent,
  ).toBe('公司的专用复盘服务节点。')
  const text = host.textContent ?? ''
  expect(switchHelp(host)?.getAttribute('aria-label')).toBe(
    '打开后，之后新开的会话生效；已经打开的会话不受影响。关闭立即对所有会话生效。要把经验留给之后的会话，还需打开工作区记忆（设置 → 通用 → 个性化 → 记忆：「先问我」或「自动」）；记忆为「关闭」时，经验只在学到它的会话里有效。',
  )
  expect(text).not.toContain('重启')
  expect(field(host, 'refinement-billing').textContent).toBe(
    '复盘使用你的 llm.sg 密钥，按实际用量计费。AGH 不知道价格；每个会话的用量受 token 预算限制。',
  )
  expect(field(host, 'refinement-approvals').textContent).toContain('可能出现更多命令审批：')
  expect(field(host, 'refinement-permissions').textContent).not.toContain('后续版本')
  expect(field(host, 'refinement-allows-install').textContent).toContain('纯指令')
})

it('every grant is in force: none says it comes in a later release', async () => {
  const host = await mount(fakeApi())
  const memory = field(host, 'refinement-allows-memory').textContent ?? ''
  expect(memory).toContain('Let the model save memory in the workspace')
  for (const name of ['install', 'skill', 'memory'])
    expect(field(host, `refinement-allows-${name}`).textContent).not.toMatch(/not available|later release/i)
  const install = field(host, 'refinement-allows-install').textContent ?? ''
  // Saved skills are instructions only: a script is written by the agent itself, under its permissions.
  expect(install).toMatch(/instructions only/i)
  expect(install).toMatch(/30 days/)
  expect(field(host, 'refinement-allows-skill').textContent).toMatch(/uninstall|roll/i)
})

it('the settings panel states that user-level lessons are written automatically', async () => {
  const host = await mount(fakeApi())
  const user = field(host, 'refinement-allows-user').textContent ?? ''
  expect(user).toContain('user memory')
  expect(user).toMatch(/written automatically/)
  expect(user).toMatch(/withdraw/i)
  expect(user).toMatch(/only in workspaces that turn it on/)
  expect(user).not.toMatch(/later release/i)
  document.documentElement.lang = 'zh-CN'
  const zh = (await mount(fakeApi())).textContent ?? ''
  expect(zh).toContain('自动写入用户记忆')
})

const NOTICE_KEY = 'agnes.refinement.workspace-notice'
const storage = () => globalThis.localStorage

it('shows a profile that already had refinement on a one-time notice until it is dismissed', async () => {
  storage().removeItem(NOTICE_KEY)
  try {
    const host = await mount(fakeApi({ credentialRef, model, enabled: true, mode: 'auto' }))
    const notice = field(host, 'refinement-workspace-notice')
    expect(notice.textContent).toContain('workspace memory')
    expect(notice.textContent).toContain('workspace skills')
    expect(notice.textContent).not.toMatch(/later release/)
    expect(notice.textContent).toMatch(/without asking again/)
    // Lessons that hold everywhere now also go to user memory, automatically.
    expect(notice.textContent).toMatch(/user memory, automatically/)
    expect(notice.textContent).toContain('Learn from finished work')
    const dismiss = notice.querySelector<HTMLButtonElement>('button')
    if (!dismiss) throw new Error('missing dismiss')
    await act(async () => dismiss.click())
    expect(query(host, 'refinement-workspace-notice')).toBeNull()
    // Dismissed for this viewer: a later visit does not show it again, and nothing was saved.
    const again = await mount(fakeApi({ credentialRef, model, enabled: true, mode: 'auto' }))
    expect(query(again, 'refinement-workspace-notice')).toBeNull()
  } finally {
    storage().removeItem(NOTICE_KEY)
  }
})

it('shows no notice when refinement is off, or turned on here, and works without browser storage', async () => {
  storage().removeItem(NOTICE_KEY)
  const api = fakeApi()
  const host = await mount(api)
  expect(query(host, 'refinement-workspace-notice')).toBeNull()
  await toggle(host, 'refinement-enabled')
  expect(query(host, 'refinement-workspace-notice')).toBeNull()
  expect(api.save).toHaveBeenCalledTimes(1)
  const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  try {
    const blocked = await mount(fakeApi({ credentialRef, model, enabled: true, mode: 'manual' }))
    const notice = field(blocked, 'refinement-workspace-notice')
    await act(async () => notice.querySelector<HTMLButtonElement>('button')?.click())
    expect(query(blocked, 'refinement-workspace-notice')).toBeNull()
  } finally {
    get.mockRestore()
    set.mockRestore()
  }
})

it('shows the notice in Chinese', async () => {
  storage().removeItem(NOTICE_KEY)
  document.documentElement.lang = 'zh-CN'
  const host = await mount(fakeApi({ credentialRef, model, enabled: true, mode: 'auto' }))
  expect(field(host, 'refinement-workspace-notice').textContent).toContain('工作区记忆')
  expect(field(host, 'refinement-workspace-notice').textContent).toContain('自动写入用户记忆')
})

it('shows the saved skills of the workspace when the connection reaches them', async () => {
  const plain = await mount(fakeApi())
  expect(query(plain, 'refinement-saved-skills')).toBeNull()
  const host = await mount({
    ...fakeApi(),
    savedSkills: {
      workspaces: async () => [{ path: '/w', available: true }],
      skills: async () => ({ skills: [], drafts: [] }),
    },
  })
  await act(async () => {})
  expect(field(host, 'refinement-saved-skills').textContent).toContain('Saved skills')
})
