/** @vitest-environment happy-dom */
import type { EventEnvelope } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import { afterEach, expect, it, vi } from 'vitest'
import { createJevTranslate } from '../src/jev-locale.js'
import { createJevDecisionGraph } from '../src/jev-decision-graph.js'
import { createRuntimeRecordTrace } from '../src/runtime-record-trace.js'

const t = createJevTranslate('zh-CN')

afterEach(() => vi.useRealTimers())

function event(
  seq: number,
  record: Record<string, unknown>,
  turn = 'turn-a',
  step = 'step-a',
): EventEnvelope {
  return {
    seq,
    ts: new Date(seq * 1000).toISOString(),
    id: `host-${seq}`,
    type: 'runtime/record',
    data: {
      runtime: { id: 'jevloop', version: '1' },
      record: { version: 1, id: `record-${seq}`, turn, step, ...record },
    },
  } as unknown as EventEnvelope
}
const choice = (selected: string, keys: string[]) => ({
  type: 'choice',
  choice: selected,
  confidence: 0.9,
  probabilities: Object.fromEntries(keys.map((key) => [key, key === selected ? 1 : 0])),
})
const request = (purpose: string, input: unknown = {}) => ({
  purpose,
  backend: purpose === 'decision' ? 'jev' : 'agnes-provider',
  endpoint: 'local',
  requestedModel: 'test-model',
  codec: 'systemone-json-v1',
  input,
  inputCursor: '0',
})
function fixture() {
  return [
    event(1, {
      kind: 'resource.observed',
      resource: {
        kind: 'jev.decision.manifest.v1',
        designRevision: 5,
        operations: [
          {
            purpose: 'INSPECT',
            question: 'operation_INSPECT',
            choices: [{ key: 'read', kind: 'tool', operation: 'read' }],
          },
          {
            purpose: 'VERIFY',
            question: 'operation_VERIFY',
            choices: [{ key: 'read', kind: 'tool', operation: 'read' }],
          },
          { purpose: 'RESPOND', question: null, choices: [{ key: 'RESPOND', kind: 'respond' }] },
        ],
        bindings: [
          {
            key: 'binding_read',
            operation: 'read',
            mode: 'parameterized',
            question: 'binding_read',
            choices: [{ key: 'known', candidate: { id: 'candidate-1' } }],
          },
        ],
      },
    }),
    event(2, {
      kind: 'model.requested',
      call: request('decision', {
        questions: {
          purpose: { type: 'choice', criteria: { INSPECT: 'Inspect', RESPOND: 'Respond' } },
          operation_INSPECT: { type: 'choice', criteria: { read: 'Read' } },
          operation_VERIFY: { type: 'choice', criteria: { read: 'Read' } },
          binding_read: {
            type: 'choice',
            criteria: { known: '<script>not executable</script>', LLM_PARAMETERS: 'Generate arguments' },
          },
        },
      }),
    }),
    event(3, {
      kind: 'model.settled',
      requested: 'record-2',
      settlement: {
        output: {
          answers: {
            purpose: choice('INSPECT', ['INSPECT', 'RESPOND']),
            operation_INSPECT: choice('read', ['read']),
            operation_VERIFY: choice('read', ['read']),
            binding_read: choice('known', ['known', 'LLM_PARAMETERS']),
          },
        },
      },
    }),
    event(4, {
      kind: 'decision.selected',
      requested: 'record-2',
      phase: 'INSPECT',
      operation: 'read',
      candidateId: 'candidate-1',
      confidence: 0.9,
    }),
    event(5, {
      kind: 'resource.observed',
      resource: {
        kind: 'jev.decision.route.v1',
        requested: 'record-2',
        decisionRecordId: 'record-4',
        purpose: 'INSPECT',
        operation: 'read',
        reasons: [],
        supportApplied: true,
        supportingQuestionIds: ['operation_VERIFY'],
      },
    }),
    event(6, {
      kind: 'action.intended',
      decision: 'record-4',
      intent: {
        id: 'intent-1',
        tool: 'read',
        arguments: { path: 'safe' },
        toolRevision: '1',
        environmentEpoch: 'env-1',
        effectClass: 'read_only',
      },
    }),
    event(7, { kind: 'action.dispatching', intentId: 'intent-1', epoch: 'env-1' }),
    event(8, {
      kind: 'action.settled',
      intentId: 'intent-1',
      outcome: { kind: 'success', content: [], directive: { conclude: false, additions: [] } },
      effect: 'unknown',
      observations: [],
    }),
    event(9, {
      kind: 'run.stopped',
      reason: 'blocked',
      detail: 'Effect uncertain',
      unresolved: ['intent-1'],
    }),
  ]
}

