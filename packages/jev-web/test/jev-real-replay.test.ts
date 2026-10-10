/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { projectTrace } from '@agnes/jev-trace'
import type { EventEnvelope } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'
import { createJevDecisionGraph, jevTraceEntries } from '../src/jev-decision-graph.js'
import { createJevTranslate } from '../src/jev-locale.js'

const t = createJevTranslate('zh-CN')

it('replays persisted real provider decisions and tool settlement at their observed prefixes', () => {
  const capture = JSON.parse(
    readFileSync(resolve(__dirname, '../../core/test/fixtures/jev-real-trace.json'), 'utf8'),
  )
  const events = capture.events as EventEnvelope[]
  const host = document.createElement('section')
  const graph = createJevDecisionGraph(host, undefined, t)
  const sharedHost = document.createElement('section')
  const sharedGraph = createJevDecisionGraph(sharedHost, { sharedReplay: true }, t)
  const sharedViewport = sharedHost.querySelector<HTMLElement>('.jev-graph-viewport')!
  Object.defineProperties(sharedViewport, { clientWidth: { value: 900 }, clientHeight: { value: 620 } })
  vi.useFakeTimers()
  try {
    graph.update([], 'agnes:jev-real-fixture')
    graph.update(events, 'agnes:jev-real-fixture')
    const viewport = host.querySelector<HTMLElement>('.jev-graph-viewport')!
    Object.defineProperties(viewport, {
      clientWidth: { value: 900, configurable: true },
      clientHeight: { value: 620, configurable: true },
    })
    graph.update(events, 'agnes:jev-real-fixture')
    const mainNodes = Array.from(host.querySelectorAll<HTMLElement>('[data-stage]'))
    const assertCoordinateSpace = () => {
      const diagram = host.querySelector<HTMLElement>('.jev-circuit')!
      const svg = diagram.querySelector('svg')!
      const [x, y, width, height] = svg.getAttribute('viewBox')!.split(' ').map(Number)
      expect([x, y]).toEqual([0, 0])
      expect([parseFloat(diagram.style.width), parseFloat(diagram.style.height)]).toEqual([width, height])
      for (const fan of host.querySelectorAll<HTMLElement>('.jev-flow-fan')) {
        const panel = [...svg.querySelectorAll('[data-circuit-panel]')].find((element) =>
          element.getAttribute('data-circuit-panel')?.endsWith(`:${fan.dataset.compactHead}`),
        )!
        expect(Number(panel.getAttribute('x'))).toBe(parseFloat(fan.style.left) + 4)
        expect(Number(panel.getAttribute('y'))).toBe(parseFloat(fan.style.top) + 4)
      }
    }
    const boxes = () =>
      mainNodes.map((node) => [node.style.left, node.style.top, node.style.width, node.style.height])
    assertCoordinateSpace()
    const mainBoxes = boxes()
    const headSlots = new Map<string, { node: HTMLElement; left: string; top: string }>()
    const transform = host.querySelector<HTMLElement>('.jev-circuit')!.style.transform
    const space = host.querySelector<HTMLElement>('.jev-canvas-space')!
    const reservedSpace = [space.style.width, space.style.height]
    const entries = jevTraceEntries(events)
    const reservation = {
      heads: Math.max(
        0,
        ...projectTrace(entries).turns.flatMap((turn) =>
          turn.steps.flatMap((step) =>
            step.requests.map((request) => (request.purpose === 'decision' ? request.heads.length : 0)),
          ),
        ),
      ),
    }
    sharedGraph.update(
      events.filter((event) => event.seq <= entries[0]!.seq),
      'shared-reserve',
    )
    const sharedMain = sharedHost.querySelector('[data-stage="decision"]')!
    const sharedSpace = sharedHost.querySelector<HTMLElement>('.jev-canvas-space')!
    const sharedGeometry = [
      sharedSpace.style.width,
      sharedSpace.style.height,
      sharedHost.querySelector<HTMLElement>('.jev-circuit')!.style.transform,
    ]
    const replayCursor = host.querySelector<HTMLInputElement>('[aria-label="Jev 账本回放位置"]')!
    // Happy DOM has no layout engine: exposed coordinates and transform establish the box;
    // browser QA separately checks rendered bounding rectangles and scrollbar behaviour.
    for (let index = 0; index < entries.length; index++) {
      replayCursor.value = String(index)
      replayCursor.dispatchEvent(new Event('input'))
      sharedGraph.update(
        events.filter((event) => event.seq <= entries[index]!.seq),
        'shared-reserve',
      )
      expect(sharedHost.querySelector('[data-stage="decision"]')).toBe(sharedMain)
      expect([
        sharedSpace.style.width,
        sharedSpace.style.height,
        sharedHost.querySelector<HTMLElement>('.jev-circuit')!.style.transform,
      ]).toEqual(sharedGeometry)
      if (entries[index]!.seq < 16) expect(sharedHost.querySelector('.jev-flow-fan')).toBeNull()
      expect(host.querySelector('[role="alert"]')).toBeNull()
      for (const node of mainNodes)
        expect(host.querySelector(`[data-stage="${node.dataset.stage}"]`)).toBe(node)
      for (const head of host.querySelectorAll<HTMLElement>('.jev-flow-fan')) {
        const key = `${head.dataset.request}:${head.dataset.compactHead}`
        const previous = headSlots.get(key)
        if (previous) {
          expect(head).toBe(previous.node)
          expect([head.style.left, head.style.top]).toEqual([previous.left, previous.top])
        } else headSlots.set(key, { node: head, left: head.style.left, top: head.style.top })
      }
      assertCoordinateSpace()
      expect(boxes()).toEqual(mainBoxes)
      expect(host.querySelector<HTMLElement>('.jev-circuit')!.style.transform).toBe(transform)
      expect([space.style.width, space.style.height]).toEqual(reservedSpace)
      if (entries[index]!.seq < 16) expect(host.querySelector('.jev-flow-fan')).toBeNull()
      if (entries[index]!.seq === 16) {
        const options = host.querySelectorAll('[data-compact-head="purpose"] .jev-flow-option')
        expect(options.length).toBeGreaterThan(0)
        for (const option of options) {
          expect(option.querySelector('small')?.textContent).not.toContain('%')
          expect(option.getAttribute('data-selected')).toBe('false')
        }
      }
      if (entries[index]!.seq < 92) {
        const answerNode = host.querySelector<HTMLButtonElement>('[data-stage="answer"]')!
        expect(answerNode.disabled).toBe(true)
        expect(answerNode.onclick).toBeNull()
        expect(answerNode.title).not.toContain('deepseek-v4-flash')
      }
    }
    // Replay-driven panel reflow must not change the camera; explicit fit and width adjustment can.
    Object.defineProperty(viewport, 'clientHeight', { value: 400, configurable: true })
    graph.update(events, 'agnes:jev-real-fixture')
    expect(host.querySelector<HTMLElement>('.jev-circuit')!.style.transform).toBe(transform)
    host.querySelector<HTMLButtonElement>('[aria-label="适应画布"]')!.click()
    expect(host.querySelector<HTMLElement>('.jev-circuit')!.style.transform).not.toBe(transform)
    Object.defineProperty(viewport, 'clientHeight', { value: 620, configurable: true })
    host.querySelector<HTMLButtonElement>('[aria-label="适应画布"]')!.click()
    expect(host.querySelector<HTMLElement>('.jev-circuit')!.style.transform).toBe(transform)
    Object.defineProperty(viewport, 'clientWidth', { value: 780, configurable: true })
    graph.update(events, 'agnes:jev-real-fixture')
    expect(host.querySelector<HTMLElement>('.jev-circuit')!.style.transform).not.toBe(transform)
    Object.defineProperty(viewport, 'clientWidth', { value: 900, configurable: true })
    graph.update(events, 'agnes:jev-real-fixture')
    expect(host.querySelector<HTMLElement>('.jev-circuit')!.style.transform).toBe(transform)
    sharedGraph.update(events.slice(0, 1), 'known-geometry', reservation)
    const knownTransform = sharedHost.querySelector<HTMLElement>('.jev-circuit')!.style.transform
    const knownSpace = sharedHost.querySelector<HTMLElement>('.jev-canvas-space')!
    const firstKnownHeight = parseFloat(knownSpace.style.height)
    sharedGraph.update(events.slice(0, 1), 'known-geometry', { heads: 20 })
    expect(sharedHost.querySelector<HTMLElement>('.jev-circuit')!.style.transform).toBe(knownTransform)
    expect(parseFloat(knownSpace.style.height)).toBeGreaterThan(firstKnownHeight)
    expect(sharedHost.querySelector('.jev-flow-fan')).toBeNull()
    sharedGraph.update(events, 'known-geometry', { heads: 20 })
    const extendedTransform = sharedHost.querySelector<HTMLElement>('.jev-circuit')!.style.transform
    sharedGraph.update(events.slice(0, 1), 'known-geometry')
    expect(sharedHost.querySelector<HTMLElement>('.jev-circuit')!.style.transform).toBe(extendedTransform)
    expect(sharedHost.querySelector('.jev-flow-fan')).toBeNull()
    sharedGraph.update(events.slice(0, 1), 'different-shared-session', { heads: 20 })
    const freshSpace = sharedHost.querySelector<HTMLElement>('.jev-canvas-space')!
    expect(parseFloat(freshSpace.style.height)).toBeLessThanOrEqual(620 - 32)
    expect(sharedHost.querySelector('[data-stage="decision"]')).not.toBe(sharedMain)
    // Reverse seeking keeps the same reserve and never leaves a future request handler behind.
    replayCursor.value = '0'
    replayCursor.dispatchEvent(new Event('input'))
    expect(host.querySelector<HTMLElement>('.jev-circuit')!.style.transform).toBe(transform)
    expect([space.style.width, space.style.height]).toEqual(reservedSpace)
    expect(host.querySelector('.jev-flow-fan')).toBeNull()
    host.querySelector<HTMLButtonElement>('[aria-label="跟随最新"]')!.click()
    vi.advanceTimersByTime(1000)
    graph.update(events, 'agnes:jev-real-fixture')
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(host.querySelector<HTMLElement>('[data-stage="answer"]')?.title).toContain('deepseek-v4-flash')
    expect(host.querySelector('[data-stage="host"]')?.textContent).toContain('本步不派发工具')
    expect(host.querySelector('[data-stage="result"]')?.textContent).toContain('不适用 · 回答路径')
    const requests = events.filter((event) => {
      const record = (event.data as { record?: { kind: string; call?: { purpose: string } } }).record
      return record?.kind === 'model.requested' && record.call?.purpose === 'decision'
    })
    const lastRequest = requests.at(-1)!
    host.querySelector<HTMLButtonElement>('[aria-label="查看决策模型实际请求体"]')!.click()
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
    expect(host.querySelector('[data-compact-head][data-status="unconsumed"]')).not.toBeNull()
    expect(host.querySelector('.jev-flow-packet')).toBeNull()
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
    host.querySelector<HTMLButtonElement>('[aria-label="收起 purpose 候选"]')!.click()
    expect(choices()).toHaveLength(2)
    expect(host.querySelector('[data-stage="gate"]')?.textContent).toContain('write')
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
    sharedGraph.dispose()
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
  const graph = createJevDecisionGraph(host, undefined, t)
  vi.useFakeTimers()
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
    const pulse = host.querySelector<SVGElement>('[data-pulse-edge="intent-dispatch"]')!
    const initialDelay = pulse.style.animationDelay
    vi.advanceTimersByTime(125)
    graph.update(events, 'agnes:jev-cancel-fixture')
    expect(host.querySelector('[data-pulse-edge="intent-dispatch"]')).toBe(pulse)
    expect(pulse.style.animationDelay).toBe(initialDelay)
    vi.advanceTimersByTime(600)
    graph.update(events, 'agnes:jev-cancel-fixture')
    expect(pulse.style.animationDelay).toBe(initialDelay)
    vi.advanceTimersByTime(175)
    graph.update(events, 'agnes:jev-cancel-fixture')
    expect(host.querySelector('[data-pulse-edge="intent-dispatch"]')).toBeNull()

    graph.update(events, 'agnes:another-session')
    expect(host.querySelector('.jev-edge-pulse')).toBeNull()
    expect(events.filter((event) => record(event)?.kind === 'action.dispatching')).toHaveLength(1)
  } finally {
    graph.dispose()
    vi.useRealTimers()
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
  const graph = createJevDecisionGraph(host, { sharedReplay: true }, t)
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
    const resultNode = host.querySelector<HTMLButtonElement>('[data-stage="result"]')!
    resultNode.click()
    expect(host.querySelector('.jev-node-evidence pre')?.textContent).toContain('batch-intent')
    expect(host.querySelector<HTMLElement>('[data-stage="decision"]')?.title).toContain('请求 #16')
    chooser.value = 'intent:17'
    chooser.dispatchEvent(new Event('change'))
    expect(host.querySelector('[data-stage="gate"]')?.textContent).toContain('read')
    expect(host.querySelector('[data-stage="result"]')?.textContent).toContain('success')
    expect(host.querySelector('[data-stage="result"]')).toBe(resultNode)
    resultNode.click()
    expect(host.querySelector('.jev-node-evidence pre')?.textContent).toContain('intent:17')
    expect(host.querySelector('.jev-node-evidence pre')?.textContent).not.toContain('batch-intent')
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
