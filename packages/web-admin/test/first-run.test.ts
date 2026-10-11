/** @vitest-environment happy-dom */
import type { ConfigSnapshot } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
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

async function setup(dismissed?: string) {
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
    connect = vi.fn(async () => true)
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
    attachAccount: () => () => {},
    connectAccount: connect,
    chooseWorkspace: async () => 'project',
    examples: async () => {},
    details: async () => {},
    closeSettings: () => {},
    saved: async () => {},
    start,
  })
  controllers.push(controller)
  await controller.initialize(snapshot, false)
  const click = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)?.click()
  return { host, banner, controller, click, start, connect, saved, homeId }
}
it('keeps setup inline, advances through the work folder and remembers completion for this home/profile', async () => {
  const h = await setup()
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
  expect(h.host.querySelector('[data-testid="first-run-guide"]')?.getAttribute('data-step')).toBe('ready')
  h.click('first-run-next')
  expect(h.start).toHaveBeenCalled()
  expect(h.saved.get(`agh-first-run:${h.homeId}:local-dev`)).toBe('done')
  expect(await h.controller.initialize(snapshot, false)).toBe(false)
})
it.each([0, 6, 8])('suppresses a dismissed doctor notice for seven days (%s days)', async (days) => {
  const h = await setup(String(Date.now() - days * 24 * 60 * 60 * 1000))
  expect(h.banner.querySelector('[data-testid="doctor-notice"]') !== null).toBe(days >= 7)
})