it('restores the visible decision circuit across fixed-prefix pages and renders adopted/supporting branches without executing records', async () => {
  const events = fixture()
  const call = vi
    .fn()
    .mockResolvedValueOnce({ events: events.slice(0, 4), lastSeq: 9, nextAfterSeq: 4 })
    .mockResolvedValueOnce({
      events: [
        ...events.slice(4),
        event(10, { kind: 'run.stopped', reason: 'completed', detail: 'future', unresolved: [] }),
      ],
      lastSeq: 10,
      nextAfterSeq: null,
    })
  const host = document.createElement('section')
  const trace = createRuntimeRecordTrace(host, { call } as unknown as Pick<Client, 'call'>, undefined, {
    t,
  })
  trace.select('jev-session', 9)
  await vi.waitFor(() =>
    expect(host.querySelector('.runtime-trace-coverage')?.textContent).toContain('完整账本前缀 #0–9'),
  )
  expect(host.querySelector('.jev-decision-graph')).not.toBeNull()
  expect(host.querySelector('[data-head="purpose"]')?.getAttribute('data-status')).toBe('consumed')
  expect(host.querySelector('[data-head="operation_VERIFY"]')?.getAttribute('data-status')).toBe('supporting')
  expect(host.querySelector('[data-head="binding_read"]')?.textContent).toContain('known')
  expect(host.querySelector('[data-stage="result"]')?.textContent).toContain('effect: unknown')
  expect(
    host.querySelector<HTMLElement>('[data-compact-head="purpose"] [data-option-key="RESPOND"]')?.title,
  ).toContain('未采用')
  expect(host.querySelector<HTMLElement>('[data-stage="helper"]')?.title).toContain('等待 LLM 补参或接管')
  expect(host.querySelector('[data-edge="intent-dispatch"]')?.getAttribute('data-observed')).toBe('true')
  expect(host.querySelector('[data-edge="gate-answer"]')?.getAttribute('data-observed')).toBe('false')
  expect(host.textContent).not.toContain('future')
  expect(host.querySelector('script')).toBeNull()
  expect(call.mock.calls.every(([method]) => method === '_agnes/v1/diagnostics.events')).toBe(true)
  expect(call.mock.calls[1]?.[1]).toMatchObject({ sessionId: 'jev-session', afterSeq: 4 })
  trace.observe(events[8]!)
  expect(host.querySelectorAll('.runtime-record-rows > li')).toHaveLength(9)
  const cursor = host.querySelector<HTMLInputElement>('[aria-label="Jev 账本回放位置"]')!
  cursor.value = '2'
  cursor.dispatchEvent(new Event('input'))
  expect(host.querySelector('[data-head="purpose"]')?.getAttribute('data-status')).toBe('unconsumed')
  expect(host.querySelector('[data-stage="intent"]')?.textContent).toContain('尚无动作意图')
  expect(call).toHaveBeenCalledTimes(2)
  trace.select()
  expect(host.hidden).toBe(true)
  expect(host.querySelectorAll('.runtime-record-rows > li')).toHaveLength(0)
})

