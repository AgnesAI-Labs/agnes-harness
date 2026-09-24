/** @vitest-environment happy-dom */

import type { UINode, UITurn } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createConversationAttachmentsRenderer,
  createConversationMessageActions,
  createConversationToolCard,
} from '../src/index.js'

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

describe('conversation leaf renderers', () => {
  it('owns tool detail state and updates it without replacing the surrounding card', () => {
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
    })
    const detail = element.querySelector<HTMLButtonElement>('.tool-detail')
    detail?.click()
    expect(element.dataset.expanded).toBe('true')

    card.update({ ...node, status: 'failed', resultPreview: 'Permission denied' })
    expect(element.dataset.status).toBe('failed')
    expect(element.getAttribute('aria-label')).toBe('工具 read_file：执行失败')
    expect(element.querySelector('.tool-detail-text')?.textContent).toContain('错误详情')
    expect(element.querySelector('.tool-detail-text')?.textContent).toContain('Permission denied')
    expect(element.dataset.expanded).toBe('true')
  })

  it('keeps feedback local to the turn action renderer and clears its timer on disposal', async () => {
    vi.useFakeTimers()
    const first = createConversationMessageActions()
    const second = createConversationMessageActions()
    document.body.append(first.element, second.element)
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

    first.feedback.report('only first', 1600)
    expect(first.feedback.element.textContent).toBe('only first')
    expect(second.feedback.element.textContent).toBe('')
    first.dispose()
    await vi.advanceTimersByTimeAsync(1600)
    expect(first.feedback.element.textContent).toBe('')
  })

  it('keeps the attachment surface empty until the protocol supplies attachment nodes', () => {
    const attachments = createConversationAttachmentsRenderer()
    attachments.element.append(document.createElement('span'))
    attachments.clear()
    expect(attachments.element.hidden).toBe(true)
    expect(attachments.element.childElementCount).toBe(0)
  })
})
