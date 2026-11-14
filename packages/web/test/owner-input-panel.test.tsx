/** @vitest-environment happy-dom */
import type { ManagedInputGetResult } from '@agnes/protocol'
import { renderRegion, unmountRegion } from '@agnes/web-ui'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OwnerInputPanel } from '../src/owner-input-panel.js'

const read = (
  version = 3,
  state = 'recoveryUnknown',
  reason = 'legacySourceUnknown',
): ManagedInputGetResult => ({
  input: {
    key: 'k1',
    kind: 'legacyOwnerMessage',
    state: state as never,
    reason,
    version,
    text: 'ship the release notes',
    source: { channel: 'feishu', eventId: 'evt-9' },
    binding: { taskId: 'T-0045', taskGeneration: 2, startKey: 'start-7' },
    history: [
      { version: 1, state: 'queued', reason: 'eligible', at: '2026-11-14T01:00:00.000Z', by: 'platform' },
      {
        version: 2,
        state: 'recoveryUnknown',
        reason: 'legacySourceUnknown',
        at: '2026-11-14T01:00:01.000Z',
        by: 'platform',
      },
      ...(version > 2
        ? [{ version, state: state as never, reason, at: '2026-11-14T01:00:02.000Z', by: 'owner' as const }]
        : []),
    ],
  },
  parkedReceipts: [
    {
      receiptId: 'r'.repeat(64),
      service: 'companion',
      kind: 'message',
      text: 'are you still there?',
      at: '2026-11-14T02:00:00.000Z',
      attempts: 5,
    },
  ],
})

const bodyText = () => document.body.textContent ?? ''
const buttons = (label: string) =>
  [...document.body.querySelectorAll('button')].filter((item) => item.textContent?.trim() === label)
const button = (label: string) => buttons(label)[0]

function panel(call: (method: string, params: unknown) => Promise<unknown>) {
  renderRegion(
    document.body,
    <OwnerInputPanel sessionId="s1" inputKey="k1" call={call as <T>(m: string, p: unknown) => Promise<T>} />,
  )
}

beforeEach(() => {
  document.documentElement.lang = 'en'
})
afterEach(() => {
  unmountRegion(document.body)
  document.body.replaceChildren()
})

