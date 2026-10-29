/** @vitest-environment happy-dom */

import { Context } from '@agnes/cordis'
import {
  type AgnesClientService,
  type HostAgnesClient,
  homeNavigation,
  LocaleService,
} from '@agnes/web-client'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgnesClient } from '../src/client-modules/boot.js'
import * as adminApi from '../src/pages/admin-api.js'
import { APPROVAL_SLOT } from '../src/region-slots.js'
import { ProfileApprovals } from '../src/regions/profile-approvals.js'
import { mountRenderedIndex, resetWebDom } from './web-dom-fixture.js'

// A render through the approval handle commits in a few milliseconds, but a loaded runner has
// taken longer than the fixed 20 ms these checks used to sleep. Wait for the rendered state instead.
const committed = { timeout: 5_000 }

describe('rendered approval region', () => {
  let runtime: Awaited<ReturnType<typeof mountRenderedIndex>> | undefined

  afterEach(async () => {
    await runtime?.dispose()
    runtime = undefined
    resetWebDom()
  })

  it('renders the live-region card through the public approval handle', async () => {
    runtime = await mountRenderedIndex()
    const approval = document.querySelector<HTMLElement>('#approval')
    const handle = runtime.approval
    expect(handle).toBeDefined()
    expect(approval?.getAttribute('aria-live')).toBe('polite')

    const selected: string[] = []
    handle?.render({
      key: 'live:tool-1',
      kind: 'plan',
      title: '需要你的确认',
      summary: '读取工作区文件',
      rewritten: '此摘要由 plugin/reviewer 改写。原始请求：read README.md',
      impact: '请核对工具及参数后决定是否继续。',
      risk: 'destructive',
      preview: '{"path":"README.md"}',
      actions: [
        { id: 'allow', label: '仅允许这次', onSelect: () => selected.push('allow') },
        { id: 'reject', label: '拒绝', onSelect: () => selected.push('reject') },
      ],
      disabled: false,
    })
    await vi.waitFor(() => {
      expect(approval?.hidden).toBe(false)
      expect(approval?.querySelector('[data-testid="plan-approval-card"]')).toBeTruthy()
      expect(approval?.querySelectorAll('[data-testid="approval-action"]')).toHaveLength(2)
      expect(approval?.querySelector('[data-testid="approval-preview"]')?.textContent).toContain('README.md')
      expect(
        approval?.querySelector('[data-slot="ui:approval"] [data-agnes-region-unit="approval"]'),
      ).toBeTruthy()
      expect(approval?.querySelector('h2')?.textContent).toBe('需要你的确认')
      // 风险等级靠 data-risk 上色，文字本身仍然说明风险：不只靠颜色表达。
      const card = approval?.querySelector<HTMLElement>('[data-testid="plan-approval-card"]')
      expect(card?.dataset.risk).toBe('destructive')
      expect(card?.querySelector('.approval-impact')?.textContent).toBe('请核对工具及参数后决定是否继续。')
      expect(approval?.querySelector('[data-testid="approval-rewritten"]')?.textContent).toBe(
        '此摘要由 plugin/reviewer 改写。原始请求：read README.md',
      )
      expect(approval?.querySelector('pre')?.closest('[data-open]')?.getAttribute('data-open')).toBe('false')
      expect(approval?.querySelector('pre')?.textContent).toBe('{"path":"README.md"}')
      expect(approval?.querySelectorAll<HTMLButtonElement>('.approval-actions button')).toHaveLength(2)
    }, committed)

    const reject = approval?.querySelector<HTMLButtonElement>('.approval-actions button:nth-child(2)')
    reject?.focus()
    handle?.render({
      key: 'live:tool-1',
      title: '需要你的确认',
      summary: '读取工作区文件',
      impact: '请核对工具及参数后决定是否继续。',
      actions: [
        { id: 'allow', label: '仅允许这次', onSelect: () => selected.push('allow') },
        { id: 'reject', label: '拒绝', onSelect: () => selected.push('reject') },
      ],
      disabled: true,
    })
    await vi.waitFor(() => {
      const disabledReject = approval?.querySelector<HTMLButtonElement>(
        '.approval-actions button:nth-child(2)',
      )
      expect(document.activeElement).not.toBe(disabledReject)
      expect(disabledReject?.disabled).toBe(true)
    }, committed)
    handle?.render({
      key: 'live:tool-1',
      title: '需要你的确认',
      summary: '读取工作区文件',
      impact: '请核对工具及参数后决定是否继续。',
      actions: [
        { id: 'allow', label: '仅允许这次', onSelect: () => selected.push('allow') },
        { id: 'reject', label: '拒绝', onSelect: () => selected.push('reject') },
      ],
      disabled: false,
    })
    await vi.waitFor(() => {
      const restoredReject = approval?.querySelector<HTMLButtonElement>(
        '.approval-actions button:nth-child(2)',
      )
      expect(restoredReject?.disabled).toBe(false)
      expect(document.activeElement).toBe(restoredReject)
    }, committed)
    handle?.render(undefined)
    await vi.waitFor(() => expect(approval?.hidden).toBe(true), committed)
    expect(selected).toEqual([])
  })

  it('keeps approval actions natively keyboard-activatable', async () => {
    runtime = await mountRenderedIndex()
    const handle = runtime.approval
    const selected: string[] = []
    handle?.render({
      key: 'live:keyboard-1',
      title: '需要你的确认',
      summary: '执行命令',
      impact: '请核对工具及参数后决定是否继续。',
      actions: [{ id: 'allow', label: '允许', onSelect: () => selected.push('allow') }],
      disabled: false,
    })
    await vi.waitFor(
      () => expect(document.querySelector('#approval .approval-actions button')).toBeTruthy(),
      committed,
    )

    const allow = document.querySelector<HTMLButtonElement>('#approval .approval-actions button')
    expect(allow?.type).toBe('button')
    // The region itself moves focus to its first available decision when asked.
    handle?.focus()
    expect(document.activeElement).toBe(allow)
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    allow?.dispatchEvent(enter)
    expect(enter.defaultPrevented).toBe(false)
    allow?.click()
    expect(selected).toEqual(['allow'])
  })

  it('shadows only approval and restores the built-in component after unload', async () => {
    runtime = await mountRenderedIndex()
    const approval = document.querySelector('#approval')
    runtime.approval?.render({
      key: 'shadow-replay',
      title: '需要你的确认',
      summary: '恢复当前审批',
      impact: '请核对工具及参数后决定是否继续。',
      actions: [],
      disabled: false,
    })
    await vi.waitFor(() => expect(approval?.querySelector('h2')?.textContent).toBe('需要你的确认'), committed)
    const remove = runtime.registry.register(
      {
        name: APPROVAL_SLOT as string,
        id: 'fixture-approval-shadow',
        owner: 'fixture',
        priority: -1,
      },
      () => createElement('div', { id: 'shadow-approval' }, '替换审批'),
    )
    await vi.waitFor(() => {
      expect(approval?.querySelector('#shadow-approval')?.textContent).toBe('替换审批')
      expect(approval?.querySelector('#approval-content')).toBeNull()
    }, committed)
    expect(document.querySelector('[data-slot="ui:conversation"] #transcript')).toBeTruthy()
    expect(document.querySelector('[data-slot="ui:composer"] #prompt')).toBeTruthy()

    remove()
    await vi.waitFor(() => {
      expect(approval?.querySelector('[data-agnes-region-unit="approval"]')).toBeTruthy()
      expect(approval?.querySelector('#approval-content')).toBeTruthy()
      expect(approval?.querySelector('h2')?.textContent).toBe('需要你的确认')
      expect(approval?.querySelector('p')?.textContent).toBe('恢复当前审批')
    }, committed)
  })
})

