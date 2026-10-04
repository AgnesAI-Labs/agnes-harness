/** @vitest-environment happy-dom */
import type { QuestionInteraction, QuestionResolution } from '@agnes/protocol'
import { act } from 'react'
import { Simulate } from 'react-dom/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { createQuestionController } from '../src/question-controller.js'

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
const cleanup: Array<() => void> = []
afterEach(async () => {
  await act(async () => {
    for (const dispose of cleanup.splice(0)) dispose()
  })
  vi.useRealTimers()
  document.body.replaceChildren()
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((ok, no) => {
    resolve = ok
    reject = no
  })
  return { promise, resolve, reject }
}
const interaction = (sessionId: string, interactionId = 'question'): QuestionInteraction => ({
  sessionId,
  interactionId,
  writerRunId: 'writer',
  generation: 1,
  turn: 1,
  callSeq: 2,
  requestedSeq: 3,
  toolUseId: 'tool',
  request: { questions: [{ id: 'q', question: `${sessionId} 的问题` }] },
  policy: { allowSkip: false },
})
function mount() {
  const host = document.createElement('section')
  document.body.append(host)
  const pending = vi.fn(async (id: string) => ({ sessionId: id, interactions: [interaction(id)] }))
  const answer = vi.fn(
    async ({ sessionId, interactionId }: { sessionId: string; interactionId: string }) =>
      ({ sessionId, interactionId, status: 'answered', settledSeq: 4 }) as QuestionResolution,
  )
  const cancel = vi.fn(
    async ({ sessionId, interactionId }: { sessionId: string; interactionId: string }) =>
      ({ sessionId, interactionId, status: 'cancelled', settledSeq: 4 }) as QuestionResolution,
  )
  const listeners = new Map<string, (payload: unknown) => void>()
  let controller!: ReturnType<typeof createQuestionController>
  act(() => {
    controller = createQuestionController(host, {
      questions: { pending, answer, cancel },
      on: (event, handler) => {
        listeners.set(event, handler)
        return () => {
          listeners.delete(event)
        }
      },
    })
  })
  cleanup.push(controller.dispose)
  const button = (text: string) => {
    const node = [...host.querySelectorAll('button')].find((item) => item.textContent === text)
    if (!node) throw new Error(`Missing ${text}`)
    return node
  }
  const write = async (text: string) =>
    act(async () => {
      const field = host.querySelector('textarea')!
      field.value = text
      Simulate.change(field)
    })
  return { host, controller, pending, answer, cancel, button, write, listeners }
}

it('binds answers to the current session and keeps drafts on failure until a durable acknowledgement', async () => {
  const f = mount()
  await act(async () => f.controller.select('left'))
  await f.write('用户原始回答')
  f.answer.mockRejectedValueOnce(new Error('offline'))
  await act(async () => f.button('提交全部回答').click())
  expect(f.host.textContent).toContain('提交未确认')
  expect(f.host.querySelector('textarea')?.value).toBe('用户原始回答')
  const ack = deferred<QuestionResolution>()
  f.answer.mockReturnValueOnce(ack.promise)
  await act(async () => f.button('提交全部回答').click())
  expect(f.host.hidden).toBe(false)
  expect([...f.host.querySelectorAll('button')].every((button) => button.disabled)).toBe(true)
  await act(async () =>
    ack.resolve({ sessionId: 'left', interactionId: 'question', status: 'answered', settledSeq: 4 }),
  )
  expect(f.host.hidden).toBe(true)
  expect(f.answer).toHaveBeenLastCalledWith({
    sessionId: 'left',
    interactionId: 'question',
    answer: {
      answers: [{ id: 'q', selected: [], custom: '用户原始回答' }],
    },
  })
})

it('retires old pending and answer replies without clearing another session or new interaction', async () => {
  const f = mount()
  const old = deferred<{ sessionId: string; interactions: QuestionInteraction[] }>()
  f.pending.mockReturnValueOnce(old.promise)
  await act(async () => f.controller.select('old'))
  await act(async () => f.controller.select('new'))
  await act(async () => old.resolve({ sessionId: 'old', interactions: [interaction('old')] }))
  expect(f.host.textContent).toContain('new 的问题')
  expect(f.host.textContent).not.toContain('old 的问题')
  await f.write('answer')
  const ack = deferred<QuestionResolution>()
  f.answer.mockReturnValueOnce(ack.promise)
  await act(async () => f.button('提交全部回答').click())
  f.pending.mockResolvedValue({ sessionId: 'new', interactions: [interaction('new', 'next')] })
  await act(async () => f.controller.event({ type: 'question/settled' }))
  await act(async () =>
    ack.resolve({ sessionId: 'new', interactionId: 'question', status: 'answered', settledSeq: 4 }),
  )
  expect(f.host.hidden).toBe(false)
  expect(f.host.querySelector('textarea')?.value).toBe('')
})

it('never mounts actionable history, refreshes on return to live and closes the publication race with bounded polling', async () => {
  vi.useFakeTimers()
  const f = mount()
  await act(async () => {
    f.controller.enabled(false)
    f.controller.select('lane')
  })
  f.controller.event({ type: 'question/requested' })
  expect(f.pending).not.toHaveBeenCalled()
  f.pending.mockResolvedValueOnce({ sessionId: 'lane', interactions: [] })
  await act(async () => f.controller.enabled(true))
  expect(f.host.hidden).toBe(true)
  await act(async () => vi.advanceTimersByTimeAsync(2000))
  expect(f.host.textContent).toContain('lane 的问题')
  await act(async () => f.controller.enabled(false))
  const calls = f.pending.mock.calls.length
  await act(async () => vi.advanceTimersByTimeAsync(6000))
  expect(f.pending).toHaveBeenCalledTimes(calls)
  expect(f.host.hidden).toBe(true)
  await act(async () => f.controller.enabled(true))
  expect(f.host.hidden).toBe(false)
})

it('isolates two lanes and sends explicit cancellation only to the selected owner', async () => {
  const left = mount(),
    right = mount()
  await act(async () => {
    left.controller.select('left')
    right.controller.select('right')
  })
  await act(async () => left.button('取消提问').click())
  expect(left.cancel).toHaveBeenCalledWith({ sessionId: 'left', interactionId: 'question' })
  expect(left.answer).not.toHaveBeenCalled()
  expect(right.cancel).not.toHaveBeenCalled()
  expect(right.host.textContent).toContain('right 的问题')
  expect(right.host.hidden).toBe(false)
})

it('rejects a mismatched pending owner and acknowledgement without losing the answer', async () => {
  const f = mount()
  f.pending.mockResolvedValueOnce({ sessionId: 'other', interactions: [interaction('other')] })
  await act(async () => f.controller.select('selected'))
  expect(f.host.querySelector('textarea')).toBeNull()
  await act(async () => f.controller.refresh())
  await f.write('draft')
  f.answer.mockResolvedValueOnce({
    sessionId: 'other',
    interactionId: 'question',
    status: 'answered',
    settledSeq: 4,
  })
  await act(async () => f.button('提交全部回答').click())
  expect(f.host.textContent).toContain('未收到匹配')
  expect(f.host.querySelector('textarea')?.value).toBe('draft')
  await act(async () => f.controller.select())
  expect(f.host.hidden).toBe(true)
})

it('disables stale connection cards, refreshes the live owner after reconnect and retains the draft', async () => {
  const f = mount()
  await act(async () => f.controller.select('session'))
  await f.write('draft across reconnect')
  await act(async () => f.listeners.get('reconnecting')?.(undefined))
  expect(f.button('提交全部回答').disabled).toBe(true)
  expect(f.host.querySelector('textarea')?.value).toBe('draft across reconnect')
  await act(async () => f.listeners.get('reconnected')?.(undefined))
  expect(f.button('提交全部回答').disabled).toBe(false)
  expect(f.host.querySelector('textarea')?.value).toBe('draft across reconnect')
  await act(async () => f.listeners.get('generationChanged')?.({ sessionId: 'other' }))
  expect(f.host.querySelector('textarea')?.value).toBe('draft across reconnect')
  f.pending.mockResolvedValueOnce({ sessionId: 'session', interactions: [] })
  await act(async () => f.listeners.get('generationChanged')?.({ sessionId: 'session' }))
  expect(f.host.hidden).toBe(true)
  await act(async () => f.controller.dispose())
  expect(f.listeners.size).toBe(0)
})