it('distinguishes helper retries and answer evidence and keeps independent graph cursors', () => {
  const first = document.createElement('section')
  const second = document.createElement('section')
  const a = createJevDecisionGraph(first, undefined, t)
  const b = createJevDecisionGraph(second, undefined, t)
  const events = fixture().slice(0, 5)
  events.push(
    event(6, { kind: 'model.requested', call: request('parameters') }),
    event(7, {
      kind: 'model.settled',
      requested: 'record-6',
      settlement: { error: { code: 'RETRY', message: 'retry', retryable: true } },
    }),
    event(8, {
      kind: 'model.requested',
      call: {
        ...request('parameters', { request: { messages: [], tools: [] } }),
        codec: 'agnes-language-v1',
      },
    }),
    event(9, { kind: 'model.requested', call: request('answer') }),
    event(10, {
      kind: 'model.settled',
      requested: 'record-9',
      settlement: { output: { content: [{ kind: 'text', text: 'Recorded answer' }] } },
    }),
  )
  a.update(events, 'session-a')
  b.update(fixture(), 'session-b')
  const inspector = first.querySelector<HTMLElement>('.jev-graph-detail')!
  expect(inspector.hidden).toBe(true)
  expect(first.querySelector('.jev-circuit .jev-circuit-pools')).not.toBeNull()
  for (const head of first.querySelectorAll('.jev-compact-head'))
    expect(head.querySelectorAll('.jev-compact-option').length).toBeLessThanOrEqual(4)
  expect(first.querySelector('.jev-compact-option[data-selected="true"]')?.textContent).toContain('100.0%')
  first.querySelector<HTMLButtonElement>('[data-stage="candidates"]')?.click()
  expect(inspector.hidden).toBe(false)
  expect(first.querySelector<HTMLElement>('.jev-candidate-pools')?.hidden).toBe(false)
  first.querySelector<HTMLButtonElement>('[aria-label="关闭检查器"]')?.click()
  expect(inspector.hidden).toBe(true)
  first.querySelector<HTMLButtonElement>('[data-stage="helper"]')?.click()
  expect(first.querySelector<HTMLDetailsElement>('.jev-node-evidence details')?.open).toBe(false)
  first
    .querySelector('.jev-decision-graph')
    ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(inspector.hidden).toBe(true)
  const diagram = first.querySelector<HTMLElement>('.jev-circuit')!
  const originalZoom = diagram.style.transform
  first.querySelector<HTMLButtonElement>('[aria-label="放大画布"]')?.click()
  expect(diagram.style.transform).not.toBe(originalZoom)
  first.querySelector<HTMLButtonElement>('[aria-label="适应画布"]')?.click()
  expect(diagram.style.transform).toBe(originalZoom)
  // The horizontal circuit retains readable node sizes in narrow panes; explicit fit provides an overview.
  Object.defineProperty(first.querySelector('.jev-graph-viewport'), 'clientWidth', {
    value: 560,
    configurable: true,
  })
  a.update(events, 'session-a')
  expect(parseFloat(first.querySelector<HTMLElement>('.jev-circuit')!.style.width)).toBeGreaterThan(560)
  expect(parseFloat(first.querySelector<HTMLElement>('[data-stage="decision"]')!.style.width)).toBe(96)
  expect(first.querySelector('[data-stage="language-context"]')?.getAttribute('data-observed')).toBe('true')
  expect(first.querySelector('[data-stage="language-context"]')?.textContent).toContain('已记录')
  expect(first.querySelector<HTMLElement>('[data-stage="language-context"]')?.title).toContain(
    '不证明网络发送',
  )
  expect(first.querySelector('[data-edge="language-context-helper"]')?.getAttribute('data-observed')).toBe(
    'true',
  )
  expect(first.querySelector('[data-edge="language-context-answer"]')?.getAttribute('data-observed')).toBe(
    'false',
  )
  Object.defineProperty(first.querySelector('.jev-graph-viewport'), 'clientWidth', {
    value: 390,
    configurable: true,
  })
  a.update(events, 'session-a')
  first.querySelector<HTMLButtonElement>('[aria-label="适应画布"]')!.click()
  expect(parseFloat(first.querySelector<HTMLElement>('.jev-canvas-space')!.style.width)).toBeLessThanOrEqual(
    390,
  )
  expect(parseFloat(first.querySelector<HTMLElement>('.jev-circuit')!.style.transform.slice(6))).toBeLessThan(
    0.35,
  )
  expect(first.querySelector('[data-stage="helper"]')?.textContent).toContain('LLM 补参')
  expect(first.querySelector<HTMLElement>('[data-stage="helper"]')?.title).toContain('请求 #8')
  expect(first.querySelector('[data-edge="gate-helper"]')?.getAttribute('data-observed')).toBe('true')
  expect(first.querySelector('[data-edge="answer-ledger"]')?.getAttribute('data-observed')).toBe('true')
  expect(first.querySelector('.jev-graph-history')?.textContent).toContain('Recorded answer')
  const cursor = first.querySelector<HTMLInputElement>('input')!
  cursor.value = '3'
  cursor.dispatchEvent(new Event('input'))
  expect(second.querySelector('[data-stage="result"]')?.textContent).toContain('effect: unknown')
  const arbitrated = [
    ...events,
    event(11, { kind: 'model.requested', call: request('arbitration') }),
    event(12, { kind: 'model.settled', requested: 'record-11', settlement: { output: {} } }),
    event(13, {
      kind: 'decision.selected',
      requested: 'record-11',
      source: 'llm_arbitration',
      phase: 'ACT',
      operation: 'write',
    }),
    event(14, {
      kind: 'action.intended',
      decision: 'record-13',
      intent: {
        id: 'arbitrated-intent',
        tool: 'write',
        arguments: {},
        toolRevision: '1',
        environmentEpoch: 'env',
        effectClass: 'workspace_mutation',
      },
    }),
  ].map((entry) => ({ ...entry, seq: entry.seq * 10 }))
  arbitrated.push(
    event(150, { kind: 'run.stopped', reason: 'completed', detail: 'other turn', unresolved: [] }, 'turn-b'),
  )
  a.update(arbitrated, 'session-a')
  expect(first.querySelector('.jev-graph-evidence')?.textContent).toBe(
    '实线 · 已观测   虚线 · 待观测 · 已读会话几何预留',
  )
  const steps = first.querySelector<HTMLSelectElement>('[aria-label="Jev 轮次与步骤"]')!
  steps.selectedIndex = 0
  steps.dispatchEvent(new Event('change'))
  expect(first.querySelector('[data-stage="gate"]')?.textContent).toContain('ACT → write')
  expect(first.querySelector<HTMLElement>('[data-stage="gate"]')?.title).toContain(
    '原始 Jev：read → LLM 接管：write',
  )
  expect(first.querySelector('[data-stage="helper"]')?.textContent).toContain('LLM 接管')
  expect(first.querySelector<HTMLElement>('[data-stage="helper"]')?.title).toContain('接管当前步决策')
  expect(cursor.max).toBe('13')
  vi.useFakeTimers()
  const speed = first.querySelector<HTMLSelectElement>('[aria-label="回放速度"]')!
  speed.value = '8'
  speed.dispatchEvent(new Event('change'))
  first.querySelector<HTMLButtonElement>('[aria-label="从头回放"]')!.click()
  expect(first.querySelector('.jev-graph-replay [role="status"]')?.textContent).toBe('播放中 · #10')
  vi.advanceTimersByTime(125)
  expect(first.querySelector('.jev-graph-replay [role="status"]')?.textContent).toBe('播放中 · #20')
  first.querySelector<HTMLButtonElement>('[aria-label="暂停回放"]')!.click()
  vi.advanceTimersByTime(1000)
  expect(cursor.value).toBe('1')
  first.querySelector<HTMLButtonElement>('[aria-label="上一个事件"]')!.click()
  expect(first.querySelector('.jev-graph-replay [role="status"]')?.textContent).toBe('回放 · #10')
  first.querySelector<HTMLButtonElement>('[aria-label="播放回放"]')!.click()
  vi.advanceTimersByTime(2000)
  expect(first.querySelector('.jev-graph-replay [role="status"]')?.textContent).toBe('回放 · #140')
  expect(first.querySelector<HTMLButtonElement>('[aria-label="下一个事件"]')!.disabled).toBe(true)
  first.querySelector<HTMLButtonElement>('[aria-label="跟随最新"]')!.click()
  expect(first.querySelector('.jev-graph-replay [role="status"]')?.textContent).toBe('实时 · #150')
  steps.selectedIndex = 0
  steps.dispatchEvent(new Event('change'))
  first.querySelector<HTMLButtonElement>('[aria-label="从头回放"]')!.click()
  a.update(
    [event(1, { kind: 'run.stopped', reason: 'failed', detail: 'no request', unresolved: [] }, 'other-turn')],
    'other-session',
  )
  expect(first.textContent).not.toContain('Recorded answer')
  expect(vi.getTimerCount()).toBe(0)
  a.update(arbitrated.slice(0, -1), 'other-session')
  first.querySelector<HTMLButtonElement>('[aria-label="从头回放"]')!.click()
  expect(vi.getTimerCount()).toBe(1)
  a.dispose()
  b.dispose()
  expect(vi.getTimerCount()).toBe(0)
  expect(first.querySelector('.jev-decision-graph')).toBeNull()
})

