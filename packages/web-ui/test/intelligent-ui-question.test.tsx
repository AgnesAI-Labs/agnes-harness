/** @vitest-environment happy-dom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })

import type { UiSurface } from '@agnes/protocol/gen/intelligent-ui'
import { act, createElement, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AnsweredBadge,
  completeAnswers,
  intelligentUiCatalog,
  type QuestionAnswers,
  QuestionAnswersReceipt,
  QuestionCard,
  type QuestionCardProps,
  questionForm,
  shortQuestionLabel,
} from '../src/intelligent-ui/index.js'
import { type UiLocale, UiLocaleProvider, type UiLocaleSource } from '../src/ui-locale.js'

const translator = (locale: UiLocale) => (key: string, vars?: Record<string, string | number>) =>
  (intelligentUiCatalog[locale][key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(vars?.[name] ?? ''))
const source = (locale: UiLocale): UiLocaleSource => ({
  getSnapshot: () => locale,
  getVersion: () => 0,
  subscribe: () => () => {},
  t: translator(locale),
  bind: () => translator(locale),
})

/** The shape ask_user_question publishes (see packages/base/extensions/interaction/src/question.ts). */
function surface(deadline = 0): UiSurface {
  const choice = (options: string[], free = false) => ({
    type: 'string',
    minLength: 1,
    ...(free ? {} : { enum: options }),
  })
  return {
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
          // Canonical JSON sorts properties; `required` keeps the asking order.
          required: ['days', 'topics', 'notes', 'who'],
          properties: {
            days: {
              title: '行程按几天几晚规划？',
              ...choice(['2 天 1 晚', '3 天 2 晚']),
              'x-ui-choices': ['2 天 1 晚', '3 天 2 晚'],
            },
            notes: { title: 'Anything else?', type: 'string', minLength: 1 },
            topics: {
              title: 'Which topics should it cover?',
              type: 'array',
              minItems: 1,
              items: choice(['Food', 'Transport', 'Budget']),
              'x-ui-choices': ['Food', 'Transport', 'Budget'],
            },
            who: {
              title: 'Who is travelling?',
              ...choice(['Couple', 'Family'], true),
              'x-ui-choices': ['Couple', 'Family'],
            },
          },
        },
      },
    ],
    data: { draft: {}, question: { kind: 'ask_user_question', deadline, labels: { topics: 'Topics' } } },
    actions: [
      {
        id: 'submit',
        label: 'Submit',
        tool: 'ui_submit',
        argsTemplate: { surfaceId: { literal: 'card-q' }, answers: { from: 'input', key: 'answers' } },
        paramsSchema: { type: 'object' },
      },
    ],
  }
}

let host: HTMLElement | undefined
afterEach(() => {
  host?.remove()
  host = undefined
})
async function mount(
  overrides: Partial<QuestionCardProps> & { locale?: UiLocale; initial?: QuestionAnswers } = {},
) {
  const form = questionForm(surface(overrides.form?.deadline))!
  const onSubmit = vi.fn()
  const { locale = 'zh-CN', initial = {}, ...props } = overrides
  function Harness() {
    const [answers, setAnswers] = useState<QuestionAnswers>(initial)
    return createElement(QuestionCard, {
      surfaceId: 'card-q',
      form,
      answers,
      locked: false,
      submitting: false,
      failed: false,
      onAnswers: setAnswers,
      onSubmit,
      now: 1000,
      ...props,
    })
  }
  host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () =>
    root.render(createElement(UiLocaleProvider, { source: source(locale) }, createElement(Harness))),
  )
  return { host, onSubmit }
}
const q = (selector: string) => host!.querySelector<HTMLElement>(selector)
const press = async (target: HTMLElement, key: string, init: KeyboardEventInit = {}) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  })
const click = async (target: HTMLElement | null) => act(async () => target?.click())
const type = async (target: HTMLElement | null, value: string) =>
  act(async () => {
    const input = target as HTMLInputElement | HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })

describe('question form', () => {
  it('reads the questions from the marked form and ignores unmarked forms', () => {
    const form = questionForm(surface(5))!
    expect(form.deadline).toBe(5)
    expect(form.questions.map((item) => [item.id, item.label, item.multiple, item.freeText])).toEqual([
      ['days', '行程按几天几晚规划', false, false],
      ['topics', 'Topics', true, false],
      ['notes', 'Anything else', false, true],
      ['who', 'Who is travelling', false, true],
    ])
    expect(form.questions[2]?.options).toEqual([])
    const plain = surface()
    expect(questionForm({ ...plain, data: { draft: {} } })).toBeUndefined()
    expect(shortQuestionLabel('这是一个非常非常长的问题需要被截短？')).toBe('这是一个非常非常长的…')
    expect(shortQuestionLabel('How many days and nights should the trip be planned for?')).toBe(
      'How many days and…',
    )
  })
})

