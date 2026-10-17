/** @vitest-environment happy-dom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })

import type { UiActionParams, UiActionReceipt, UiSurfaceRecord } from '@agnes/protocol/gen/intelligent-ui'
import { createDocumentLocaleSource } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { IntelligentUiClient } from '../../../web-conversation/src/intelligent-ui/client.js'
import type { UiPlacementBinding } from '../../../web-conversation/src/intelligent-ui/placements.js'
import { QuestionDock, questionRecovery } from '../../../web-conversation/src/intelligent-ui/question-dock.js'
import { attachIntelligentBinding } from '../../../web-conversation/src/intelligent-ui/turn-views.js'
import { uiPage, uiReceipt } from './fixture.js'

/** One single-choice question, as ask_user_question publishes it. */
const question = (revision = 1): UiSurfaceRecord => ({
  owner: 'agnes/intelligent-ui',
  lane: 'main',
  taskId: 'question',
  createdSeq: 2,
  updatedSeq: 2 + revision,
  status: 'open',
  surface: {
    id: 'card-q',
    revision,
    title: 'Questions',
    titleKey: 'ui.question.title',
    placement: { inline: true, workbench: false, preferred: 'inline' },
    components: [
      {
        id: 'answers',
        kind: 'form',
        dataKey: 'draft',
        actionIds: ['submit'],
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['format'],
          properties: {
            format: {
              title: 'Which format?',
              type: 'string',
              minLength: 1,
              enum: ['HTML', 'PPTX'],
              'x-ui-choices': ['HTML', 'PPTX'],
            },
          },
        },
      },
    ],
    data: { draft: {}, question: { kind: 'ask_user_question', deadline: 0 } },
    actions: [
      {
        id: 'submit',
        label: 'Submit',
        tool: 'ui_submit',
        argsTemplate: { surfaceId: { literal: 'card-q' }, answers: { from: 'input', key: 'answers' } },
        paramsSchema: {
          type: 'object',
          required: ['surfaceId', 'answers'],
          additionalProperties: false,
          properties: { surfaceId: { const: 'card-q' }, answers: { type: 'object' } },
        },
      },
    ],
  },
})

/** A receipt for the command just sent; seq above the snapshot watermark so a re-read keeps it. */
const receiptFor = (
  params: UiActionParams,
  status: UiActionReceipt['status'],
  extra: Partial<UiActionReceipt> = {},
): UiActionReceipt =>
  uiReceipt(status, {
    surfaceId: params.surfaceId,
    actionId: params.actionId,
    commandId: params.commandId,
    seq: 30,
    ...(status === 'succeeded' ? { resultSeq: 29 } : {}),
    ...extra,
  })

async function mount(
  action: (params: UiActionParams) => Promise<UiActionReceipt>,
  records: UiSurfaceRecord[] = [question()],
) {
  const sent: UiActionParams[] = []
  const reads = vi.fn()
  let next = 0
  const client = new IntelligentUiClient(
    'session-finance',
    {
      read: async (params) => {
        reads(params)
        return { ...uiPage(records[0], [], 20), surfaces: records.filter((r) => r.status === 'open') }
      },
      refresh: async () => records[0]!,
      action: async (params) => {
        sent.push(params)
        return action(params)
      },
      listen: () => () => {},
      attach: async () => {},
    },
    undefined,
    () => `command-${++next}`,
  )
  await client.start()
  const locale = createDocumentLocaleSource({})
  const binding: UiPlacementBinding = {
    subscribe: (listener) => client.subscribe(listener),
    getSnapshot: () => client,
    getVersion: () => client.getVersion(),
    locale: locale.source,
    target: () => undefined,
    expand: vi.fn(),
    approval: vi.fn(),
  }
  const detach = attachIntelligentBinding(binding)
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  await act(async () => root.render(createElement(QuestionDock)))
  const click = async (testId: string) =>
    act(async () => host.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.click())
  const answer = async () => {
    await click('question-option-format-0')
    await click('question-submit')
  }
  const text = (testId: string) => host.querySelector(`[data-testid="${testId}"]`)?.textContent
  return {
    client,
    host,
    sent,
    reads,
    records,
    click,
    answer,
    text,
    cleanup: async () => {
      await act(async () => root.unmount())
      detach()
      client.dispose()
      locale.dispose()
      host.remove()
    },
  }
}