it('keeps the horizontal main circuit fixed while all candidate heads fan out, expand and expose their evidence', () => {
  const host = document.createElement('section')
  const graph = createJevDecisionGraph(host, undefined, t)
  const events = fixture().slice(0, 5)
  const viewport = host.querySelector<HTMLElement>('.jev-graph-viewport')!
  Object.defineProperties(viewport, { clientWidth: { value: 900 }, clientHeight: { value: 620 } })
  const fitted = () => {
    const space = host.querySelector<HTMLElement>('.jev-canvas-space')!
    expect(parseFloat(space.style.width)).toBeLessThanOrEqual(868)
    expect(parseFloat(space.style.height)).toBeLessThanOrEqual(588)
  }
  const mainPositions = () =>
    Array.from(host.querySelectorAll<HTMLElement>('[data-stage]')).map((stage) => [
      stage.dataset.stage,
      stage.style.left,
      stage.style.top,
    ])
  try {
    graph.update(events, 'candidate-session')
    const positions = mainPositions()
    const initialHeight = parseFloat(host.querySelector<HTMLElement>('.jev-circuit')!.style.height)
    const pending = structuredClone(events)
    const input = (
      pending[1]!.data as { record: { call: { input: { questions: Record<string, unknown> } } } }
    ).record.call.input
    const keys = ['FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH', 'INSPECT']
    input.questions['purpose'] = {
      type: 'choice',
      criteria: Object.fromEntries(
        keys.map((key) => [key, { description: 'A complete purpose description. '.repeat(6) }]),
      ),
    }
    for (let index = 0; index < 4; index++)
      input.questions[`unknown-${index}`] = { type: 'choice', criteria: { yes: 'Yes', no: 'No' } }
    const settlement = (
      pending[2]!.data as { record: { settlement: { output: { answers: Record<string, unknown> } } } }
    ).record.settlement
    settlement.output.answers['purpose'] = choice('INSPECT', keys)
    graph.update(pending, 'candidate-session')
    expect(mainPositions()).toEqual(positions)
    expect(parseFloat(host.querySelector<HTMLElement>('.jev-circuit')!.style.height)).toBeGreaterThan(
      initialHeight,
    )
    expect(host.querySelectorAll('.jev-flow-fan')).toHaveLength(Object.keys(input.questions).length)
    expect(host.querySelectorAll('.jev-flow-fan')).toHaveLength(8)
    fitted()
    expect(host.querySelector('[data-compact-head="unknown-0"]')?.textContent).toContain('未采用 · 2 项候选')
    expect(host.querySelector('[data-compact-head="unknown-0"]')?.textContent).not.toContain('等待候选记录')
    expect(host.querySelectorAll('[data-compact-head="unknown-0"] .jev-flow-option')).toHaveLength(0)
    expect(
      host.querySelector('[data-compact-head="operation_VERIFY"] [data-supporting="true"]'),
    ).not.toBeNull()
    expect(host.querySelector('[data-compact-head="unknown-0"][data-status="unconsumed"]')).not.toBeNull()
    expect(
      host.querySelector('[data-compact-head="unknown-0"] .jev-compact-head-title')?.textContent,
    ).toContain('unknown-0')
    expect(host.querySelector('[data-stage="decision"]')?.getAttribute('data-shape')).toBe('core')
    expect(host.querySelectorAll('[data-stage="decision"] .jev-stage-port')).toHaveLength(2)
    expect(
      host.querySelector('[data-compact-head="binding_read"] [data-option-key="LLM_PARAMETERS"]')
        ?.textContent,
    ).toContain('LLM 补全参数')
    const purpose = host.querySelector('[data-compact-head="purpose"]')!
    expect(purpose.querySelectorAll('.jev-flow-option')).toHaveLength(2)
    expect(purpose.querySelector('[data-option-key="INSPECT"][data-selected="true"]')).not.toBeNull()
    expect(purpose.querySelector('[data-option-key="INSPECT"] strong')?.textContent).toBe('INSPECT')
    expect(
      host.querySelector('[data-edge="candidate-option-in-purpose-INSPECT"]')?.getAttribute('data-observed'),
    ).toBe('true')
    expect(
      host.querySelector('[data-edge="candidate-option-out-purpose-INSPECT"]')?.getAttribute('data-observed'),
    ).toBe('true')
    host.querySelector<HTMLButtonElement>('[aria-label="展开 purpose 候选"]')!.click()
    expect(host.querySelectorAll('[data-compact-head="purpose"] .jev-flow-option')).toHaveLength(keys.length)
    expect(mainPositions()).toEqual(positions)
    expect(parseFloat(host.querySelector<HTMLElement>('.jev-canvas-space')!.style.width)).toBeGreaterThan(900)
    host.querySelector<HTMLButtonElement>('[aria-label="收起 purpose 候选"]')!.click()
    fitted()
    host.querySelector<HTMLButtonElement>('[aria-label="展开 unknown-0 候选"]')!.click()
    expect(host.querySelectorAll('[data-compact-head="unknown-0"] .jev-flow-option')).toHaveLength(2)
    expect(
      host
        .querySelector('[data-compact-head="unknown-0"] [data-option-key="yes"]')
        ?.getAttribute('data-selected'),
    ).toBe('false')
    host.querySelector<HTMLButtonElement>('[data-compact-head="unknown-0"] .jev-flow-option')!.click()
    expect(host.querySelector<HTMLElement>('.jev-node-evidence')?.hidden).toBe(false)
    expect(host.querySelector('.jev-node-evidence')?.textContent).toContain('Yes')
    host.querySelector<HTMLButtonElement>('[aria-label="收起 unknown-0 候选"]')!.click()
    fitted()
    host.querySelector<HTMLButtonElement>('[aria-label="放大画布"]')!.click()
    const manual = host.querySelector<HTMLElement>('.jev-circuit')!.style.transform
    graph.update(pending, 'candidate-session')
    expect(host.querySelector<HTMLElement>('.jev-circuit')!.style.transform).toBe(manual)
    host.querySelector<HTMLButtonElement>('[aria-label="展开 purpose 候选"]')!.click()
    host.querySelector<HTMLButtonElement>('[aria-label="放大画布"]')!.click()
    const expandedManual = host.querySelector<HTMLElement>('.jev-circuit')!.style.transform
    host.querySelector<HTMLButtonElement>('[aria-label="收起 purpose 候选"]')!.click()
    expect(host.querySelector<HTMLElement>('.jev-circuit')!.style.transform).toBe(expandedManual)
    graph.update(pending, 'candidate-session')
    expect(host.querySelector<HTMLElement>('.jev-circuit')!.style.transform).toBe(expandedManual)
    graph.update(pending, 'another-fit-session')
    fitted()
  } finally {
    graph.dispose()
  }
})