it('the panel shows original text, source, binding, current state and reason, and the version history', async () => {
  const call = vi.fn(async (_method: string, _params: unknown) => read())
  panel(call)
  await vi.waitFor(() => expect(bodyText()).toContain('ship the release notes'))
  expect(call).toHaveBeenCalledWith('_agnes/v1/managedInput.get', { sessionId: 's1', key: 'k1' })
  for (const shown of [
    'feishu',
    'evt-9',
    'T-0045',
    'start-7',
    'Waiting for your decision',
    'legacySourceUnknown',
    'v1',
    'v2',
    'v3',
  ])
    expect(bodyText()).toContain(shown)
  // The dock renders the panel again with a new call function; that alone does not read again.
  renderRegion(
    document.body,
    <OwnerInputPanel
      sessionId="s1"
      inputKey="k1"
      call={
        ((method: string, params: unknown) => call(method, params)) as <T>(
          m: string,
          p: unknown,
        ) => Promise<T>
      }
    />,
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(call).toHaveBeenCalledTimes(1)
})

it('deliver, retain and discard call managedInput.decide with the shown version, then re-read', async () => {
  for (const [label, decision] of [
    ['Deliver', 'deliver'],
    ['Keep', 'retain'],
    ['Discard', 'discard'],
  ] as const) {
    let reads = 0
    const call = vi.fn(async (method: string) => {
      if (method === '_agnes/v1/managedInput.get')
        return reads++ === 0 ? read(3) : read(4, 'retained', 'ownerRetained')
      return { state: 'retained', version: 4 }
    })
    panel(call)
    await vi.waitFor(() => expect(button(label)?.disabled).toBe(false))
    button(label)?.click()
    await vi.waitFor(() => expect(bodyText()).toContain('ownerRetained'))
    expect(call).toHaveBeenCalledWith('_agnes/v1/managedInput.decide', {
      sessionId: 's1',
      target: { kind: 'input', key: 'k1', decision, version: 3 },
    })
    expect(call.mock.calls.filter(([method]) => method === '_agnes/v1/managedInput.get')).toHaveLength(2)
    // A final state offers no further decision.
    expect(button('Deliver')).toBeUndefined()
    unmountRegion(document.body)
    document.body.replaceChildren()
  }
})

it('a version conflict re-reads and says the input changed', async () => {
  let reads = 0
  const call = vi.fn(async (method: string) => {
    if (method === '_agnes/v1/managedInput.get')
      return reads++ === 0 ? read(3) : read(5, 'needsOwner', 'grantRevoked')
    throw Object.assign(new Error('SEMANTIC_REJECTED'), {
      code: -32011,
      data: { code: 'VERSION_CHANGED', version: 5 },
    })
  })
  panel(call)
  await vi.waitFor(() => expect(button('Deliver')?.disabled).toBe(false))
  button('Deliver')?.click()
  await vi.waitFor(() => expect(bodyText()).toContain('This input changed after it was shown'))
  expect(bodyText()).toContain('grantRevoked')
  expect(call.mock.calls.filter(([method]) => method === '_agnes/v1/managedInput.get')).toHaveLength(2)
  // The next decision carries the version now on screen.
  button('Deliver')?.click()
  await vi.waitFor(() =>
    expect(call).toHaveBeenLastCalledWith('_agnes/v1/managedInput.get', { sessionId: 's1', key: 'k1' }),
  )
  expect(call).toHaveBeenCalledWith('_agnes/v1/managedInput.decide', {
    sessionId: 's1',
    target: { kind: 'input', key: 'k1', decision: 'deliver', version: 5 },
  })
})

it('every refusal code reads as an owner-facing message, never as the code', async () => {
  for (const [code, message] of [
    ['OWNER_INPUT_STALE', 'This input changed after it was shown'],
    ['OWNER_INPUT_FINAL', 'This input is already settled'],
    ['OWNER_INPUT_UNKNOWN', 'This input no longer exists in this session'],
    ['OWNER_INPUT_NO_TEXT', 'cannot be delivered. Keep or discard it instead'],
    ['OWNER_INPUT_SUBMITTED', "already in the session's queue"],
    ['CAPABILITY_DENIED', 'Only your own Web page can decide owner inputs'],
    ['SOMETHING_NEW', 'The decision did not go through'],
  ] as const) {
    const call = vi.fn(async (method: string) => {
      if (method === '_agnes/v1/managedInput.get') return read()
      throw Object.assign(new Error('refused'), { code: -32011, data: { code } })
    })
    panel(call)
    await vi.waitFor(() => expect(button('Deliver')?.disabled).toBe(false))
    button('Deliver')?.click()
    await vi.waitFor(() => expect(bodyText()).toContain(message))
    expect(bodyText()).not.toContain(code)
    unmountRegion(document.body)
    document.body.replaceChildren()
  }
  // A receipt that is no longer parked says so, too.
  const call = vi.fn(async (method: string) => {
    if (method === '_agnes/v1/managedInput.get') return read()
    throw Object.assign(new Error('refused'), { code: -32011, data: { code: 'RECEIPT_NOT_PARKED' } })
  })
  panel(call)
  await vi.waitFor(() => expect(button('Redeliver')?.disabled).toBe(false))
  button('Redeliver')?.click()
  await vi.waitFor(() => expect(bodyText()).toContain('This channel message is no longer parked'))
  expect(bodyText()).not.toContain('RECEIPT_NOT_PARKED')
})

it('parked receipts are listed with redeliver and discard', async () => {
  const call = vi.fn(async (method: string, params: unknown) => {
    if (method === '_agnes/v1/managedInput.get') return read()
    const target = (params as { target: { decision: string } }).target
    return { receipt: target.decision === 'redeliver' ? 'pending' : 'discarded' }
  })
  panel(call)
  await vi.waitFor(() => expect(bodyText()).toContain('are you still there?'))
  expect(bodyText()).toContain('companion')
  expect(bodyText()).toContain('5 attempts')
  button('Redeliver')?.click()
  await vi.waitFor(() =>
    expect(call).toHaveBeenCalledWith('_agnes/v1/managedInput.decide', {
      sessionId: 's1',
      target: { kind: 'receipt', receiptId: 'r'.repeat(64), decision: 'redeliver' },
    }),
  )
  // The receipt's own discard sits beside its redeliver, apart from the input's discard.
  expect(buttons('Discard')).toHaveLength(2)
  await vi.waitFor(() => expect(buttons('Discard')[1]?.disabled).toBe(false))
  buttons('Discard')[1]?.click()
  await vi.waitFor(() =>
    expect(call).toHaveBeenCalledWith('_agnes/v1/managedInput.decide', {
      sessionId: 's1',
      target: { kind: 'receipt', receiptId: 'r'.repeat(64), decision: 'discard' },
    }),
  )
  expect(call.mock.calls.filter(([method]) => method === '_agnes/v1/managedInput.get')).toHaveLength(3)
})
