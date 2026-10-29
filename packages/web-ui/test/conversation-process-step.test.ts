/** @vitest-environment happy-dom */

import type { UINode, UITurn } from '@agnes/protocol'
import { ConversationMessages, type ConversationMessagesProps } from '@agnes/web-ui/conversation'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { processStepLabel, processStepSummary } from '../src/conversation/messages/process-step.js'
import { systemInputText } from '../src/conversation/user-presentation.js'
import { webUiLocaleCatalog } from '../src/locales/index.js'

const t: ConversationMessagesProps['t'] = (key, vars) =>
  Object.entries(vars ?? {}).reduce(
    (value, [name, replacement]) => value.replaceAll(`{${name}}`, String(replacement)),
    webUiLocaleCatalog['zh-CN']?.[key] ?? key,
  )
const record = (name: string, data: object) => `${name}:\n${JSON.stringify(data, null, 2)}`
const say = (id: string, seq: number, text: string): UINode => ({ kind: 'assistant', id, seq, text })
const steps: UINode[] = [
  { kind: 'user', id: 'user', seq: 1, content: [{ type: 'text', text: '起草续约跟进' }] },
  say('plan', 2, record('approve-plan', { plan: { required: false } })),
  say(
    'account',
    3,
    record('account', { account: { id: 'A-100', name: 'Synthetic Northwind', openTickets: 3 } }),
  ),
  say(
    'playbook',
    4,
    record('playbook', { note: 'CRM note\n\nAccount: Synthetic Northwind\n\n- confirm tickets' }),
  ),
]
const turn: UITurn = {
  id: 'turn:1',
  turn: 1,
  startSeq: 1,
  endSeq: 5,
  startedAt: '2026-10-01T00:00:00.000Z',
  endedAt: '2026-10-01T00:00:02.000Z',
  status: 'completed',
  nodeIds: steps.map((node) => node.id),
  finalAssistantId: 'playbook',
  inherited: false,
  forkable: true,
  usage: {
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    reasoningComplete: true,
    billingComplete: true,
    calls: [],
  },
}
// The host decides what a step record is; the test host reads the same `<name>:\n{json}` shape.
const processStep: ConversationMessagesProps['processStep'] = (node) => {
  const match = /^([a-z-]+):\n(\{[\s\S]*\})$/.exec(node.text)
  return match?.[1] && match[2] ? { name: match[1], data: JSON.parse(match[2]) } : undefined
}

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

it('names steps in plain words and sums up a record in one line', () => {
  expect(processStepLabel('approve-plan', t)).toBe('计划审批')
  expect(processStepLabel('collect-evidence', t)).toBe('Collect evidence')
  expect(processStepSummary({ account: { id: 'A-100', name: 'Synthetic Northwind' } }, t)).toBe(
    'Synthetic Northwind · A-100',
  )
  expect(processStepSummary({ note: '\nCRM note\n\nmore' }, t)).toBe('CRM note')
  expect(processStepSummary({ rows: [1, 2, 3] }, t)).toBe('3 项')
})

it('shows workflow step records as rows of the activity, never as the answer', async () => {
  await act(async () =>
    root.render(createElement(ConversationMessages, { t, nodes: steps, turns: [turn], processStep })),
  )
  const prose = [...host.querySelectorAll('.turn-final, .turn-narration')]
    .map((node) => node.textContent)
    .join('')
  expect(prose).not.toContain('{')
  expect(host.querySelector('.timeline-node.assistant')).toBeNull()
  // A workflow with only step records keeps the process open even if the last record is
  // referenced as final: the activity is the only readable result. Open its group of three steps.
  expect(host.querySelector('[data-testid="turn-process-toggle"]')?.getAttribute('aria-expanded')).toBe(
    'true',
  )
  const group = host.querySelector<HTMLElement>('[data-testid="turn-activity-toggle"]')
  expect(group?.textContent).toContain('完成了 3 个步骤')
  await act(async () => group?.click())
  const rows = [...host.querySelectorAll<HTMLElement>('[data-testid="process-step"]')]
  expect(rows.map((row) => row.querySelector('.activity-verb')?.textContent)).toEqual([
    '计划审批',
    'Account',
    'Playbook',
  ])
  expect(rows[1]?.querySelector('.activity-target')?.textContent).toBe('Synthetic Northwind · A-100')
  // The record opens in place: structured values as source, a note as prose.
  await act(async () => rows[2]?.click())
  const detail = rows[2]?.closest('.process-step')?.querySelector('[data-testid="process-step-detail"]')
  expect(detail?.hasAttribute('hidden')).toBe(false)
  expect(detail?.querySelector('.process-step-prose')?.textContent).toContain('CRM note')
  expect(detail?.querySelector('.process-step-code')).toBeNull()
  expect(detail?.querySelector('button.agh-copy')).not.toBeNull()
  await act(async () => rows[1]?.click())
  expect(rows[1]?.closest('.process-step')?.querySelector('.process-step-code')?.textContent).toContain(
    '"A-100"',
  )
})

it('says what a queued deferred invocation means instead of the loop instruction', () => {
  expect(
    systemInputText(
      {
        source: 'agnes/deferred-invocations',
        type: 'invocation-queued',
        data: { invocationId: 'x' },
        summary: 'A deferred tool invocation is queued. Execute only its durable backend binding.',
      },
      t,
    ),
  ).toBe('正在执行排队的业务操作')
})