it.each(['en', 'zh-CN'] as const)(
  'shows pending profile approvals as one navigation row without a conversation (%s)',
  async (language) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const handle = { id: 'profile-decision', sessionId: null, profileId: 'default' }
    const decision = {
      handle,
      revision: 1,
      request: {
        owner: 'plugin/report',
        sourcePackage: 'plugin/report',
        spec: {
          prompt: 'Publish report?',
          subject: {
            report: 'reviewed-one',
            presentation: { title: { en: 'Publish the reviewed report', 'zh-CN': '发布已审阅报表' } },
          },
          options: ['allowed-once', 'rejected'],
        },
      },
    }
    let pending: (typeof decision)[] = []
    let automationPending = false
    let refuse = true
    let listUnavailable = false
    let blockedList: Promise<void> | undefined
    let blockedAnswer: Promise<void> | undefined
    const triggerFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({
        snapshot: {
          rules: [{ id: 'private-rule-id', event: 'Issue opened' }],
          deliveries: automationPending
            ? [
                { sessionId: 'trigger-session', ruleId: 'private-rule-id', status: 'needs_attention' },
                {
                  sessionId: 'deleted-rule-session',
                  ruleId: 'deleted-rule-id',
                  status: 'waiting_approval',
                },
                { sessionId: 'finished-session', status: 'ran' },
              ]
            : [],
        },
      }),
    )
    const call = vi.fn(async (method: string, input?: { handle: typeof handle }) => {
      if (method === '_agnes/v1/schedules.list')
        return {
          schedules: automationPending
            ? [
                {
                  title: 'Scheduled report',
                  runs: [{ outcome: 'waiting_approval', sessionKey: 'unattended-run' }],
                },
              ]
            : [],
        }
      if (method === '_agnes/v1/packages.list')
        return {
          packages: [
            {
              id: 'plugin/report',
              metadata: {
                displayName: 'Reports',
                summary: 'Reports',
                description: 'Reports',
                locales: { 'zh-CN': { displayName: '报表' } },
              },
            },
          ],
        }
      if (method === '_agnes/v1/profile.decisions.list') {
        const snapshot = [...pending]
        if (blockedList) await blockedList
        if (listUnavailable) throw new Error('temporarily unavailable')
        return { decisions: snapshot }
      }
      if (blockedAnswer) await blockedAnswer
      if (refuse) throw new Error('stale decision refused')
      pending = pending.filter((value) => value.handle.id !== input?.handle.id)
      return {}
    })
    const inventory = vi.spyOn(adminApi, 'homeAdmin').mockResolvedValue({
      api: {
        list: async () => ({
          packages: [
            {
              id: 'plugin/report',
              metadata: { displayName: 'Reports', locales: { 'zh-CN': { displayName: '报表' } } },
            },
          ],
        }),
      },
    } as unknown as adminApi.HomeAdmin)
    const profileReads = () =>
      call.mock.calls.filter(([method]) => method === '_agnes/v1/profile.decisions.list').length
    const listeners = new Map<string, (payload: unknown) => void>()
    const on = (event: string, callback: (payload: unknown) => void) => {
      listeners.set(event, callback)
      return () => listeners.delete(event)
    }
    const emit = (event: string, payload: unknown) => listeners.get(event)?.(payload)
    const changed = () =>
      emit('notice', {
        kind: 'decisions_changed',
        detail: { profile: 'default', principal: { id: 'operator', org: 'local' } },
        at: '2026-10-17T00:00:00Z',
      })
    let hidden = false
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockImplementation(() => (hidden ? 'hidden' : 'visible'))
    let runtime: Awaited<ReturnType<typeof mountRenderedIndex>> | undefined
    const row = () => document.querySelector<HTMLButtonElement>('button[aria-controls="profile-approvals"]')
    const surface = () => document.querySelector<HTMLElement>('#profile-approvals')
    const action = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('#profile-approvals button')].find(
        (button) => button.textContent === label,
      )
    const allowLabel = language === 'en' ? 'Allow once' : '允许一次'
    const rejectLabel = language === 'en' ? 'Reject' : '拒绝'
    try {
      runtime = await mountRenderedIndex({
        agnes: { call, on, connectionState: 'connected' } as unknown as AgnesClient,
      })
      runtime.locale.setLocale(language)
      await vi.waitFor(() => expect(call).toHaveBeenCalledWith('_agnes/v1/profile.decisions.list', {}))
      expect(row()).toBeNull()
      expect(surface()).toBeNull()
      const idleReads = profileReads()
      await vi.advanceTimersByTimeAsync(180_000)
      expect(profileReads()).toBe(idleReads)
      emit('notice', { kind: 'packages_changed' })
      await vi.advanceTimersByTimeAsync(0)
      expect(profileReads()).toBe(idleReads)
      emit('connectionStateChanged', 'reconnecting')
      emit('connectionStateChanged', 'connected')
      await vi.advanceTimersByTimeAsync(0)
      expect(profileReads()).toBe(idleReads + 1)
      emit('connectionStateChanged', 'connected')
      await vi.advanceTimersByTimeAsync(0)
      expect(profileReads()).toBe(idleReads + 1)
      hidden = true
      changed()
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(120_000)
      expect(profileReads()).toBe(idleReads + 1)
      hidden = false
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
      expect(profileReads()).toBe(idleReads + 2)
      expect(document.querySelector('.sidebar-footer')?.textContent).not.toMatch(/Needs attention|待处理/)

      pending = [decision, { ...decision, handle: { ...handle, id: 'second-decision' } }]
      changed()
      await Promise.resolve()
      await vi.waitFor(() => expect(row()?.querySelector('.home-entry-badge')?.textContent).toBe('2'))
      expect(document.querySelectorAll('button[aria-controls="profile-approvals"]')).toHaveLength(1)
      expect(row()?.closest('.home-entries')).toBeTruthy()
      expect(row()?.classList.contains('home-entry')).toBe(true)
      expect(row()?.classList.contains('agh-btn--ghost')).toBe(true)
      expect(row()?.querySelector('.icon')).toBeTruthy()
      expect(row()?.textContent).toContain(language === 'en' ? 'Needs attention' : '待处理')
      expect(row()?.getAttribute('aria-label')).toContain('(2)')
      expect(row()?.getAttribute('aria-expanded')).toBe('false')
      expect(surface()?.hidden).toBe(true)
      row()?.focus()
      expect(document.activeElement).toBe(row())
      expect(row()?.type).toBe('button')
      row()?.click()
      await vi.waitFor(() => {
        expect(row()?.getAttribute('aria-expanded')).toBe('true')
        expect(surface()?.hidden).toBe(false)
        expect(action(allowLabel)).toBeTruthy()
      })
      expect(surface()?.textContent).toContain('reviewed-one')
      expect(surface()?.querySelector('h2')?.textContent).toContain(
        language === 'en' ? 'Publish the reviewed report' : '发布已审阅报表',
      )
      expect(surface()?.querySelector('.approval-summary-text')?.textContent).toContain(
        language === 'en' ? 'Applies only to this operation.' : '仅对此次操作生效。',
      )
      expect(surface()?.closest('.sidebar')).toBeNull()
      expect(surface()?.textContent).toContain(language === 'en' ? 'Plugin Reports' : '插件 报表')
      expect(surface()?.textContent).toContain(language === 'en' ? 'Plugin requests' : '插件请求')
      expect(surface()?.querySelector('.approval-impact')?.textContent).toBe('')
      expect(surface()?.textContent).toContain(
        language === 'en' ? 'Review items that need your attention.' : '查看需要你确认或处理的事项。',
      )
      expect(surface()?.querySelector('h2')?.textContent).not.toContain('plugin/report')
      listUnavailable = true
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
      expect(row()?.querySelector('.home-entry-badge')?.textContent).toBe('2')
      listUnavailable = false
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
      await vi.waitFor(() => expect(surface()?.querySelector('[role="alert"]')).toBeNull())
      const cardsBeforeFailure = [...(surface()?.querySelectorAll('[data-testid="approval-card"]') ?? [])]
      expect(cardsBeforeFailure).toHaveLength(2)
      const focusedBeforeFailure = action(allowLabel)
      if (!focusedBeforeFailure) throw new Error('Missing approval action')
      let failAnswer!: () => void
      blockedAnswer = new Promise<void>((resolve) => {
        failAnswer = resolve
      })
      focusedBeforeFailure.focus()
      focusedBeforeFailure.click()
      await vi.waitFor(() => expect(focusedBeforeFailure.disabled).toBe(true))
      expect(action(allowLabel)).toBe(focusedBeforeFailure)
      const answers = () =>
        call.mock.calls.filter(([method]) => method === '_agnes/v1/profile.decisions.answer').length
      const beforeRetry = answers()
      focusedBeforeFailure.click()
      expect(answers()).toBe(beforeRetry)
      blockedAnswer = undefined
      failAnswer()
      await vi.waitFor(() => expect(surface()?.querySelector('[role="alert"]')).toBeTruthy())
      expect(action(allowLabel)).toBe(focusedBeforeFailure)
      const cardsAfterFailure = [...(surface()?.querySelectorAll('[data-testid="approval-card"]') ?? [])]
      expect(cardsAfterFailure).toHaveLength(cardsBeforeFailure.length)
      cardsAfterFailure.forEach((card, index) => {
        expect(card).toBe(cardsBeforeFailure[index])
      })
      expect(document.activeElement).toBe(focusedBeforeFailure)
      expect(focusedBeforeFailure.disabled).toBe(false)
      expect(call).toHaveBeenCalledWith('_agnes/v1/profile.decisions.answer', {
        handle,
        revision: 1,
        commandId: expect.any(String),
        response: { option: 'allowed-once', value: null },
      })
      expect(row()?.querySelector('.home-entry-badge')?.textContent).toBe('2')
      expect(action(allowLabel)).toBeTruthy()

      refuse = false
      action(allowLabel)?.click()
      await vi.waitFor(() => expect(row()?.querySelector('.home-entry-badge')?.textContent).toBe('1'))
      action(rejectLabel)?.click()
      await vi.waitFor(() => {
        expect(row()).toBeNull()
        expect(surface()).toBeNull()
      })
      expect(call).toHaveBeenCalledWith('_agnes/v1/profile.decisions.answer', {
        handle: { ...handle, id: 'second-decision' },
        revision: 1,
        commandId: expect.any(String),
        response: { option: 'rejected', value: null },
      })
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
      expect(row()).toBeNull()

      pending = [decision]
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
      await vi.waitFor(() => expect(row()?.querySelector('.home-entry-badge')?.textContent).toBe('1'))
      const pendingReads = profileReads()
      await vi.advanceTimersByTimeAsync(180_000)
      expect(profileReads()).toBe(pendingReads)
      // A change during an older read must cause one later read, even if more notices arrive.
      let release!: () => void
      blockedList = new Promise<void>((resolve) => {
        release = resolve
      })
      changed()
      await Promise.resolve()
      const beforeChange = profileReads()
      pending = []
      changed()
      changed()
      blockedList = undefined
      release()
      await vi.waitFor(() => expect(profileReads()).toBe(beforeChange + 1))
      await Promise.resolve()
      await vi.waitFor(() => {
        expect(row()).toBeNull()
        expect(surface()).toBeNull()
      })
      automationPending = true
      emit('notice', { kind: 'automation_attention', sessionId: 'unattended-run' })
      await vi.waitFor(() => expect(row()?.querySelector('.home-entry-badge')?.textContent).toBe('3'))
      if (!surface() || surface()?.hidden) row()?.click()
      await vi.waitFor(() => expect(surface()?.hidden).toBe(false))
      await vi.waitFor(() =>
        expect(surface()?.querySelector('a[href="/?session=unattended-run"]')?.textContent).toContain(
          'Scheduled report',
        ),
      )
      const scheduleGroup = surface()?.querySelector(
        `section[aria-label="${language === 'en' ? 'Scheduled tasks' : '定时任务'}"]`,
      )
      const triggerGroup = surface()?.querySelector(
        `section[aria-label="${language === 'en' ? 'Triggers' : '触发器'}"]`,
      )
      expect(scheduleGroup?.textContent).toContain(
        language === 'en' ? 'Waiting for your approval' : '等待你确认',
      )
      expect(triggerGroup?.textContent).toContain('Issue opened')
      expect(triggerGroup?.textContent).toContain(language === 'en' ? 'Needs attention' : '需要处理')
      expect(triggerGroup?.textContent).toContain(language === 'en' ? 'Automation run' : '自动化运行')
      expect(triggerGroup?.textContent).toContain(language === 'en' ? 'Open the run session' : '打开运行会话')
      expect(surface()?.textContent).not.toMatch(
        /private-rule-id|deleted-rule-id|trigger-session|unattended-run/,
      )
      expect(surface()?.querySelector('a[href="/?session=trigger-session"]')).toBeTruthy()
      expect(surface()?.querySelector('a[href="/?session=finished-session"]')).toBeNull()
      // A completed reply cannot dismiss an approval the backend still reports as pending.
      const beforeUnresolved = profileReads()
      window.dispatchEvent(new CustomEvent('agnes:automation-invalidated'))
      await vi.waitFor(() => expect(profileReads()).toBeGreaterThan(beforeUnresolved))
      await vi.advanceTimersByTimeAsync(0)
      expect(row()?.querySelector('.home-entry-badge')?.textContent).toBe('3')
      automationPending = false
      window.dispatchEvent(new CustomEvent('agnes:automation-invalidated'))
      await vi.waitFor(() => expect(row()).toBeNull())
      // Recreating the shell must reread durable state instead of restoring a stale badge.
      await runtime.dispose()
      expect(listeners.size).toBe(0)
      const beforeReload = profileReads()
      window.dispatchEvent(new CustomEvent('agnes:automation-invalidated'))
      await vi.advanceTimersByTimeAsync(0)
      expect(profileReads()).toBe(beforeReload)
      runtime = await mountRenderedIndex({
        agnes: { call, on, connectionState: 'connected' } as unknown as AgnesClient,
      })
      runtime.locale.setLocale(language)
      await vi.waitFor(() => expect(profileReads()).toBeGreaterThan(beforeReload))
      await vi.advanceTimersByTimeAsync(0)
      expect(row()).toBeNull()
      expect(surface()).toBeNull()
    } finally {
      inventory.mockRestore()
      triggerFetch.mockRestore()
      await runtime?.dispose()
      expect(listeners.size).toBe(0)
      visibility.mockRestore()
      vi.useRealTimers()
      resetWebDom()
    }
  },
)

