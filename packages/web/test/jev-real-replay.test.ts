/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { EventEnvelope } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'
import { createJevDecisionGraph } from '../src/jev-decision-graph.js'

it('replays persisted real provider decisions and tool settlement at their observed prefixes', () => {
  const capture = JSON.parse(
    readFileSync(resolve(__dirname, '../../core/test/fixtures/jev-real-trace.json'), 'utf8'),
  )
  const events = capture.events as EventEnvelope[]
  const host = document.createElement('section')
  const graph = createJevDecisionGraph(host)
  vi.useFakeTimers()
  try {
    graph.update([], 'agnes:jev-real-fixture')
    graph.update(events, 'agnes:jev-real-fixture')
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(host.querySelector('[data-stage="answer"]')?.textContent).toContain('deepseek-v4-flash')
    expect(host.querySelector('[data-stage="host"]')?.textContent).toContain('本步骤未派发工具')
    expect(host.querySelector('[data-stage="result"]')?.textContent).toContain('不适用 · 回答路径')
    const requests = events.filter((event) => {
      const record = (event.data as { record?: { kind: string; call?: { purpose: string } } }).record
      return record?.kind === 'model.requested' && record.call?.purpose === 'decision'
    })
    const lastRequest = requests.at(-1)!
    host.querySelector<HTMLButtonElement>('[aria-label="查看 Jev 实际请求体"]')!.click()
    const requestDialog = document.querySelector<HTMLDialogElement>('.jev-request-viewer')!
    expect(requestDialog.open).toBe(true)
    const saved = (lastRequest.data as { record: { call: { input: unknown } } }).record.call.input
    // This sanitized historical fixture retained only questions, not the full wire body.
    expect(requestDialog.querySelector('textarea')!.value).toBe('')
    expect(requestDialog.textContent).toContain('未保存完整实际请求体')
    requestDialog.close()
    const complete = {
      model: 'synthetic-decision',
      state: { marker: 'request-viewer' },
      ...(saved as object),
    }
    const enriched = structuredClone(events)
    ;(
      enriched.find((event) => event.seq === lastRequest.seq)!.data as {
        record: { call: { input: unknown } }
      }
    ).record.call.input = complete
    graph.update(enriched, 'agnes:jev-real-fixture')
    host.querySelector<HTMLButtonElement>('[data-stage="decision"]')!.click()
    expect(JSON.parse(requestDialog.querySelector('textarea')!.value)).toEqual(complete)
    requestDialog.close()
    graph.update(events, 'agnes:jev-real-fixture')
    expect(host.querySelector('.jev-edge-pulse')).toBeNull()
    expect(host.querySelector('[data-compact-head][data-status="unconsumed"]')).toBeNull()
    const dormantToggle = host.querySelector<HTMLButtonElement>('[data-group-toggle="action"]')!
    expect(dormantToggle.getAttribute('aria-expanded')).toBe('false')
    const compactHeight = host.querySelector<HTMLElement>('.jev-circuit')!.style.height
    dormantToggle.click()
    expect(host.querySelector('[data-compact-head][data-status="unconsumed"]')).not.toBeNull()
    expect(parseFloat(host.querySelector<HTMLElement>('.jev-circuit')!.style.height)).toBeGreaterThanOrEqual(
      parseFloat(compactHeight),
    )
    host.querySelector<HTMLButtonElement>('[data-group-toggle="action"]')!.click()
    expect(host.querySelector<HTMLElement>('.jev-circuit')!.style.height).toBe(compactHeight)
    const select = host.querySelector<HTMLSelectElement>('[aria-label="Jev 轮次与步骤"]')!
    expect(select.options.length).toBe(4)
    select.selectedIndex = 1
    select.dispatchEvent(new Event('change'))
    expect(host.querySelector('[data-stage="gate"]')?.textContent).toContain('write')
    expect(host.querySelector('[data-stage="result"]')?.textContent).toContain('acknowledged')
    const choices = () => host.querySelectorAll('[data-compact-head="purpose"] .jev-compact-option')
    expect(choices()).toHaveLength(2)
    host.querySelector<HTMLButtonElement>('[aria-label="展开 purpose 候选"]')!.click()
    expect(choices()).toHaveLength(4)
    expect(host.querySelector('[data-stage="gate"]')?.textContent).toContain('write')
    host.querySelector<HTMLButtonElement>('[aria-label="收起 purpose 候选"]')!.click()
    expect(choices()).toHaveLength(2)
    vi.advanceTimersByTime(1000)
    graph.update(events, 'agnes:jev-real-fixture')
    expect(host.querySelector('.jev-edge-pulse')).toBeNull()
    host.querySelector<HTMLButtonElement>('[aria-label="从头回放"]')!.click()
    expect(host.querySelector('[aria-label="暂停回放"]')).not.toBeNull()
    expect(host.querySelector('[data-stage="result"]')?.textContent).not.toContain('acknowledged')
    vi.advanceTimersByTime(1000)
    graph.dispose()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    graph.dispose()
    vi.useRealTimers()
  }
})

