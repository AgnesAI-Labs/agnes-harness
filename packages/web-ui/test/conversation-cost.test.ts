/** @vitest-environment happy-dom */
import type { UINode } from '@agnes/protocol'
import {
  ConversationMessages,
  createConversationProjectionStore,
  useConversationProjection,
} from '@agnes/web-ui/conversation'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { costDetails } from '../src/conversation/cost-format.js'
import { fallbackT } from '../src/locales/index.js'
import { zhT } from './locale.js'

type CostNode = Extract<UINode, { kind: 'cost' }>
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})
const call: CostNode = {
  kind: 'cost',
  id: 'call',
  seq: 2,
  source: 'estimated',
  purpose: 'inference',
  model: 'model',
  tokens: { input: 1234, output: 50, cacheRead: 600, cacheWrite: 0, reasoning: 20 },
  credits: 0.00020600000000000002,
  billing: { usdMicros: 125, source: 'estimated', subscription: false },
  timing: { ttftMs: 0, durationMs: 2400 },
}
function Harness({ store }: { store: ReturnType<typeof createConversationProjectionStore> }) {
  const projection = useConversationProjection(store)
  return createElement(ConversationMessages, { t: zhT, nodes: projection.nodes })
}
async function mount(node: CostNode) {
  const store = createConversationProjectionStore({ sessionId: 'session', nodes: [node] })
  await act(async () => root.render(createElement(Harness, { store })))
  return async (next: CostNode) => {
    await act(async () => store.update({ sessionId: 'session', nodes: [next] }))
  }
}
function rows() {
  const list = host.querySelector('dl')
  return Array.from(list?.querySelectorAll('dt') ?? []).map((term) => [
    term.textContent,
    term.nextElementSibling?.textContent,
  ])
}
const unknownTiming = [
  ['调用总耗时（非整轮）', '未提供'],
  ['调用内准备', '未提供'],
  ['其中：轨迹采集（与其他阶段重叠）', '未提供'],
  ['首次发送时点（距调用开始）', '未提供'],
  ['首次可见输出（距调用开始）', '未提供'],
  ['输出阶段', '未提供'],
  ['收尾', '未提供'],
]
it('renders the complete per-call contract with compact summary and exact detail values', async () => {
  await mount(call)
  expect(host.querySelector('.agh-disclosure-summary')?.textContent).toBe(
    '输入 1.2K · 输出 50 · $0.000125（估算）',
  )
  expect(rows()).toEqual([
    ['记录范围', '模型调用'],
    ['模型', 'model'],
    ['输入 Token（不含缓存）', '1,234'],
    ['输出 Token（含推理）', '50'],
    ['缓存读取 Token', '600'],
    ['缓存写入 Token', '0'],
    ['推理 Token（输出的子集）', '20'],
    ['美元费用', '$0.000125 · 估算'],
    ['额度', '0.000206 credits · 估算'],
    ...unknownTiming,
    ['初始采集后的首次输出等待', '0 ms'],
    ['请求采样耗时（不含收尾）', '2.40 秒'],
  ])
})
it('keeps expansion, summary focus and nodes through gateway updates, replay and optional-field removal', async () => {
  const update = await mount(call)
  const details = host.querySelector<HTMLElement>('.agh-disclosure')
  const summary = host.querySelector<HTMLElement>('.agh-disclosure-summary')
  const list = host.querySelector('dl')
  if (!details || !summary || !list) throw new Error('missing cost disclosure')
  summary.click()
  summary.focus()
  const gateway: CostNode = {
    ...call,
    source: 'gateway',
    timing: {
      providerCallMs: 116,
      prepareMs: 4,
      captureMs: 30,
      dispatchMs: 17,
      firstOutputMs: 47,
      outputMs: 45,
      finalizeMs: 24,
    },
    credits: 0,
    interrupted: true,
    model: '<img src=x onerror=alert(1)> **literal** [link](javascript:alert(1))',
    billing: { usdMicros: 0, source: 'gateway', subscription: true },
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
  for (const next of [gateway, { ...gateway }]) {
    await update(next)
    expect(host.querySelector('.agh-disclosure')).toBe(details)
    expect(host.querySelector('.agh-disclosure-summary')).toBe(summary)
    expect(host.querySelector('dl')).toBe(list)
    expect(details.dataset.open).toBe('true')
    expect(document.activeElement).toBe(summary)
    expect(summary.textContent).toBe('输入 0 · 输出 0 · $0.00（网关记录） · 已中断')
    expect(rows()).toContainEqual(['模型', gateway.model])
    expect(rows()).toContainEqual(['额度', '0 credits · 网关记录'])
    expect(rows()).toContainEqual(['调用总耗时（非整轮）', '116 ms'])
    expect(rows()).toContainEqual(['其中：轨迹采集（与其他阶段重叠）', '30 ms'])
    expect(rows()).toContainEqual(['首次发送时点（距调用开始）', '17 ms'])
    expect(rows()).toContainEqual(['首次可见输出（距调用开始）', '47 ms'])
    expect(rows()).toContainEqual(['收尾', '24 ms'])
    expect(rows()).toContainEqual(['推理 Token（输出的子集）', '未提供'])
    expect(rows()).toContainEqual(['状态', '已中断；用量可能不完整或包含估算'])
    expect(host.querySelector('img, a, strong, script')).toBeNull()
    expect(host.querySelectorAll('.agh-disclosure.call-usage')).toHaveLength(1)
  }
  await update({ kind: 'cost', id: 'call', seq: 2, source: 'estimated' })
  expect(summary.textContent).toBe('费用未提供')
  expect(rows()).toEqual([
    ['记录范围', '单次费用记录'],
    ['Token 明细', '未提供'],
    ['额度', '未提供'],
    ...unknownTiming,
  ])
  expect(details.dataset.open).toBe('true')
  expect(document.activeElement).toBe(summary)
})
it('uses credit-only zero and interrupted values without inventing dollar or token detail', async () => {
  const update = await mount({
    kind: 'cost',
    id: 'call',
    seq: 2,
    source: 'estimated',
    credits: 0,
    interrupted: true,
  })
  expect(host.querySelector('.agh-disclosure-summary')?.textContent).toBe('0 credits（估算） · 已中断')
  expect(rows()).toContainEqual(['额度', '0 credits · 估算'])
  expect(rows()).toContainEqual(['Token 明细', '未提供'])
  expect(host.textContent).not.toContain('$')
  await update({ kind: 'cost', id: 'call', seq: 2, source: 'estimated', model: call.model ?? '' })
  expect(host.querySelector('.agh-disclosure-summary')?.textContent).toBe('费用未提供')
  expect(rows()).not.toContainEqual(['美元费用', expect.anything()])
})

it('names a side model call in the record range, in both languages', () => {
  // A side-call row is never a transcript row; the turn usage details show it with this range.
  expect(costDetails({ ...call, purpose: 'side-call' }, zhT)[0]).toEqual(['记录范围', '旁路模型调用'])
  expect(costDetails({ ...call, purpose: 'side-call' }, fallbackT)[0]).toEqual([
    'Record range',
    'Side model call',
  ])
})

it('renders unknown purpose identifiers as plain generic scope without React object children', async () => {
  const update = await mount({ ...call, purpose: '__proto__' })
  for (const purpose of ['__proto__', 'constructor', 'toString', 'unknown']) {
    await update({ ...call, purpose })
    expect(rows()[0]).toEqual(['记录范围', '单次费用记录'])
  }
})
