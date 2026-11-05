/** @vitest-environment happy-dom */

import { Context } from '@agnes/cordis'
import { type HostAgnesClient, LocaleService } from '@agnes/web-client'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import * as adminApi from '../src/pages/admin-api.js'
import { ProfileApprovals } from '../src/regions/profile-approvals.js'

/** A save of task experience waiting in the profile decision list, as the Host keeps it. */
const saving = {
  handle: { id: 'save-1', sessionId: null, profileId: 'default' },
  revision: 1,
  request: {
    owner: 'core/refinement',
    sourcePackage: 'host',
    operationId: 'workspace-save:r1',
    expiresAt: '2099-11-11T00:00:00Z',
    spec: {
      prompt: 'Save this task experience to workspace memory?',
      subject: { paragraphId: 'ra00000001' },
      options: ['allowed-once', 'rejected'],
      presentation: {
        en: { title: 'Save task experience to workspace memory', fields: [] },
        'zh-CN': { title: '把任务经验保存到工作区记忆', fields: [] },
      },
    },
  },
}
const plugin = {
  handle: { id: 'plugin-1', sessionId: null, profileId: 'default' },
  revision: 1,
  request: {
    owner: 'plugin/report',
    sourcePackage: 'plugin/report',
    spec: { prompt: 'Publish?', subject: {}, options: ['allowed-once', 'rejected'] },
  },
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.restoreAllMocks()
  document.documentElement.lang = 'en'
})

async function open(decisions: unknown[], language: 'en' | 'zh-CN') {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  document.documentElement.lang = language
  const ctx = new Context()
  const locale = new LocaleService(ctx, language)
  const inventory = vi.spyOn(adminApi, 'homeAdmin').mockResolvedValue({
    api: {
      list: async () => ({
        packages: [{ id: 'plugin/report', metadata: { displayName: 'Reports' } }],
      }),
    },
  } as unknown as adminApi.HomeAdmin)
  const client = {
    call: vi.fn(async (method: string) => {
      if (method === '_agnes/v1/profile.decisions.list') return { decisions }
      if (method === '_agnes/v1/schedules.list') return { schedules: [] }
      if (method === '_agnes/v1/admin.triggers') return { snapshot: { rules: [], deliveries: [] } }
      return {}
    }),
  } as unknown as HostAgnesClient
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ snapshot: { rules: [], deliveries: [] } }))
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  cleanups.push(async () => {
    await act(async () => root.unmount())
    await ctx.fiber.dispose()
    host.remove()
  })
  await act(async () => root.render(createElement(ProfileApprovals, { client, locale })))
  const toggle = () => host.querySelector<HTMLButtonElement>('button[aria-controls="profile-approvals"]')
  await vi.waitFor(() => expect(toggle()).not.toBeNull(), { timeout: 5_000 })
  await act(async () => toggle()?.click())
  const panel = document.querySelector<HTMLElement>('#profile-approvals')
  if (!panel) throw new Error('missing panel')
  return { panel, inventory }
}

it.each(['en', 'zh-CN'] as const)(
  'labels a save of task experience as task experience, never as a plugin (%s)',
  async (language) => {
    const { panel, inventory } = await open([saving], language)
    const zh = language === 'zh-CN'
    await vi.waitFor(() => expect(panel.querySelector('h2')).not.toBeNull())
    expect(panel.querySelector('h2')?.textContent).toBe(
      zh
        ? '任务经验 · 把任务经验保存到工作区记忆'
        : 'Task experience · Save task experience to workspace memory',
    )
    expect(panel.querySelector('h3')?.textContent).toBe(zh ? '任务经验' : 'Task experience')
    expect(panel.textContent).not.toMatch(zh ? /插件/ : /Plugin/)
    // The Host's own decisions name no package, so no package metadata is looked up for them.
    expect(inventory).not.toHaveBeenCalled()
  },
)

it('keeps plugin requests under their own heading next to task experience', async () => {
  const { panel, inventory } = await open([saving, plugin], 'en')
  await vi.waitFor(() => expect(panel.textContent).toContain('Reports · requests an operation'))
  const headings = [...panel.querySelectorAll('h3')].map((heading) => heading.textContent)
  expect(headings).toEqual(['Task experience', 'Plugin requests'])
  const titles = [...panel.querySelectorAll('h2')].map((heading) => heading.textContent)
  expect(titles).toContain('Task experience · Save task experience to workspace memory')
  expect(inventory).toHaveBeenCalled()
})
