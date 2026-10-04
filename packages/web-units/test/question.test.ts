/** @vitest-environment happy-dom */
import type { QuestionRequest } from '@agnes/protocol'
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { Question, type QuestionProps } from '../src/question.js'

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanups.splice(0)) await dispose()
})
function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Expected question control')
  return value
}
const request: QuestionRequest = {
  questions: [
    {
      id: 'q',
      question: '选择方式',
      options: [{ label: '选项 A', description: '选项说明' }, { label: '选项 B' }],
    },
  ],
}
async function mount(changes: Partial<QuestionProps> = {}) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  let props: QuestionProps = {
    interactionId: 'interaction',
    request,
    policy: { allowSkip: false },
    onAnswer: vi.fn(async () => {}),
    onCancel: vi.fn(async () => {}),
    ...changes,
  }
  const render = async (next: Partial<QuestionProps>) => {
    props = { ...props, ...next }
    await act(async () => root.render(h(Question, props)))
  }
  const button = (label: string) =>
    required([...host.querySelectorAll('button')].find((node) => node.textContent === label))
  const choose = async (label: string) => {
    await act(async () =>
      required(
        [...host.querySelectorAll<HTMLInputElement>('input')].find((node) => node.value === label),
      ).click(),
    )
  }
  const write = async (text: string) => {
    await act(async () => {
      const field = required(host.querySelector('textarea'))
      field.value = text
      Simulate.change(field)
    })
  }
  cleanups.push(async () => {
    await act(async () => root.unmount())
    host.remove()
  })
  await render({})
  return { host, button, choose, write, render, props }
}

it('submits one complete batch with exact option labels, independent multi-select and free text', async () => {
  const onAnswer = vi.fn(async () => {})
  const f = await mount({
    onAnswer,
    request: {
      questions: [
        {
          id: 'single',
          header: '第一组',
          question: '选一个',
          detail: '帮助说明',
          options: [{ label: '  原始值（推荐）  ', description: '推荐说明' }],
        },
        { id: 'multi', question: '可以多选', multiSelect: true, options: [{ label: '甲' }, { label: '乙' }] },
      ],
    },
  })
  expect(f.host.textContent).toContain('第一组')
  expect(f.host.textContent).toContain('帮助说明')
  expect(f.host.textContent).toContain('推荐说明')
  await f.choose('  原始值（推荐）  ')
  expect(f.host.textContent).toContain('2 / 2')
  await f.choose('甲')
  await f.choose('乙')
  await f.write('  补充\n原样保留  ')
  await act(async () => f.button('上一题').click())
  expect(required(f.host.querySelector<HTMLInputElement>('input')).checked).toBe(true)
  await act(async () => f.button('下一题').click())
  expect(required(f.host.querySelector('textarea')).value).toBe('  补充\n原样保留  ')
  await act(async () => f.button('提交全部回答').click())
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith({
    answers: [
      { id: 'single', selected: ['  原始值（推荐）  '] },
      { id: 'multi', selected: ['甲', '乙'], custom: '  补充\n原样保留  ' },
    ],
  })
  expect(f.button('提交全部回答').disabled).toBe(true)
  expect(f.host.textContent).toContain('回答已提交')
})

it('requires explicit skip when permitted and never treats cancellation as an answer', async () => {
  const onAnswer = vi.fn(async () => {})
  const onCancel = vi.fn(async () => {})
  const f = await mount({ onAnswer, onCancel })
  expect(f.button('提交全部回答').disabled).toBe(true)
  expect(f.host.textContent).not.toContain('跳过此题')
  await act(async () =>
    required(f.host.querySelector('form')).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    ),
  )
  expect(onAnswer).not.toHaveBeenCalled()
  await f.render({ policy: { allowSkip: true } })
  expect(f.button('提交全部回答').disabled).toBe(true)
  await act(async () => f.button('跳过此题').click())
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith({ answers: [{ id: 'q', selected: [] }] })
  expect(onCancel).not.toHaveBeenCalled()
  await f.render({ interactionId: 'new-question' })
  await act(async () => f.button('取消提问').click())
  expect(onCancel).toHaveBeenCalledTimes(1)
  expect(onAnswer).toHaveBeenCalledTimes(1)
  expect(f.host.textContent).toContain('已取消提问')
})