it('shows an uncertain effect from a real approved shell cancellation without treating the missing tail as success', () => {
  const capture = JSON.parse(
    readFileSync(resolve(__dirname, '../../core/test/fixtures/jev-real-cancel.json'), 'utf8'),
  )
  const events = capture.events as EventEnvelope[]
  const record = (event: EventEnvelope) => (event.data as { record?: Record<string, unknown> }).record
  const asked = events.find((event) => event.type === 'approval/asked')!
  const approved = events.find((event) => event.type === 'approval/decided')!
  const dispatch = events.find((event) => record(event)?.kind === 'action.dispatching')!
  const settled = events.find((event) => record(event)?.kind === 'action.settled')!
  expect(asked.seq).toBeLessThan(approved.seq)
  expect(approved.seq).toBeLessThan(dispatch.seq)
  expect(record(settled)?.effect).toBe('unknown')
  expect(capture.observedFiles).toEqual({
    started: true,
    finished: false,
    startedWhileApprovalPending: false,
  })
  expect(capture.runtime.phase).toBe('parked')
  const host = document.createElement('section')
  const graph = createJevDecisionGraph(host)
  try {
    graph.update(
      events.filter((event) => event.seq <= asked.seq),
      'agnes:jev-cancel-fixture',
    )
    expect(host.querySelector('[data-edge="intent-dispatch"]')?.getAttribute('data-observed')).toBe('false')
    graph.update(events, 'agnes:jev-cancel-fixture')
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(host.querySelector('[data-stage="result"]')?.textContent).toContain('unknown')
    expect(host.querySelector('[data-edge="intent-dispatch"]')?.getAttribute('data-observed')).toBe('true')
    expect(host.querySelector('.jev-edge-pulse')).not.toBeNull()
    graph.update(events, 'agnes:another-session')
    expect(host.querySelector('.jev-edge-pulse')).toBeNull()
    expect(events.filter((event) => record(event)?.kind === 'action.dispatching')).toHaveLength(1)
  } finally {
    graph.dispose()
  }
})

it('keeps every observed action in one step selectable without changing the replay cursor or request count', () => {
  const required = <T>(value: T | null | undefined): T => {
    if (value == null) throw new Error('Missing batch replay evidence')
    return value
  }
  // A synthetic batch added to the existing sanitized real prefix; no new provider call is implied.
  const capture = JSON.parse(
    readFileSync(resolve(__dirname, '../../core/test/fixtures/jev-real-trace.json'), 'utf8'),
  )
  const prefix = (capture.events as EventEnvelope[]).filter((event) => event.seq <= 31)
  const clone = (seq: number, nextSeq: number, fields: Record<string, unknown>): EventEnvelope => {
    const saved = structuredClone(required(prefix.find((event) => event.seq === seq)))
    const data = saved.data as { runtime: { id: string; version: string }; record: Record<string, unknown> }
    return {
      ...saved,
      seq: nextSeq,
      data: { ...data, record: { ...data.record, ...fields } } as EventEnvelope['data'],
    }
  }
  const intended = clone(27, 33, { id: 'batch-intended', decision: 'batch-decision' })
  const frozen = (intended.data as { record: { intent: { id: string; tool: string } } }).record.intent
  frozen.id = 'batch-intent'
  frozen.tool = 'write'
  const events = [
    ...prefix,
    clone(18, 32, { id: 'batch-decision', operation: 'write' }),
    intended,
    clone(29, 34, { id: 'batch-dispatch', intentId: frozen.id }),
    clone(31, 35, {
      id: 'batch-settled',
      intentId: frozen.id,
      effect: 'not_applied',
      outcome: {
        kind: 'error',
        error: { code: 'FAILED', message: 'Synthetic refusal' },
        content: [],
        directive: { conclude: false, additions: [] },
      },
    }),
  ]
  const host = document.createElement('section')
  const graph = createJevDecisionGraph(host, { sharedReplay: true })
  try {
    graph.update(prefix, 'batch-session')
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Jev 步骤动作"]')?.hidden).toBe(true)
    graph.update(events, 'batch-session')
    expect(host.querySelector('[role="alert"]')).toBeNull()
    const chooser = required(host.querySelector<HTMLSelectElement>('[aria-label="Jev 步骤动作"]'))
    expect(chooser.hidden).toBe(false)
    expect([...chooser.options].map((option) => option.textContent)).toEqual([
      '动作 1/2 · read · 成功',
      '动作 2/2 · write · 失败',
    ])
    expect(chooser.value).toBe('batch-intent')
    expect(host.querySelector('[data-stage="intent"]')?.textContent).toContain('write')
    expect(host.querySelector('[data-stage="result"]')?.textContent).toContain('error')
    expect(host.querySelector('[data-stage="decision"]')?.textContent).toContain('请求 #16')
    chooser.value = 'intent:17'
    chooser.dispatchEvent(new Event('change'))
    expect(host.querySelector('[data-stage="gate"]')?.textContent).toContain('read')
    expect(host.querySelector('[data-stage="result"]')?.textContent).toContain('success')
    expect(host.querySelector('[data-stage="intent"]')?.textContent).toContain('动作 1/2')
    expect(host.querySelector('[role="status"]')?.textContent).toContain('#35')
    graph.update(structuredClone(events), 'batch-session')
    expect(chooser.value).toBe('intent:17')
    expect(host.querySelector('[data-stage="result"]')?.textContent).toContain('success')
    graph.update(
      events.filter((event) => event.seq <= 33),
      'batch-session',
    )
    chooser.value = 'batch-intent'
    chooser.dispatchEvent(new Event('change'))
    expect(host.querySelector('[data-stage="host"]')?.textContent).toContain('等待派发记录')
    expect(host.querySelector('[data-stage="result"]')?.textContent).toContain('未观测结算')
    graph.update(prefix, 'batch-session')
    expect(chooser.options).toHaveLength(1)
    expect(chooser.hidden).toBe(true)
    expect(host.querySelector('[data-stage="intent"]')?.textContent).toContain('read')
    graph.update(events, 'different-batch-session')
    expect(chooser.value).toBe('batch-intent')
    expect(
      events.filter(
        (event) => (event.data as { record?: { kind: string } }).record?.kind === 'model.requested',
      ),
    ).toHaveLength(2)
  } finally {
    graph.dispose()
  }
})