it.each(['saved', 'failed'] as const)(
  'ignores a late profile approval %s after close/reopen and a client change',
  async (outcome) => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    document.documentElement.innerHTML = '<head></head><body></body>'
    const ctx = new Context()
    const locale = new LocaleService(ctx, 'en')
    const decision = {
      handle: { id: 'same-id', sessionId: null, profileId: 'default' },
      revision: 1,
      request: {
        owner: 'plugin/report',
        sourcePackage: 'plugin/report',
        spec: { prompt: 'Publish?', subject: {}, options: ['allowed-once', 'rejected'] },
      },
    }
    let resolve!: (value: unknown) => void
    let reject!: (reason: unknown) => void
    const pending = new Promise((ok, fail) => {
      resolve = ok
      reject = fail
    })
    const makeClient = (answer: Promise<unknown>) =>
      ({
        call: vi.fn(async (method: string) => {
          if (method === '_agnes/v1/profile.decisions.list') return { decisions: [decision] }
          if (method === '_agnes/v1/schedules.list') return { schedules: [] }
          if (method === '_agnes/v1/packages.list') return { packages: [] }
          if (method === '_agnes/v1/admin.triggers') return { snapshot: { rules: [], deliveries: [] } }
          return answer
        }),
      }) as unknown as HostAgnesClient
    const first = makeClient(pending)
    const next = makeClient(new Promise(() => {}))
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    const draw = (client: HostAgnesClient) =>
      act(async () => root.render(createElement(ProfileApprovals, { client, locale })))
    const toggle = () => host.querySelector<HTMLButtonElement>('button[aria-controls="profile-approvals"]')!
    const action = () => document.querySelector<HTMLButtonElement>('[data-testid="approval-action"]')!
    try {
      await draw(first)
      await vi.waitFor(() => expect(toggle()).not.toBeNull(), committed)
      await act(async () => toggle().click())
      await act(async () => action().click())
      await act(async () => toggle().click())
      await draw(next)
      await vi.waitFor(() => expect(toggle()).not.toBeNull(), committed)
      await act(async () => toggle().click())
      await act(async () => action().click())
      expect(action().disabled).toBe(true)
      await act(async () => (outcome === 'saved' ? resolve({}) : reject(new Error('old answer'))))
      expect(document.querySelector('[data-testid="approval-card"]')).not.toBeNull()
      expect(document.querySelector('[role="alert"]')).toBeNull()
      expect(action().disabled).toBe(true)
    } finally {
      await act(async () => root.unmount())
      await ctx.fiber.dispose()
      host.remove()
    }
  },
)

