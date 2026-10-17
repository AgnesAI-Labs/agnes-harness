/** @vitest-environment happy-dom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })

import type { UINode } from '@agnes/protocol'
import type { UiActionParams, UiSurfaceRecord } from '@agnes/protocol/gen/intelligent-ui'
import { createDocumentLocaleSource } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { IntelligentUiClient } from '../../../web-conversation/src/intelligent-ui/client.js'
import {
  IntelligentInline,
  IntelligentPanel,
  newSurfacePlacements,
  type UiPlacementBinding,
} from '../../../web-conversation/src/intelligent-ui/placements.js'
import {
  AnsweredQuestions,
  QuestionAnswersNode,
  QuestionDock,
  questionSubmission,
} from '../../../web-conversation/src/intelligent-ui/question-dock.js'
import { attachIntelligentBinding } from '../../../web-conversation/src/intelligent-ui/turn-views.js'
import { financeRecord, uiPage, uiReceipt } from './fixture.js'

/** The record ask_user_question leaves behind (packages/base/extensions/interaction/src/question.ts). */
const questionRecord = (status: UiSurfaceRecord['status'] = 'open'): UiSurfaceRecord => ({
  owner: 'agnes/intelligent-ui',
  lane: 'main',
  taskId: 'question',
  createdSeq: 2,
  updatedSeq: 2,
  status,
  surface: {
    id: 'card-q',
    revision: 1,
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
          required: ['format', 'topics'],
          properties: {
            format: {
              title: 'Which format do you want?',
              type: 'string',
              minLength: 1,
              enum: ['HTML slides', 'PPTX'],
              'x-ui-choices': ['HTML slides', 'PPTX'],
            },
            topics: {
              title: 'What should it cover?',
              type: 'array',
              minItems: 1,
              items: { type: 'string', minLength: 1, enum: ['Food', 'Transport'] },
              'x-ui-choices': ['Food', 'Transport'],
            },
          },
        },
      },
    ],
    data: { draft: {}, question: { kind: 'ask_user_question', deadline: 0, labels: { format: 'Format' } } },
    actions: [
      {
        id: 'submit',
        label: 'Submit',
        tool: 'ui_submit',
        style: 'primary',
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

async function mount(records: UiSurfaceRecord[], extra?: ReturnType<typeof createElement>) {
  const action = vi.fn(async (params: UiActionParams) =>
    uiReceipt('received', {
      surfaceId: params.surfaceId,
      actionId: params.actionId,
      commandId: params.commandId,
    }),
  )
  const client = new IntelligentUiClient('session-finance', {
    // Like the service: the session page lists open surfaces; a surface id reads that one, open or closed.
    read: async (params) => ({
      ...uiPage(records[0], [], 20),
      surfaces: records.filter((record) =>
        params.surfaceId ? record.surface.id === params.surfaceId : record.status === 'open',
      ),
    }),
    refresh: async () => records[0]!,
    action,
    listen: () => () => {},
    attach: async () => {},
  })
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
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () =>
    root.render(
      createElement(
        'div',
        {},
        createElement('div', { 'data-testid': 'inline' }, createElement(IntelligentInline, { binding })),
        createElement(IntelligentPanel, {
          binding,
          context: { t: (key) => key, data: { session: { id: 'session-finance' } } },
        }),
        createElement('div', { 'data-testid': 'composer' }, createElement(QuestionDock)),
        extra,
      ),
    ),
  )
  return {
    host,
    action,
    client,
    cleanup: async () => {
      await act(async () => root.unmount())
      detach()
      client.dispose()
      locale.dispose()
      host.remove()
    },
  }
}

const submitted = (surfaceId = 'card-q'): UINode => ({
  kind: 'user',
  id: 'answer',
  seq: 9,
  origin: 'system',
  content: [{ type: 'text', text: 'UI submit succeeded: Submit' }],
  system: {
    source: 'agnes/intelligent-ui',
    type: 'action-result',
    summary: 'UI submit succeeded: Submit',
    data: {
      status: 'succeeded',
      surfaceId,
      submitted: { surfaceId, answers: { format: 'HTML slides', topics: ['Food', 'Transport'] } },
    },
    presentation: {
      kind: 'ui-action',
      operation: 'submit',
      status: 'succeeded',
      label: 'Submit',
      fields: ['format', 'topics'],
    },
  },
})

describe('question dock', () => {
  it('docks an open question above the composer, never in the conversation list or the workbench', async () => {
    const view = await mount([questionRecord(), financeRecord()])
    const card = view.host.querySelector('[data-testid="composer"] [data-testid="question-card"]')
    expect(card?.getAttribute('data-surface-id')).toBe('card-q')
    expect(view.host.querySelector('[data-testid="inline"] [data-testid="ui-surface-card-q"]')).toBeNull()
    expect(
      view.host.querySelector('[data-testid="intelligent-ui-panel"] [data-testid="ui-surface-card-q"]'),
    ).toBeNull()
    // The other view still reaches the workbench panel.
    expect(
      view.host.querySelector(
        '[data-testid="intelligent-ui-panel"] [data-testid="ui-surface-finance-review"]',
      ),
    ).not.toBeNull()
    expect(newSurfacePlacements(new Set(), [questionRecord()])).toEqual({
      keys: ['card-q'],
      showConversation: true,
      showWorkbench: false,
    })
    await view.cleanup()
  })

  it('submits every answer through the existing surface action', async () => {
    const view = await mount([questionRecord()])
    const click = async (testId: string) =>
      act(async () => view.host.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.click())
    await click('question-option-format-0')
    await click('question-next')
    await click('question-option-topics-1')
    await click('question-submit')
    expect(view.action).toHaveBeenCalledTimes(1)
    expect(view.action.mock.calls[0]![0]).toMatchObject({
      surfaceId: 'card-q',
      actionId: 'submit',
      revision: 1,
      input: { answers: { format: 'HTML slides', topics: ['Transport'] } },
    })
    await view.cleanup()
  })

  it('shows no card once the question is closed', async () => {
    const view = await mount([questionRecord('closed')])
    expect(view.host.querySelector('[data-testid="question-card"]')).toBeNull()
    expect(view.host.querySelector('[data-testid="ui-surface-card-q"]')).toBeNull()
    await view.cleanup()
  })
})

describe('answered receipt', () => {
  it('reads the delivered answer and ignores other inputs', () => {
    expect(questionSubmission(submitted())).toEqual({
      surfaceId: 'card-q',
      answers: { format: 'HTML slides', topics: ['Food', 'Transport'] },
    })
    expect(questionSubmission({ kind: 'user', id: 'u', seq: 1, content: [] })).toBeUndefined()
  })

  it('renders «你的回答» from the persisted surface after a fresh mount', async () => {
    const node = submitted()
    const view = await mount(
      [questionRecord('closed')],
      createElement(QuestionAnswersNode, { submission: questionSubmission(node)!, native: 'native' }),
    )
    await act(async () => {})
    const receipt = view.host.querySelector('[data-testid="question-answers"]')
    expect(receipt?.querySelector('[data-testid="question-answer-format"] dt')?.textContent).toBe('Format')
    expect(receipt?.querySelector('[data-testid="question-answer-topics"] dt')?.textContent).toBe(
      'What should it cover',
    )
    expect(receipt?.querySelectorAll('.agnes-question-pill')).toHaveLength(2)
    expect(view.host.textContent).not.toContain('native')
    await view.cleanup()
  })

  it('never shows a question id: without the question the answers stand alone', async () => {
    const gone = await mount(
      [financeRecord()],
      createElement(QuestionAnswersNode, { submission: questionSubmission(submitted())!, native: 'native' }),
    )
    await act(async () => {})
    const receipt = gone.host.querySelector('[data-testid="question-answers"]')
    expect(receipt?.querySelector('dt')).toBeNull()
    expect(receipt?.textContent).not.toMatch(/format|topics/)
    expect(receipt?.querySelector('[data-testid="question-answer-format"] dd')?.textContent).toBe(
      'HTML slides',
    )
    await gone.cleanup()
    const other = await mount(
      [financeRecord()],
      createElement(QuestionAnswersNode, {
        submission: questionSubmission(submitted('finance-review'))!,
        native: 'native',
      }),
    )
    expect(other.host.querySelector('[data-testid="question-answers"]')).toBeNull()
    expect(other.host.textContent).toContain('native')
    await other.cleanup()
  })

  it('keeps the labels when the answer arrives while the question is still open', async () => {
    const records = [questionRecord()]
    const view = await mount(
      records,
      createElement(QuestionAnswersNode, { submission: questionSubmission(submitted())!, native: 'native' }),
    )
    expect(view.host.querySelector('[data-testid="question-answer-format"] dt')?.textContent).toBe('Format')
    // The submission closes the form; the session page stops listing it and nothing reads it by id.
    records.splice(0, 1, { ...questionRecord('closed') })
    await act(async () => view.client.refresh())
    expect(view.host.querySelector('[data-testid="question-answer-format"] dt')?.textContent).toBe('Format')
    expect(view.host.querySelector('[data-testid="question-answer-topics"] dt')?.textContent).toBe(
      'What should it cover',
    )
    await view.cleanup()
  })

  it('labels the «answered» badge with the questions after a reload', async () => {
    const view = await mount(
      [questionRecord('closed')],
      createElement(AnsweredQuestions, { answered: [{ submission: questionSubmission(submitted())! }] }),
    )
    await act(async () => {})
    const badge = view.host.querySelector('[data-testid="question-answered"]')
    expect(badge?.querySelector('[data-testid="question-answer-format"] dt')?.textContent).toBe('Format')
    expect(badge?.querySelector('[data-testid="question-answer-topics"] dt')?.textContent).toBe(
      'What should it cover',
    )
    expect(badge?.textContent).not.toMatch(/\bformat\b|\btopics\b/)
    await view.cleanup()
  })
})
