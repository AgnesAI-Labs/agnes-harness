/** @vitest-environment happy-dom */
import type { ConfigSnapshot } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import { homeNavigation } from '@agnes/web-client'
import { afterEach, expect, it, vi } from 'vitest'
import { createFirstRunController, needsFirstRun } from '../src/first-run.js'

const snapshot: ConfigSnapshot = {
  profile: 'local-dev',
  revision: 1,
  configured: false,
  provider: null,
  accounts: [],
  effect: 'new-sessions',
}
const controllers: ReturnType<typeof createFirstRunController>[] = []
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose()
  homeNavigation.close()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})
it.each([
  [{ ...snapshot, configured: true }, true],
  [{ provider: null, profile: 'work', revision: 1, configured: true, effect: 'new-sessions' }, false],
  [{ provider: null, profile: 'work', revision: 1, configured: false, effect: 'new-sessions' }, true],
] as const)('preserves first-run account/legacy guard semantics (%j)', (value, expected) => {
  expect(needsFirstRun(value)).toBe(expected)
})

async function setup(
  dismissed?: string,
  detach = () => {},
  chooseWorkspace: (path?: string, signal?: AbortSignal) => Promise<string | undefined> = async () =>
    'project',
) {
  const host = document.createElement('div'),
    banner = document.createElement('div')
  document.body.append(host, banner)
  const homeId = '11111111-1111-4111-8111-111111111111'
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        homeId,
        status: 'fail',
        checks: [{ id: 'home', status: 'fail', fixHintKey: 'doctor.fix.home' }],
      }),
    ),
  )
  const saved = new Map<string, string>()
  if (dismissed) saved.set(`agh-doctor-dismissed:${homeId}`, dismissed)
  const start = vi.fn(async () => {}),
    connect = vi.fn(async () => true),
    selectDemo = vi.fn(async () => {})
  const controller = createFirstRunController({
    host,
    banner,
    client: {} as Client,
    storage: {
      getItem: (key) => saved.get(key) ?? null,
      setItem: (key, value) => {
        saved.set(key, value)
      },
    },
    attachAccount: () => detach,
    connectAccount: connect,
    selectDemo,
    chooseWorkspace,
    examples: async () => homeNavigation.open('agents'),
    details: async () => {},
    closeSettings: () => {},
    saved: async () => {},
    start,
  })
  controllers.push(controller)
  await controller.initialize(snapshot, false)
  const click = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)?.click()
  return { host, banner, controller, click, start, connect, selectDemo, saved, homeId }
}
it('keeps setup inline, advances through the work folder and remembers completion for this home/profile', async () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })),
  )
  const h = await setup()
  const guide = () => h.host.querySelector('[data-testid="first-run-guide"]')
  const wrap = () => guide()?.closest<HTMLElement>('.ant-modal-wrap')
  expect(h.host.querySelector('[data-testid="first-run-guide"]')?.getAttribute('data-step')).toBe('account')
  h.click('first-run-add')
  h.click('first-run-next')
  await vi.waitFor(() =>
    expect(h.host.querySelector('[data-testid="first-run-guide"]')?.getAttribute('data-step')).toBe(
      'workspace',
    ),
  )
  expect(h.connect).toHaveBeenCalled()
  ;[...h.host.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent === 'Back')
    ?.click()
  expect(h.host.querySelector('[data-testid="first-run-guide"]')?.getAttribute('data-step')).toBe('account')
  h.click('first-run-next')
  expect(h.connect).toHaveBeenCalledTimes(1)
  h.click('first-run-workspace-pick')
  await vi.waitFor(() =>
    expect(h.host.querySelector('[data-testid="first-run-workspace"]')?.textContent).toBe('project'),
  )
  h.click('first-run-next')
  await vi.waitFor(() => expect(wrap()?.style.display).not.toBe('none'))
  expect(guide()?.getAttribute('data-step')).toBe('ready')
  expect(h.host.querySelector('[data-testid="first-run-examples"]')?.textContent).toBe(
    'Explore demos in Agents',
  )
  h.click('first-run-examples')
  await vi.waitFor(() => expect(homeNavigation.getSnapshot()?.id).toBe('agents'))
  await vi.waitFor(() => expect(wrap()?.style.display).toBe('none'))
  homeNavigation.close()
  await vi.waitFor(() => expect(wrap()?.style.display).not.toBe('none'))
  expect(guide()?.getAttribute('data-step')).toBe('ready')
  h.click('first-run-next')
  expect(h.start).toHaveBeenCalled()
  expect(h.saved.get(`agh-first-run:${h.homeId}:local-dev`)).toBe('done')
  expect(await h.controller.initialize(snapshot, false)).toBe(false)
})
it('hands the account form back to Settings when setup is skipped mid-connection', async () => {
  const detach = vi.fn()
  const h = await setup(undefined, detach)
  h.click('first-run-add')
  await vi.waitFor(() => expect(h.host.querySelector('[data-testid="first-run-connection"]')).not.toBeNull())
  h.click('first-run-skip')
  // A hidden guide that kept the form would leave Settings' account tiles opening nothing.
  await vi.waitFor(() => expect(detach).toHaveBeenCalled())
})
it.each([0, 6, 8])('suppresses a dismissed doctor notice for seven days (%s days)', async (days) => {
  const h = await setup(String(Date.now() - days * 24 * 60 * 60 * 1000))
  expect(h.banner.querySelector('[data-testid="doctor-notice"]') !== null).toBe(days >= 7)
})