it('freezes repeated submission, retains a failed draft, and allows a deliberate retry', async () => {
  let reject!: (cause: Error) => void
  const onAnswer = vi
    .fn<QuestionProps['onAnswer']>()
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        }),
    )
    .mockResolvedValue(undefined)
  const f = await mount({ onAnswer })
  await f.choose('选项 A')
  await f.write('自定义替代单选')
  expect([...f.host.querySelectorAll<HTMLInputElement>('input')].some((node) => node.checked)).toBe(false)
  await act(async () => {
    f.button('提交全部回答').click()
    f.button('提交全部回答').click()
    required(f.host.querySelector('form')).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    )
  })
  expect(onAnswer).toHaveBeenCalledTimes(1)
  expect(f.button('取消提问').disabled).toBe(true)
  expect(required(f.host.querySelector('textarea')).disabled).toBe(true)
  await act(async () => reject(new Error('连接暂不可用')))
  expect(f.host.querySelector('[role=alert]')?.textContent).toBe('连接暂不可用')
  expect(required(f.host.querySelector('textarea')).value).toBe('自定义替代单选')
  await act(async () => f.button('提交全部回答').click())
  expect(onAnswer).toHaveBeenCalledTimes(2)
  expect(onAnswer.mock.calls[1]?.[0]).toEqual({
    answers: [{ id: 'q', selected: [], custom: '自定义替代单选' }],
  })
})

it.each(['interaction', 'request'] as const)(
  'retires stale promise feedback after %s changes',
  async (kind) => {
    let reject!: (cause: Error) => void
    const onAnswer = vi
      .fn<QuestionProps['onAnswer']>()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, fail) => {
            reject = fail
          }),
      )
      .mockResolvedValue(undefined)
    const f = await mount({ onAnswer })
    await f.choose('选项 A')
    await act(async () => f.button('提交全部回答').click())
    await f.render(
      kind === 'interaction'
        ? { interactionId: 'next' }
        : { request: { questions: [{ ...request.questions[0]!, question: '新的问题' }] } },
    )
    expect(f.button('取消提问').disabled).toBe(false)
    expect(f.button('提交全部回答').disabled).toBe(true)
    await f.write('新回答')
    await act(async () => reject(new Error('旧请求失败')))
    expect(f.host.textContent).not.toContain('旧请求失败')
    expect(required(f.host.querySelector('textarea')).value).toBe('新回答')
    await act(async () => f.button('提交全部回答').click())
    expect(onAnswer.mock.calls[1]?.[0]).toEqual({ answers: [{ id: 'q', selected: [], custom: '新回答' }] })
  },
)

it('isolates radio identity between simultaneous cards and honors disabled and IME input', async () => {
  const left = await mount()
  const right = await mount({ disabled: true })
  expect(required(left.host.querySelector('input')).name).not.toBe(
    required(right.host.querySelector('input')).name,
  )
  await left.choose('选项 A')
  expect(right.button('取消提问').disabled).toBe(true)
  await right.render({ disabled: false })
  await right.choose('选项 B')
  expect(required(left.host.querySelector<HTMLInputElement>('input')).checked).toBe(true)
  await right.write('输入法回答')
  await act(async () =>
    Simulate.keyDown(required(right.host.querySelector('textarea')), { key: 'Enter', keyCode: 229 }),
  )
  expect(right.props.onAnswer).not.toHaveBeenCalled()
  await act(async () =>
    Simulate.keyDown(required(right.host.querySelector('textarea')), { key: 'Enter', shiftKey: true }),
  )
  expect(right.props.onAnswer).not.toHaveBeenCalled()
  await act(async () => Simulate.keyDown(required(right.host.querySelector('textarea')), { key: 'Enter' }))
  expect(right.props.onAnswer).toHaveBeenCalledTimes(1)
})

it('presents declared plan review safely and keeps discuss separate from the named decision', async () => {
  const onAnswer = vi.fn(async () => {})
  const onCancel = vi.fn(async () => {})
  const plan: QuestionRequest = {
    questions: [
      {
        id: 'plan',
        question: '检查此计划',
        detail: '# 计划\n<script>untrusted()</script>',
        options: [{ label: '采用原计划' }, { label: '不采用' }],
        intent: { kind: 'plan-review', approve: '采用原计划' },
      },
    ],
  }
  const f = await mount({ request: plan, onAnswer, onCancel })
  expect(f.host.textContent).toContain('计划审阅')
  expect(f.host.querySelector('script')).toBeNull()
  expect(f.host.querySelector('pre')?.textContent).toContain('<script>')
  await act(async () => f.button('讨论修改').click())
  expect(onCancel).toHaveBeenCalledTimes(1)
  expect(onAnswer).not.toHaveBeenCalled()
  await f.render({ interactionId: 'revised-plan' })
  await act(async () => f.button('采用原计划').click())
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith({ answers: [{ id: 'plan', selected: ['采用原计划'] }] })
  await f.render({
    request: {
      questions: [{ ...plan.questions[0]!, intent: { kind: 'plan-review', approve: '未提供的选项' } }],
    },
  })
  expect(f.host.querySelector('[role=alert]')?.textContent).toContain('提问格式无效')
  expect(f.host.querySelector('button')).toBeNull()
})
