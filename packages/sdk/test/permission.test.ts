import { afterEach, expect, it, vi } from 'vitest'
import { PermissionGate, type PermissionRequest } from '../src/permission.js'

const allowOption = { optionId: 'a', name: 'allow', kind: 'allow_once' as const }
const request: PermissionRequest = {
  sessionId: 's',
  toolCall: { toolCallId: 't' },
  options: [
    { optionId: 'a', name: 'allow', kind: 'allow_once' },
    { optionId: 'r', name: 'reject', kind: 'reject_once' },
  ],
}
const rejected = { outcome: { outcome: 'selected', optionId: 'r' } }
afterEach(() => vi.useRealTimers())
it('defaults to rejection, or cancellation when no reject option is offered', async () => {
  const gate = new PermissionGate()
  expect(await gate.answer(request)).toEqual(rejected)
  expect(await gate.answer({ ...request, options: [allowOption] })).toEqual({
    outcome: { outcome: 'cancelled' },
  })
})
it('maps valid outcomes against an immutable option snapshot', async () => {
  const gate = new PermissionGate()
  gate.register(async (req) => {
    if (req.options[0]) req.options[0].optionId = 'forged'
    return { optionId: 'forged' }
  })
  expect(await gate.answer(request)).toEqual(rejected)
  gate.register(async () => ({ verdict: 'allowed-once' }))
  expect(await gate.answer(request)).toEqual({ outcome: { outcome: 'selected', optionId: 'a' } })
})
it('keeps an explicit reject option distinct from a dismissed approval', async () => {
  const gate = new PermissionGate()
  gate.register(async () => ({ optionId: 'r' }))
  expect(await gate.answer(request)).toEqual(rejected)
})
it('accepts the Agnes permanent verdict type without mapping it onto an ACP option', async () => {
  const gate = new PermissionGate()
  gate.register(async () => ({ verdict: 'allowed-permanent' }))
  expect(await gate.answer(request)).toEqual(rejected)
})
it('refuses duplicate option identities and exceptions', async () => {
  const gate = new PermissionGate()
  gate.register(async () => ({ optionId: 'a' }))
  expect(await gate.answer({ ...request, options: [allowOption, allowOption] })).toEqual({
    outcome: { outcome: 'cancelled' },
  })
  gate.register(async () => {
    throw new Error('PRIVATE')
  })
  expect(await gate.answer(request)).toEqual(rejected)
})
it.each(['dispose', 'close'])('ends an unanswered request on %s and ignores a late allow', async (action) => {
  const gate = new PermissionGate()
  let allow!: (value: { optionId: string }) => void
  const off = gate.register(
    () =>
      new Promise((resolve) => {
        allow = resolve
      }),
  )
  const pending = gate.answer(request)
  await Promise.resolve()
  if (action === 'dispose') off()
  else gate.close()
  expect(await pending).toEqual({ outcome: { outcome: 'cancelled' } })
  allow({ optionId: 'a' })
  expect(await pending).toEqual({ outcome: { outcome: 'cancelled' } })
})
it('honors the supplied absolute deadline and leaves no timer after refusal', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  const gate = new PermissionGate()
  gate.register(() => new Promise(() => {}))
  let settled = false
  const pending = gate.answer({ ...request, deadlineMs: 1100 }).then((v) => {
    settled = true
    return v
  })
  await vi.advanceTimersByTimeAsync(99)
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(settled).toBe(true)
  expect(await pending).toEqual({ outcome: { outcome: 'cancelled' } })
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['dispose', 'close'])('signals the UI to close when the permission handler is %s', async (action) => {
  const gate = new PermissionGate()
  let signal: AbortSignal | undefined
  const off = gate.register(async (_request, context) => {
    signal = context.signal
    return new Promise(() => {})
  })
  const pending = gate.answer(request)
  await Promise.resolve()
  expect(signal?.aborted).toBe(false)
  if (action === 'dispose') off()
  else gate.close()
  expect(await pending).toEqual({ outcome: { outcome: 'cancelled' } })
  expect(signal?.aborted).toBe(true)
})

it('does not turn a UI rejection emitted during session switch into a user rejection', async () => {
  const gate = new PermissionGate()
  const off = gate.register(
    (_request, context) =>
      new Promise((resolve) => {
        context.signal.addEventListener('abort', () => resolve({ verdict: 'rejected' }), { once: true })
      }),
  )
  const pending = gate.answer(request)
  await Promise.resolve()
  off()
  expect(await pending).toEqual({ outcome: { outcome: 'cancelled' } })
})

it('uses independent request signals: a deadline closes one UI without cancelling its sibling', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  const gate = new PermissionGate()
  const signals: AbortSignal[] = []
  const answers: Array<(value: { optionId: string }) => void> = []
  gate.register(async (_request, context) => {
    signals.push(context.signal)
    return new Promise((resolve) => {
      answers.push(resolve)
    })
  })
  const first = gate.answer({ ...request, deadlineMs: 1100 })
  const second = gate.answer(request)
  await vi.advanceTimersByTimeAsync(100)
  expect(await first).toEqual({ outcome: { outcome: 'cancelled' } })
  expect(signals[0]?.aborted).toBe(true)
  expect(signals[1]?.aborted).toBe(false)
  expect(signals[0]).not.toBe(signals[1])
  answers[1]?.({ optionId: 'a' })
  expect(await second).toEqual({ outcome: { outcome: 'selected', optionId: 'a' } })
  expect(signals[1]?.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