it('animates only unresolved records in the latest complete live view and keeps replay, archive and stopped views still', () => {
  const host = document.createElement('section')
  const archive = document.createElement('section')
  const shared = document.createElement('section')
  let allowed = false
  const graph = createJevDecisionGraph(host, { liveMotion: () => allowed }, t)
  const historical = createJevDecisionGraph(archive, undefined, t)
  const sharedGraph = createJevDecisionGraph(shared, { liveMotion: () => true, sharedReplay: true }, t)
  const events = fixture()
  const viewport = host.querySelector<HTMLElement>('.jev-graph-viewport')!
  Object.defineProperties(viewport, { clientWidth: { value: 900 }, clientHeight: { value: 320 } })
  try {
    graph.update(events.slice(0, 2), 'active-session')
    expect(host.querySelector('[data-active="true"]')).toBeNull()
    allowed = true
    graph.update(events.slice(0, 2), 'active-session')
    expect(host.querySelector('[data-stage="decision"]')?.getAttribute('data-active')).toBe('true')
    expect(host.querySelector('[data-stage="decision"]')?.textContent).toContain('等待模型结算')
    expect(host.querySelector('.jev-flow-packet')).not.toBeNull()
    historical.update(events.slice(0, 2), 'historical')
    sharedGraph.update(events.slice(0, 2), 'shared')
    expect(archive.querySelector('.jev-flow-packet')).toBeNull()
    expect(shared.querySelector('.jev-flow-packet')).toBeNull()
    const cursor = host.querySelector<HTMLInputElement>('[aria-label="Jev 账本回放位置"]')!
    cursor.value = '1'
    cursor.dispatchEvent(new Event('input'))
    expect(host.querySelector('[data-active="true"]')).toBeNull()
    host.querySelector<HTMLButtonElement>('[aria-label="跟随最新"]')!.click()
    expect(host.querySelector('[data-stage="decision"]')?.getAttribute('data-active')).toBe('true')
    const laterStop = event(
      3,
      { kind: 'run.stopped', reason: 'completed', detail: 'later turn', unresolved: [] },
      'turn-b',
    )
    delete (laterStop.data as { record: { step?: string } }).record.step
    graph.update([...events.slice(0, 2), laterStop], 'active-session')
    expect(host.querySelector('[data-stage="decision"]')?.getAttribute('data-observed')).toBe('true')
    expect(host.querySelector('[data-active="true"]')).toBeNull()
    for (let index = 0; index < 5; index++)
      host.querySelector<HTMLButtonElement>('[aria-label="放大画布"]')!.click()
    graph.update(
      [
        ...events.slice(0, 5),
        event(6, {
          kind: 'model.requested',
          call: {
            ...request('parameters', { request: { messages: [], tools: [] } }),
            codec: 'agnes-language-v2',
          },
        }),
      ],
      'active-session',
    )
    expect(host.querySelector('[data-stage="language-context"]')?.getAttribute('data-active')).toBe('true')
    expect(viewport.scrollLeft).toBeGreaterThan(0)
    viewport.dispatchEvent(new WheelEvent('wheel'))
    viewport.scrollLeft = 77
    graph.update(events.slice(0, 7), 'active-session')
    expect(viewport.scrollLeft).toBe(77)
    host.querySelector<HTMLButtonElement>('[aria-label="跟随最新"]')!.click()
    expect(viewport.scrollLeft).toBeGreaterThan(77)
    expect(host.querySelector('[data-stage="host"]')?.getAttribute('data-active')).toBe('true')
    expect(host.querySelector('[data-stage="host"]')?.textContent).toContain('等待工具结算')
    expect(host.querySelector('[data-stage="decision"]')?.getAttribute('data-active')).toBe('false')
    graph.update(events.slice(0, 8), 'active-session')
    expect(host.querySelector('[data-active="true"]')).toBeNull()
    expect(host.querySelector('[data-stage="result"]')?.getAttribute('data-tone')).toBe('critical')
    graph.update(events, 'active-session')
    expect(host.querySelector('.jev-flow-packet')).toBeNull()
    graph.update(
      [
        ...events.slice(0, 2),
        event(3, { kind: 'run.stopped', reason: 'cancelled', detail: 'cancelled', unresolved: [] }),
      ],
      'active-session',
    )
    expect(host.querySelector('[data-stage="decision"]')?.getAttribute('data-observed')).toBe('true')
    expect(host.querySelector('[data-active="true"]')).toBeNull()
  } finally {
    graph.dispose()
    historical.dispose()
    sharedGraph.dispose()
  }
})

