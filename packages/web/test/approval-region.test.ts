/** @vitest-environment happy-dom */

import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgnesClient } from '../src/client-modules/boot.js'
import { APPROVAL_SLOT } from '../src/region-slots.js'
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
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const handle = { id: 'profile-decision', sessionId: null, profileId: 'default' }
    const decision = {
      handle,
      revision: 1,
      request: {
        owner: 'plugin/report',
        spec: {
          prompt: 'Publish report?',
          subject: { report: 'reviewed-one' },
          options: ['allowed-once', 'rejected'],
        },
      },
    }
    let pending: (typeof decision)[] = []
    let refuse = true
    let listUnavailable = false
    const call = vi.fn(async (method: string, input?: { handle: typeof handle }) => {
      if (method === '_agnes/v1/profile.decisions.list') {
        if (listUnavailable) throw new Error('temporarily unavailable')
        return { decisions: [...pending] }
      }
      if (refuse) throw new Error('stale decision refused')
      pending = pending.filter((value) => value.handle.id !== input?.handle.id)
      return {}
    })
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
      runtime = await mountRenderedIndex({ agnes: { call } as unknown as AgnesClient })
      runtime.locale.setLocale(language)
      await vi.waitFor(() => expect(call).toHaveBeenCalledWith('_agnes/v1/profile.decisions.list', {}))
      expect(row()).toBeNull()
      expect(surface()).toBeNull()
      expect(document.querySelector('.sidebar-footer')?.textContent).not.toMatch(/Approvals|操作审批/)

      pending = [decision, { ...decision, handle: { ...handle, id: 'second-decision' } }]
      await vi.advanceTimersByTimeAsync(3000)
      await vi.waitFor(() => expect(row()?.querySelector('.home-entry-badge')?.textContent).toBe('2'))
      expect(document.querySelectorAll('button[aria-controls="profile-approvals"]')).toHaveLength(1)
      expect(row()?.closest('.home-entries')).toBeTruthy()
      expect(row()?.classList.contains('home-entry')).toBe(true)
      expect(row()?.classList.contains('agh-btn--ghost')).toBe(true)
      expect(row()?.querySelector('.icon')).toBeTruthy()
      expect(row()?.textContent).toContain(language === 'en' ? 'Approvals' : '操作审批')
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
      listUnavailable = true
      await vi.advanceTimersByTimeAsync(3000)
      expect(row()?.querySelector('.home-entry-badge')?.textContent).toBe('2')
      listUnavailable = false
      await vi.advanceTimersByTimeAsync(3000)
      await vi.waitFor(() => expect(surface()?.querySelector('[role="alert"]')).toBeNull())
      action(allowLabel)?.click()
      await vi.waitFor(() => expect(surface()?.querySelector('[role="alert"]')).toBeTruthy())
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
      expect(call).toHaveBeenLastCalledWith('_agnes/v1/profile.decisions.answer', {
        handle: { ...handle, id: 'second-decision' },
        revision: 1,
        commandId: expect.any(String),
        response: { option: 'rejected', value: null },
      })
      await vi.advanceTimersByTimeAsync(3000)
      expect(row()).toBeNull()

      pending = [decision]
      await vi.advanceTimersByTimeAsync(3000)
      await vi.waitFor(() => expect(row()?.querySelector('.home-entry-badge')?.textContent).toBe('1'))
      // An approval resolved by another client also removes the entry on the next refresh.
      pending = []
      await vi.advanceTimersByTimeAsync(3000)
      await vi.waitFor(() => {
        expect(row()).toBeNull()
        expect(surface()).toBeNull()
      })
    } finally {
      await runtime?.dispose()
      vi.useRealTimers()
      resetWebDom()
    }
  },
)