describe('question card', () => {
  it('shows one question at a time with step chips, kind hints and number-key selection', async () => {
    await mount()
    expect(q('h3')?.textContent).toBe('需要你确认 · 4 个问题')
    expect(host!.querySelectorAll('[data-testid^="question-step-"]')).toHaveLength(4)
    expect(q('[data-testid="question-step-0"]')?.dataset.state).toBe('current')
    expect(q('.agnes-question-kind')?.textContent).toBe('单选')
    expect(q('[data-testid="question-option-days-0"]')?.getAttribute('type')).toBe('radio')
    expect(q('[data-testid="question-other-days"]')).toBeNull()
    await press(q('[data-testid="question-card"]')!, '2')
    expect((q('[data-testid="question-option-days-1"]') as HTMLInputElement).checked).toBe(true)
    await press(q('[data-testid="question-option-days-1"]')!, 'Enter')
    expect(q('[data-testid="question-step-0"]')?.dataset.state).toBe('done')
    expect(q('[data-testid="question-step-1"]')?.dataset.state).toBe('current')
    expect(q('.agnes-question-kind')?.textContent).toBe('可多选')
    expect(q('[data-testid="question-option-topics-0"]')?.getAttribute('type')).toBe('checkbox')
    await press(q('[data-testid="question-card"]')!, '1')
    await press(q('[data-testid="question-card"]')!, '3')
    expect(q('.agnes-question-hint')?.textContent).toBe('已选 2 项')
    await press(q('[data-testid="question-card"]')!, 'Enter', { shiftKey: true })
    expect(q('[data-testid="question-step-0"]')?.dataset.state).toBe('current')
    await click(q('[data-testid="question-step-2"]'))
    expect(q('[data-testid="question-text-notes"]')?.tagName).toBe('TEXTAREA')
    expect(q('[data-testid^="question-option-notes"]')).toBeNull()
  })

  it('submits the answered subset, through the given action', async () => {
    const { onSubmit } = await mount()
    await click(q('[data-testid="question-step-3"]'))
    const submit = q('[data-testid="question-submit"]') as HTMLButtonElement
    // Nothing answered yet: the button stays disabled and says how many questions are left.
    expect(submit.textContent).toBe('提交回答')
    expect(submit.disabled).toBe(true)
    expect(q('[data-testid="question-remaining"]')?.textContent).toBe('还有 4 个问题未答')
    // One answer is enough to submit: the rest can be asked again later.
    await click(q('[data-testid="question-step-0"]'))
    await click(q('[data-testid="question-option-days-0"]'))
    await click(q('[data-testid="question-step-3"]'))
    const partial = q('[data-testid="question-submit"]') as HTMLButtonElement
    expect(partial.disabled).toBe(false)
    expect(q('[data-testid="question-remaining"]')?.textContent).toBe('还有 3 个问题未答')
    await press(q('[data-testid="question-other-who"]')!, 'Enter')
    expect(onSubmit).toHaveBeenCalledWith({ days: '2 天 1 晚' })
  })

  it('submits every answered question once all of them are filled in', async () => {
    const { onSubmit } = await mount()
    await click(q('[data-testid="question-step-3"]'))
    // Free text beside the options («其他») replaces a single choice.
    await type(q('[data-testid="question-other-who"]'), 'Friends')
    await click(q('[data-testid="question-step-0"]'))
    await click(q('[data-testid="question-option-days-0"]'))
    await click(q('[data-testid="question-step-1"]'))
    await click(q('[data-testid="question-option-topics-2"]'))
    await click(q('[data-testid="question-step-2"]'))
    await type(q('[data-testid="question-text-notes"]'), 'Quiet hotels')
    await click(q('[data-testid="question-step-3"]'))
    expect((q('[data-testid="question-submit"]') as HTMLButtonElement).disabled).toBe(false)
    await press(q('[data-testid="question-other-who"]')!, 'Enter')
    expect(onSubmit).toHaveBeenCalledWith({
      days: '2 天 1 晚',
      topics: ['Budget'],
      notes: 'Quiet hotels',
      who: 'Friends',
    })
  })

  it('takes the keys when nothing on the page has focus', async () => {
    await mount()
    await press(document.body, '2')
    expect((q('[data-testid="question-option-days-1"]') as HTMLInputElement).checked).toBe(true)
    await press(document.body, 'Enter')
    expect(q('[data-testid="question-step-1"]')?.dataset.state).toBe('current')
  })

  it('digits typed into free text stay text', async () => {
    await mount({ initial: { days: '3 天 2 晚' } })
    expect(q('[data-testid="question-step-1"]')?.dataset.state).toBe('current')
    await click(q('[data-testid="question-step-3"]'))
    const other = q('[data-testid="question-other-who"]')!
    await press(other, '1')
    expect((q('[data-testid="question-option-who-0"]') as HTMLInputElement).checked).toBe(false)
  })

  it('names whether the agent is waiting, and collapses to one progress line', async () => {
    await mount({ form: { ...questionForm(surface(5000))! } })
    expect(q('[data-testid="question-status"]')?.textContent).toBe('智能体在等你回答')
    await act(async () => host!.remove())
    await mount({ initial: { days: '2 天 1 晚' } })
    expect(q('[data-testid="question-status"]')?.textContent).toBe('智能体在继续工作，答完会收到')
    await click(q('[data-testid="question-toggle"]'))
    expect(q('h3')?.textContent).toBe('需要你确认 · 1 / 4 已答')
    expect(q('.agnes-question-body')).toBeNull()
    expect(q('[data-testid="question-toggle"]')?.textContent).toBe('展开')
  })

  it('speaks English from the same keys', async () => {
    await mount({ locale: 'en' })
    expect(q('h3')?.textContent).toBe('Needs your answer · 4 questions')
    expect(q('.agnes-question-kind')?.textContent).toBe('Choose one')
    expect(Object.keys(intelligentUiCatalog.en!).sort()).toEqual(
      Object.keys(intelligentUiCatalog['zh-CN']!).sort(),
    )
  })

  it('shows submitted answers as a receipt with pills for multiple answers', async () => {
    host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () =>
      root.render(
        createElement(
          UiLocaleProvider,
          { source: source('zh-CN') },
          createElement(QuestionAnswersReceipt, {
            items: [
              { id: 'days', label: '几天几晚', value: '3 天 2 晚' },
              { id: 'topics', label: '内容范围', value: ['美食推荐', '交通和住宿'] },
            ],
          }),
        ),
      ),
    )
    expect(q('[data-testid="question-answers"] header')?.textContent).toBe('你的回答')
    expect(q('[data-testid="question-answer-days"]')?.textContent).toBe('几天几晚3 天 2 晚')
    expect(host.querySelectorAll('[data-testid="question-answer-topics"] .agnes-question-pill')).toHaveLength(
      2,
    )
    // Without a label the answer stands alone: no id column.
    await act(async () =>
      root.render(
        createElement(
          UiLocaleProvider,
          { source: source('zh-CN') },
          createElement(QuestionAnswersReceipt, { items: [{ id: 'scope', value: '单个 index.html' }] }),
        ),
      ),
    )
    expect(q('[data-testid="question-answers"] dt')).toBeNull()
    expect(q('[data-testid="question-answers"] dl')?.hasAttribute('data-unlabelled')).toBe(true)
    expect(q('[data-testid="question-answers"]')?.textContent).not.toContain('scope')
    expect(
      completeAnswers(questionForm(surface())!, { days: 'x', topics: [], notes: 'n', who: 'y' }),
    ).toBeUndefined()
  })

  it('marks an answered question with a badge whose panel lists label → answer', async () => {
    host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const items = [
      { id: 'purpose', label: '门户用途', question: '门户用途是什么？', value: '公司或团队官网' },
      { id: 'style', label: '风格偏好', value: ['简洁现代', '浅色'] },
    ]
    await act(async () =>
      root.render(
        createElement(UiLocaleProvider, { source: source('zh-CN') }, createElement(AnsweredBadge, { items })),
      ),
    )
    const badge = q('[data-testid="question-answered-badge"]')!
    expect(badge.textContent).toBe('已回答 2 项')
    const panel = q('[data-testid="question-answers"]')!
    expect(panel.getAttribute('role')).toBe('tooltip')
    expect(badge.getAttribute('aria-describedby')).toBe(panel.id)
    expect(panel.textContent).toBe('你的回答门户用途公司或团队官网风格偏好简洁现代、浅色')
    // A mouse only hovers; a touch pins it open until a touch elsewhere.
    const wrapper = q('[data-testid="question-answered"]')!
    const pointer = (type: string, pointerType: string, target: EventTarget = badge) =>
      act(async () => {
        const event = new MouseEvent(type, { bubbles: true }) as MouseEvent & { pointerType: string }
        Object.defineProperty(event, 'pointerType', { value: pointerType })
        target.dispatchEvent(event)
      })
    await pointer('pointerup', 'mouse')
    expect(wrapper.hasAttribute('data-open')).toBe(false)
    await pointer('pointerup', 'touch')
    expect(wrapper.hasAttribute('data-open')).toBe(true)
    // At the top of the window (no room above) the panel opens below the badge.
    expect(wrapper.hasAttribute('data-below')).toBe(true)
    await pointer('pointerdown', 'touch', panel)
    expect(wrapper.hasAttribute('data-open')).toBe(true)
    await pointer('pointerdown', 'touch', document.body)
    expect(wrapper.hasAttribute('data-open')).toBe(false)
    await act(async () =>
      root.render(
        createElement(
          UiLocaleProvider,
          { source: source('en') },
          createElement(AnsweredBadge, { items: [{ id: 'scope', value: 'index.html' }] }),
        ),
      ),
    )
    expect(q('[data-testid="question-answered-badge"]')?.textContent).toBe('Answered 1')
    expect(q('[data-testid="question-answers"] dt')).toBeNull()
    expect(q('[data-testid="question-answers"]')?.textContent).not.toContain('scope')
  })
})