describe('question card recovery', () => {
  it('sends an unconfirmed submission again with its own commandId, never a second decision', async () => {
    let calls = 0
    const view = await mount(async (params) => {
      calls += 1
      if (calls === 1) throw new Error('connection reset')
      return receiptFor(params, 'received')
    })
    try {
      await view.answer()
      // The first send lost its reply: the command stays pending and the card says so.
      expect(view.text('question-recovery')).toBe('Your answers were not confirmed as delivered.')
      expect(view.text('question-recover')).toBe('Send again')
      expect((view.host.querySelector('[data-testid="question-submit"]') as HTMLButtonElement).disabled).toBe(
        true,
      )
      await view.click('question-recover')
      expect(view.sent.map((params) => params.commandId)).toEqual(['command-1', 'command-1'])
      expect(view.sent[1]).toEqual(view.sent[0])
      expect(view.host.querySelector('[data-testid="question-recovery"]')).toBeNull()
    } finally {
      await view.cleanup()
    }
  })

  it('reads a stale question again before it can be answered, and sends nothing on its own', async () => {
    const view = await mount(async (params) =>
      receiptFor(params, 'rejected', {
        refusal: { reason: 'stale', code: 'UI_STALE', message: 'Revision changed' },
      }),
    )
    try {
      await view.answer()
      await act(async () => {})
      expect(view.text('question-recovery')).toBe(
        'This question changed or closed. Reload it before answering.',
      )
      expect(view.text('question-recover')).toBe('Reload question')
      const readsBefore = view.reads.mock.calls.length
      await view.click('question-recover')
      await act(async () => {})
      expect(view.reads.mock.calls.length).toBeGreaterThan(readsBefore)
      // Reviewed: the card is answerable again; only the person's next submit sends a new command.
      expect(view.host.querySelector('[data-testid="question-recovery"]')).toBeNull()
      expect(view.sent).toHaveLength(1)
      expect(view.client.locked('card-q')).toBe(false)
    } finally {
      await view.cleanup()
    }
  })

  it('retries only a failure the backend marked safe, as a new command that names the old one', async () => {
    let calls = 0
    const view = await mount(async (params) => {
      calls += 1
      return calls === 1 ? receiptFor(params, 'failed') : receiptFor(params, 'received')
    })
    try {
      await view.answer()
      expect(view.text('question-recovery')).toBe('Your answers were not submitted.')
      await view.click('question-recover')
      expect(view.sent.map((params) => [params.commandId, params.retryOf])).toEqual([
        ['command-1', undefined],
        ['command-2', 'command-1'],
      ])
      expect(view.sent[1]?.input).toEqual(view.sent[0]?.input)
    } finally {
      await view.cleanup()
    }
  })

  it('keeps an unknown outcome locked, with no way to send again', async () => {
    const view = await mount(async (params) =>
      receiptFor(params, 'failed', {
        failure: { code: 'UNKNOWN', message: 'Lost after dispatch', retryable: false, outcomeUnknown: true },
      }),
    )
    try {
      await view.answer()
      expect(questionRecovery(view.client, 'card-q')).toEqual({ kind: 'unknown' })
      expect(view.text('question-recovery')).toBe(
        'It is unknown whether your answers arrived; the card stays locked until that is resolved.',
      )
      expect(view.host.querySelector('[data-testid="question-recover"]')).toBeNull()
      expect(view.client.locked('card-q')).toBe(true)
      expect(view.sent).toHaveLength(1)
    } finally {
      await view.cleanup()
    }
  })

  it('asks for a reload when the question changes under an answer in progress', async () => {
    const view = await mount(async (params) => receiptFor(params, 'received'))
    try {
      await view.click('question-option-format-1')
      // The plugin publishes revision 2 while the person is answering.
      view.records.splice(0, 1, question(2))
      await act(async () => view.client.refresh())
      expect(view.text('question-recovery')).toBe(
        'This question changed or closed. Reload it before answering.',
      )
      expect((view.host.querySelector('[data-testid="question-submit"]') as HTMLButtonElement).disabled).toBe(
        true,
      )
      await view.click('question-recover')
      await act(async () => {})
      // The old draft does not carry over to a changed question; nothing was sent.
      expect(view.host.querySelector('[data-testid="question-recovery"]')).toBeNull()
      expect(
        (view.host.querySelector('[data-testid="question-option-format-1"]') as HTMLInputElement).checked,
      ).toBe(false)
      expect(view.sent).toHaveLength(0)
    } finally {
      await view.cleanup()
    }
  })
})