it('ignores a late old-session read and reports malformed history instead of inventing a path', async () => {
  let finish!: (value: unknown) => void
  const call = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    .mockResolvedValue({
      events: [event(1, { kind: 'model.settled', requested: 'absent', settlement: { output: {} } })],
      lastSeq: 1,
      nextAfterSeq: null,
    })
  const host = document.createElement('section')
  const trace = createRuntimeRecordTrace(host, { call } as unknown as Pick<Client, 'call'>, undefined, {
    t,
  })
  trace.select('old')
  trace.select('new')
  await vi.waitFor(() =>
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('no observed request'),
  )
  finish({ events: fixture(), lastSeq: 9, nextAfterSeq: null })
  await Promise.resolve()
  await Promise.resolve()
  expect(host.querySelectorAll('.runtime-record-rows > li')).toHaveLength(1)
  expect(host.querySelector('[data-stage="result"]')).toBeNull()
  trace.dispose()
  const callsBefore = call.mock.calls.length
  const markup = host.innerHTML
  trace.select('ignored-after-dispose')
  trace.head(999)
  trace.observe(fixture()[0]!)
  await Promise.resolve()
  expect(call.mock.calls.length).toBe(callsBefore)
  expect(host.innerHTML).toBe(markup)
})

it('marks a bounded history batch partial and continues only on an explicit read', async () => {
  let lastSeq = 5
  const call = vi.fn(async (_method: string, params: { afterSeq: number }) => {
    const seq = params.afterSeq + 1
    return {
      events: [
        event(
          seq,
          seq === 1
            ? { kind: 'model.requested', call: request('decision') }
            : { kind: 'resource.observed', resource: { kind: 'test-evidence' } },
        ),
      ],
      lastSeq,
      nextAfterSeq: seq < lastSeq ? seq : null,
    }
  })
  const host = document.createElement('section')
  const trace = createRuntimeRecordTrace(host, { call } as unknown as Pick<Client, 'call'>, undefined, {
    t,
  })
  trace.select('bounded')
  await vi.waitFor(() =>
    expect(host.querySelector('.runtime-trace-coverage')?.textContent).toContain('部分历史'),
  )
  expect(call).toHaveBeenCalledTimes(4)
  expect(host.querySelector('[data-stage="decision"][data-active="true"]')).toBeNull()
  const more = [...host.querySelectorAll('button')].find((button) => button.textContent === '继续读取历史')!
  expect(more.hidden).toBe(false)
  more.click()
  await vi.waitFor(() =>
    expect(host.querySelector('.runtime-trace-coverage')?.textContent).toContain('完整账本前缀 #0–5'),
  )
  expect(call).toHaveBeenCalledTimes(5)
  expect(host.querySelector('[data-stage="decision"][data-active="true"]')).not.toBeNull()
  // An increment arriving while an already-complete prefix is catching up must
  // schedule the next bounded read, without waiting for another head notification.
  let finish!: (value: Awaited<ReturnType<typeof call>>) => void
  call.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  trace.head(6)
  trace.head(7)
  lastSeq = 7
  finish({
    events: [event(6, { kind: 'resource.observed', resource: { kind: 'test-evidence' } })],
    lastSeq: 6,
    nextAfterSeq: null,
  })
  await vi.waitFor(() =>
    expect(host.querySelector('.runtime-trace-coverage')?.textContent).toContain('完整账本前缀 #0–7'),
  )
  expect(call).toHaveBeenCalledTimes(7)
  call.mockResolvedValueOnce({ events: [], lastSeq: 7, nextAfterSeq: null })
  trace.head(8)
  await vi.waitFor(() =>
    expect(host.querySelector('.runtime-trace-coverage')?.textContent).toContain('部分历史'),
  )
  expect(call).toHaveBeenCalledTimes(8)
  trace.dispose()
})
