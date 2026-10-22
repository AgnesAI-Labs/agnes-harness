/** @vitest-environment happy-dom */

import type { UINode, UITurn } from '@agnes/protocol'
import { setDisclosureOpen, webUiLocaleCatalog } from '@agnes/web-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createConversationAttachmentsRenderer,
  createConversationFeedback,
  createConversationMessageActions,
  createConversationToolCard,
  webUnitsLocaleCatalog,
} from '../src/index.js'

const zhT = (key: string, vars?: Record<string, string | number>): string => {
  const template = webUnitsLocaleCatalog['zh-CN'][key] ?? webUiLocaleCatalog['zh-CN'][key] ?? key
  return vars
    ? template.replace(/\{(\w+)\}/g, (match, name: string) => String(vars[name] ?? match))
    : template
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

function completedTurn(overrides: Partial<UITurn> = {}): UITurn {
  return {
    id: 'turn:renderer',
    turn: 1,
    startSeq: 1,
    endSeq: 2,
    startedAt: '2026-09-22T00:00:00.000Z',
    endedAt: '2026-09-22T00:00:03.000Z',
    durationMs: 3000,
    status: 'completed',
    nodeIds: ['user', 'assistant'],
    finalAssistantId: 'assistant',
    usage: {
      totals: { input: 12, output: 4, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      reasoningComplete: true,
      billingComplete: true,
      calls: [],
    },
    inherited: false,
    forkable: true,
    ...overrides,
  }
}

function required<T extends Element>(parent: ParentNode, selector: string): T {
  const element = parent.querySelector<T>(selector)
  if (!element) throw new Error(`missing ${selector}`)
  return element
}

describe('conversation leaf renderers', () => {
  it('dismisses its usage panel on an outside click and preserves the open panel on updates', async () => {
    const actions = createConversationMessageActions({ t: zhT })
    document.body.append(actions.element)
    expect(actions.element.querySelector('footer.turn-footer')).not.toBeNull()
    const details = required<HTMLElement>(actions.element, '.turn-usage')
    const summary = required<HTMLElement>(details, '.turn-meta')
    try {
      actions.update({ turn: completedTurn(), finalText: 'answer', settled: true })
      setDisclosureOpen(details, true)
      summary.focus()
      actions.update({ turn: completedTurn({ durationMs: 4000 }), finalText: 'answer', settled: true })
      expect(actions.element.querySelector('.turn-usage')).toBe(details)
      expect(details.dataset.open).toBe('true')
      expect(document.activeElement).toBe(summary)
      required<HTMLElement>(details, 'dl').click()
      await new Promise((resolve) => setTimeout(resolve))
      expect(details.dataset.open).toBe('true')
      document.body.click()
      await vi.waitFor(() => expect(details.dataset.open).toBe('false'))
    } finally {
      actions.dispose()
    }
  })

  it('releases its document click listener on disposal, including repeated disposal', async () => {
    const add = vi.spyOn(document, 'addEventListener')
    const remove = vi.spyOn(document, 'removeEventListener')
    const actions = createConversationMessageActions({ t: zhT })
    document.body.append(actions.element)
    try {
      actions.update({ turn: completedTurn(), finalText: 'answer', settled: true })
      setDisclosureOpen(required<HTMLElement>(actions.element, '.turn-usage'), true)
      await vi.waitFor(() => expect(add.mock.calls.filter(([type]) => type === 'click')).toHaveLength(1))
      const listener = add.mock.calls.find(([type]) => type === 'click')?.[1]
      actions.dispose()
      actions.dispose()
      await vi.waitFor(() =>
        expect(
          remove.mock.calls.filter(([type, removed]) => type === 'click' && removed === listener),
        ).toHaveLength(1),
      )
    } finally {
      actions.dispose()
      add.mockRestore()
      remove.mockRestore()
    }
  })

  it('owns tool detail state and updates it without replacing the surrounding card', async () => {
    const element = document.createElement('article')
    document.body.append(element)
    const node: Extract<UINode, { kind: 'tool' }> = {
      kind: 'tool',
      id: 'tool:1',
      seq: 1,
      toolUseId: 'call:1',
      name: 'read_file',
      status: 'running',
      summary: '正在读取 README.md',
      enforcement: { level: 'full', scope: ['file'] },
      children: [],
      slots: [],
    }
    const card = createConversationToolCard(element, node, {
      icon: () => document.createElement('span'),
      translate: zhT,
    })
    const detail = element.querySelector<HTMLButtonElement>('.tool-detail')
    detail?.click()
    expect(element.dataset.expanded).toBe('true')
    // The row names the status only when the step needs the reader or did not finish; the label
    // on the article always does.
    for (const [status, label, shown] of [
      ['planned', '等待执行', undefined],
      ['awaiting_approval', '等待审批', '等待审批'],
      ['running', '正在执行', undefined],
      ['completed', '执行完成', undefined],
      ['cancelled', '已取消', '已取消'],
    ] as const) {
      card.update({ ...node, status })
      expect(element.dataset.status).toBe(status)
      expect(element.getAttribute('aria-label')).toBe(`工具 read_file：${label}`)
      expect(element.querySelector('.tool-status')?.textContent).toBe(shown)
    }
    card.update({ ...node, status: 'running' })
    expect(element.querySelector('.activity-row')?.getAttribute('data-state')).toBe('running')
    // A summary that only repeats the call is not shown; a readable one is the row's target.
    card.update({ ...node, summary: 'read_file {"path":"README.md"}' })
    expect(element.querySelector('.activity-target')).toBeNull()
    card.update({ ...node, summary: 'read_file 已读取 README.md' })
    expect(element.querySelector('.activity-target')?.textContent).toBe('read_file 已读取 README.md')
    card.update({
      ...node,
      argsPreview: JSON.stringify({ path: `${['', 'Users', 'someone'].join('/')}/project/README.md` }),
    })
    expect(element.querySelector('.activity-target')?.textContent).toBe('~/project/README.md')
    expect(element.querySelector('[data-agnes-tool-card]')).not.toBeNull()

    card.update({ ...node, status: 'failed', resultPreview: 'Permission denied' })
    expect(element.dataset.status).toBe('failed')
    expect(element.getAttribute('aria-label')).toBe('工具 read_file：执行失败')
    expect(element.querySelector('[data-testid="tool-detail-text"]')?.textContent).toContain('错误详情')
    expect(element.querySelector('[data-testid="tool-detail-text"]')?.textContent).toContain(
      'Permission denied',
    )
    expect(element.dataset.expanded).toBe('true')
    card.dispose()
    card.update({ ...node, status: 'completed' })
    expect(element.dataset.status).toBe('failed')
    await Promise.resolve()
    expect(element.querySelector('[data-agnes-tool-card]')).toBeNull()
    element.remove()
  })

  it('keeps feedback local to the turn action renderer and clears its timer on disposal', async () => {
    vi.useFakeTimers()
    const first = createConversationMessageActions({ t: zhT })
    const second = createConversationMessageActions({ t: zhT })
    const standalone = createConversationFeedback()
    document.body.append(first.element, second.element, standalone.element)
    standalone.report('standalone', 1600)
    expect(standalone.element.getAttribute('role')).toBe('status')
    expect(standalone.element.textContent).toBe('standalone')
    const state = { turn: completedTurn(), finalText: 'answer', settled: true }
    first.update(state)
    second.update(state)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    })
    first.element.querySelector<HTMLButtonElement>('[aria-label="复制回答"]')?.click()
    await vi.runAllTimersAsync()
    expect(first.element.querySelector('.turn-feedback')?.textContent).toBe('')
    expect(second.element.querySelector('.turn-feedback')?.textContent).toBe('')
    expect(standalone.element.textContent).toBe('')
    standalone.report('dispose clears this', 1600)
    standalone.dispose()
    standalone.dispose()
    expect(standalone.element.textContent).toBe('')

    first.feedback.report('only first', 1600)
    expect(first.element.contains(first.feedback.element)).toBe(true)
    expect(first.feedback.element.textContent).toBe('only first')
    expect(second.feedback.element.textContent).toBe('')
    first.dispose()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(1600)
    expect(first.feedback.element.textContent).toBe('')
    second.dispose()
  })

  it('keeps two legacy action roots independent through replay and a failed fork retry', async () => {
    let rejectFirst: (error: Error) => void = () => undefined
    const onFork = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectFirst = reject
          }),
      )
      .mockResolvedValueOnce(undefined)
    const first = createConversationMessageActions({ onFork, t: zhT })
    const second = createConversationMessageActions({ t: zhT })
    document.body.append(first.element, second.element)
    const firstTurn = completedTurn({ id: 'turn:first' })
    const secondTurn = completedTurn({ id: 'turn:second' })
    try {
      first.update({ turn: firstTurn, finalText: 'first answer', settled: true })
      second.update({ turn: secondTurn, finalText: 'second answer', settled: true })
      const firstDetails = required<HTMLElement>(first.element, '.turn-usage')
      const secondDetails = required<HTMLElement>(second.element, '.turn-usage')
      setDisclosureOpen(firstDetails, true)
      first.update({ turn: { ...firstTurn, durationMs: 4000 }, finalText: 'first answer+', settled: true })
      first.update({ turn: firstTurn, finalText: 'first answer+', settled: true })
      expect(required(first.element, '.turn-usage')).toBe(firstDetails)
      expect(firstDetails.dataset.open).toBe('true')
      expect(required(second.element, '.turn-usage')).toBe(secondDetails)

      const fork = required<HTMLButtonElement>(first.element, '[aria-label="分支到新聊天"]')
      fork.click()
      await vi.waitFor(() => expect(fork.disabled).toBe(true))
      rejectFirst(new Error('offline'))
      await vi.waitFor(() => expect(first.feedback.element.textContent).toBe('分支失败，请重试。'))
      expect(first.element.contains(first.feedback.element)).toBe(true)
      expect(fork.disabled).toBe(false)
      expect(second.feedback.element.textContent).toBe('')
      fork.click()
      await vi.waitFor(() => expect(onFork).toHaveBeenCalledTimes(2))
      expect(first.feedback.element.textContent).toBe('')
      expect(secondDetails.isConnected).toBe(true)
    } finally {
      first.dispose()
      second.dispose()
    }
  })

  it('keeps the attachment surface empty until the protocol supplies attachment nodes', () => {
    const attachments = createConversationAttachmentsRenderer()
    attachments.element.append(document.createElement('span'))
    attachments.clear()
    expect(attachments.element.hidden).toBe(true)
    expect(attachments.element.childElementCount).toBe(0)
    attachments.dispose()
  })
})