it.each(['en', 'zh-CN'])(
  'selects Demo before continuing and explains the local model on the finish step (%s)',
  async (locale) => {
    document.documentElement.lang = locale
    const h = await setup()
    h.click('first-run-demo')
    h.click('first-run-next')
    await vi.waitFor(() => expect(h.host.querySelector('[data-step="workspace"]')).not.toBeNull())
    expect(h.selectDemo).toHaveBeenCalled()
    expect(h.connect).not.toHaveBeenCalled()
    h.click('first-run-workspace-pick')
    await vi.waitFor(() => expect(h.host.querySelector('[data-testid="first-run-workspace"]')).not.toBeNull())
    h.click('first-run-next')
    const text = h.host.querySelector('[data-testid="first-run-demo-next"]')?.textContent
    expect(text).toContain(locale === 'en' ? 'Demo is selected' : '已选择 Demo')
    expect(text).toContain(locale === 'en' ? 'without reasoning' : '不进行推理')
    expect(text).toContain(locale === 'en' ? 'Settings → Models' : '设置 → 模型')
    expect(h.host.querySelector('[data-testid="first-run-examples"]')?.textContent).toBe(
      locale === 'en' ? 'Explore demos in Agents' : '想看产品演示？打开智能体',
    )
    h.click('first-run-examples')
    await vi.waitFor(() => expect(homeNavigation.getSnapshot()?.id).toBe('agents'))
    document.documentElement.lang = ''
  },
)

it('keeps setup on the account step when selecting Demo fails and allows retry', async () => {
  const h = await setup()
  h.selectDemo.mockRejectedValueOnce(new Error('Demo unavailable'))
  h.click('first-run-demo')
  h.click('first-run-next')
  await vi.waitFor(() => expect(h.host.textContent).toContain('Setup could not be saved'))
  expect(h.host.querySelector('[data-step="account"]')).not.toBeNull()
  h.click('first-run-next')
  await vi.waitFor(() => expect(h.host.querySelector('[data-step="workspace"]')).not.toBeNull())
})

// The native folder window can open behind the browser, so the step must say so, never look hung,
// and keep Cancel, manual input and Skip usable while the request is outstanding.
it('says the system folder window is open, keeps manual input and skip usable, and Cancel drops the request', async () => {
  let signal: AbortSignal | undefined
  const choose = vi.fn(
    (path?: string, abort?: AbortSignal) =>
      new Promise<string | undefined>((resolve, reject) => {
        if (path) return resolve(path)
        signal = abort
        abort?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }),
  )
  const h = await setup(undefined, undefined, choose)
  h.click('first-run-demo')
  h.click('first-run-next')
  await vi.waitFor(() => expect(h.host.querySelector('[data-step="workspace"]')).not.toBeNull())
  h.click('first-run-workspace-pick')
  await vi.waitFor(() => expect(h.host.querySelector('[data-testid="first-run-picking"]')).not.toBeNull())
  expect(h.host.querySelector('[data-testid="first-run-picking"]')?.textContent).toContain(
    'behind your browser',
  )
  expect(h.host.querySelector('[aria-busy="true"]')).toBeNull()
  expect(h.host.querySelector<HTMLButtonElement>('[data-testid="first-run-workspace-pick"]')?.disabled).toBe(
    true,
  )
  expect(h.host.querySelector<HTMLInputElement>('input')?.disabled).toBe(false)
  h.click('first-run-pick-cancel')
  expect(signal?.aborted).toBe(true)
  await vi.waitFor(() => expect(h.host.querySelector('[data-testid="first-run-picking"]')).toBeNull())
  expect(h.host.querySelector('[role="alert"]')).toBeNull()
  // A second click starts a fresh request; Skip while it is open drops it and reaches the composer.
  h.click('first-run-workspace-pick')
  await vi.waitFor(() => expect(choose).toHaveBeenCalledTimes(2))
  const second = signal
  h.click('first-run-skip')
  expect(second?.aborted).toBe(true)
  expect(h.start).toHaveBeenCalled()
})