it.each(['en', 'zh-CN'] as const)(
  'prompts only the initiating page and leaves retired requests in the inbox (%s)',
  async (language) => {
    const handle = { id: 'profile-aero', sessionId: null, profileId: 'local-dev' }
    const input = { kind: 'rule', id: 'TVAC-LOT-001', expectedRevision: 2 }
    const decision = {
      handle,
      revision: 2,
      request: {
        owner: 'plugin/dc284c9c60f840ff',
        sourcePackage: '@synthetic/aerospace',
        operationId: 'private-operation',
        expiresAt: '2099-10-21T12:30:00Z',
        spec: {
          prompt: 'Approve aero.decide?',
          subject: { input, presentation: { input, revision: 2, warning: 'Synthetic' } },
          options: ['allowed-once', 'rejected'],
        },
      },
    }
    let pending = true
    const call = vi.fn(async (method: string) => {
      if (method === '_agnes/v1/profile.decisions.list') return { decisions: pending ? [decision] : [] }
      if (method === '_agnes/v1/schedules.list') return { schedules: [] }
      if (method === '_agnes/v1/admin.triggers') return { snapshot: { rules: [], deliveries: [] } }
      if (method === '_agnes/v1/packages.list')
        return {
          packages: [
            {
              id: '@synthetic/aerospace',
              metadata: {
                displayName: 'Aerospace example',
                locales: { 'zh-CN': { displayName: '航空示例' } },
              },
            },
          ],
        }
      pending = false
      return {}
    })
    const receipt = { state: 'approval-required', operationId: 'same-operation', decision: handle }
    let release: (() => void) | undefined
    let delayed: Promise<void> | undefined
    const inventory = vi.spyOn(adminApi, 'homeAdmin').mockResolvedValue({
      api: {
        list: async () => ({
          packages: [
            {
              id: '@synthetic/aerospace',
              metadata: {
                displayName: 'Aerospace example',
                locales: { 'zh-CN': { displayName: '航空示例' } },
              },
            },
          ],
        }),
      },
    } as unknown as adminApi.HomeAdmin)
    const runtime = await mountRenderedIndex({
      agnes: { call } as unknown as AgnesClient,
      clientProfileCaller: async () => {
        if (delayed) await delayed
        return receipt
      },
    })
    runtime.locale.setLocale(language)
    const toggle = () =>
      document.querySelector<HTMLButtonElement>('button[aria-controls="profile-approvals"]')
    const panel = () => document.querySelector<HTMLElement>('#profile-approvals')
    const bridge = (runtime.ctx.get('agnes') as AgnesClientService).profileCaller
    if (!bridge) throw new Error('Missing host profile caller')
    const source = document.body.appendChild(document.createElement('button'))
    source.textContent = 'Request the rule operation'
    const effect = () => {
      source.focus()
      return bridge({ packageId: '@synthetic/aerospace', revision: 'one' }, 'aero.decide', input, {
        operationId: 'same-operation',
      })
    }
    try {
      await vi.waitFor(() => expect(toggle()).toBeTruthy())
      expect(panel()?.hidden).not.toBe(false)
      await bridge({ packageId: '@synthetic/aerospace', revision: 'one' }, 'aero.decide', undefined, {
        operationId: 'same-operation',
        read: true,
      })
      expect(panel()?.hidden).not.toBe(false)
      await expect(effect()).resolves.toEqual(receipt)
      await vi.waitFor(() => expect(panel()?.hidden).toBe(false))
      await vi.waitFor(() =>
        expect(panel()?.querySelector('h2')?.textContent).toBe(
          language === 'en' ? 'Aerospace example · requests an operation' : '航空示例 · 请求执行一个操作',
        ),
      )
      expect(panel()?.closest('.sidebar')).toBeNull()
      expect(panel()?.textContent).not.toContain(
        language === 'en' ? 'Review items that need your attention.' : '查看需要你确认或处理的事项。',
      )
      expect(panel()?.querySelector('.approval-summary-text')?.textContent).toBe(
        language === 'en' ? 'Applies only to this operation.' : '仅对此次操作生效。',
      )
      expect(panel()?.querySelector('.approval-impact')?.textContent).toBe('')
      expect(toggle()).toBeNull()
      expect(panel()?.textContent).toContain(
        language === 'en' ? 'Rule TVAC-LOT-001 · Revision 2' : '规则 TVAC-LOT-001 · 修订 2',
      )
      expect(panel()?.querySelector('time')?.getAttribute('datetime')).toBe('2099-10-21T12:30:00Z')
      expect(panel()?.querySelector('time')?.textContent).toContain('2099')
      expect(panel()?.querySelector('.approval-summary-text')?.textContent).not.toMatch(
        /aero\.decide|Approve /,
      )
      expect(panel()?.querySelector('h2')?.textContent).not.toMatch(/plugin\/|aero\.decide/)
      expect(call.mock.calls.some(([method]) => method.endsWith('decisions.answer'))).toBe(false)
      homeNavigation.open('closed-initiating-page')
      await vi.waitFor(() => expect(toggle()?.querySelector('.home-entry-badge')?.textContent).toBe('1'))
      expect(panel()?.hidden).not.toBe(false)
      toggle()?.click()
      await vi.waitFor(() => expect(panel()?.hidden).toBe(false))
      expect(panel()?.closest('[role="dialog"]')).toBeTruthy()
      // A late response after leaving the initiating page cannot open a new prompt.
      document.querySelector<HTMLButtonElement>('.profile-attention-dialog .ant-modal-close')?.click()
      await vi.waitFor(() => expect(panel()?.hidden).not.toBe(false))
      const nativeDialog = document.body.appendChild(document.createElement('dialog'))
      nativeDialog.setAttribute('open', '')
      nativeDialog.append(source)
      await effect()
      await vi.waitFor(() => expect(panel()?.hidden).toBe(false))
      expect(panel()?.closest('dialog')).toBe(nativeDialog)
      nativeDialog.removeAttribute('open')
      await vi.waitFor(() => expect(panel()?.hidden).not.toBe(false))
      document.body.append(source)
      nativeDialog.remove()
      source.hidden = true
      await effect()
      expect(panel()?.hidden).not.toBe(false)
      source.hidden = false
      delayed = new Promise<void>((done) => {
        release = done
      })
      const late = effect()
      homeNavigation.open('another-page')
      release?.()
      await late
      expect(panel()?.hidden).not.toBe(false)
      delayed = undefined
      await effect()
      await vi.waitFor(() => expect(panel()?.hidden).toBe(false))
      const allow = [
        ...document.querySelectorAll<HTMLButtonElement>('#profile-approvals [data-approval-action]'),
      ].find((button) => button.dataset.approvalAction === 'allowed-once')
      expect(allow).toBeTruthy()
      allow?.click()
      await vi.waitFor(() => expect(toggle()).toBeNull())
      await vi.waitFor(() => expect(panel()).toBeNull())
      expect(call).toHaveBeenCalledWith('_agnes/v1/profile.decisions.answer', {
        handle,
        revision: 2,
        commandId: expect.any(String),
        response: { option: 'allowed-once', value: null },
      })
    } finally {
      inventory.mockRestore()
      homeNavigation.close()
      await runtime.dispose()
      resetWebDom()
    }
  },
)
