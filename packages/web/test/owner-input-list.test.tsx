/** @vitest-environment happy-dom */
import type { ManagedInputListResult } from '@agnes/protocol'
import { homeEntries, homeNavigation } from '@agnes/web-client'
import { renderRegion, unmountRegion } from '@agnes/web-ui'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OWNER_INPUT_ENTRY, OwnerInputListPage, registerOwnerInputEntry } from '../src/owner-input-list.js'
import { registerBuiltinHomeEntries } from '../src/pages/entries.js'

vi.mock('../src/pages/admin-api.js', () => ({
  homeAdmin: async () => ({ api: { candidatesList: async () => ({ candidates: [] }) } }),
}))

const parked = (sessionId: string | null, receiptId: string, text: string) => ({
  sessionId,
  receiptId,
  service: 'companion',
  kind: 'message' as const,
  text,
  at: '2026-11-14T02:00:00.000Z',
  attempts: 5,
})

const listed = (): ManagedInputListResult => ({
  inputs: [
    {
      sessionId: 's1',
      key: 'k1',
      kind: 'ownerMessage',
      state: 'needsOwner',
      reason: 'pairingChanged',
      version: 2,
      at: '2026-11-14T01:00:00.000Z',
    },
    {
      sessionId: 's2',
      key: 'k/2',
      kind: 'ownerMessage',
      state: 'enqueued',
      reason: 'busy',
      version: 2,
      at: '2026-11-14T01:00:00.000Z',
      held: 'gatesUnreadable',
    },
  ],
  parkedReceipts: [
    parked('s1', 'a'.repeat(64), 'are you still there?'),
    parked(null, 'b'.repeat(64), 'orphan'),
  ],
})

type Call = <T>(method: string, params: unknown) => Promise<T>
const bodyText = () => document.body.textContent ?? ''
const buttons = (label: string) =>
  [...document.body.querySelectorAll('button')].filter((item) => item.textContent?.trim() === label)

beforeEach(() => {
  document.documentElement.lang = 'en'
})
afterEach(() => {
  unmountRegion(document.body)
  document.body.replaceChildren()
  homeNavigation.close()
})

it('lists every input waiting on the owner and every parked message without a key, and redelivers in place', async () => {
  let list = listed()
  const call = vi.fn(async (method: string, params: unknown) => {
    if (method === '_agnes/v1/managedInput.decide') {
      list = { ...list, parkedReceipts: list.parkedReceipts.slice(1) }
      return { receipt: 'pending' }
    }
    expect(params).toEqual({})
    return list
  })
  const changed = vi.fn()
  renderRegion(document.body, <OwnerInputListPage call={call as Call} changed={changed} />)
  await vi.waitFor(() => expect(bodyText()).toContain('are you still there?'))
  expect(call).toHaveBeenCalledWith('_agnes/v1/managedInput.list', {})
  for (const shown of [
    'Waiting for your decision',
    'pairingChanged',
    'Held: the session checks could not be read',
    'orphan',
    'has no managed session to act through',
  ])
    expect(bodyText()).toContain(shown)
  // Each input opens its own session's review panel.
  const links = [...document.body.querySelectorAll<HTMLAnchorElement>('a.owner-input-review-link')]
  expect(links.map((link) => link.getAttribute('href'))).toEqual([
    '/?session=s1&ownerInput=k1',
    '/?session=s2&ownerInput=k%2F2',
  ])
  // Only the message with a session of its service has actions; they act through that session.
  expect(buttons('Redeliver')).toHaveLength(1)
  buttons('Redeliver')[0]?.click()
  await vi.waitFor(() => expect(bodyText()).not.toContain('are you still there?'))
  expect(call).toHaveBeenCalledWith('_agnes/v1/managedInput.decide', {
    sessionId: 's1',
    target: { kind: 'receipt', receiptId: 'a'.repeat(64), decision: 'redeliver' },
  })
  expect(changed).toHaveBeenCalled()
})

it('the home entry appears with its count once something waits on the owner, and not before', async () => {
  let list: ManagedInputListResult = { inputs: [], parkedReceipts: [] }
  const call = vi.fn(async () => list)
  const dispose = registerOwnerInputEntry(call as unknown as Call)
  try {
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(homeEntries.get(OWNER_INPUT_ENTRY)).toBeUndefined()
    // A receipt parks: the next read (here, a home navigation) adds the entry with its count.
    list = { inputs: [], parkedReceipts: [parked('s1', 'a'.repeat(64), 'hello')] }
    homeNavigation.open('agents')
    await vi.waitFor(() => expect(homeEntries.get(OWNER_INPUT_ENTRY)).toBeDefined())
    const entry = homeEntries.get(OWNER_INPUT_ENTRY)
    expect(entry).toMatchObject({ placement: 'primary', titleKey: 'home.entry.ownerInputs' })
    expect(entry?.badge?.getSnapshot()).toBe(1)
    // A refused read (not the owner's page) shows no count.
    call.mockRejectedValueOnce(new Error('CAPABILITY_DENIED'))
    homeNavigation.close()
    await vi.waitFor(() => expect(entry?.badge?.getSnapshot()).toBe(0))
  } finally {
    dispose()
  }
  expect(homeEntries.get(OWNER_INPUT_ENTRY)).toBeUndefined()
})

it("the built-in home entries include the owner input list only with the page's owner-only caller", async () => {
  const call = vi.fn(async () => ({ inputs: [], parkedReceipts: [parked(null, 'c'.repeat(64), 'x')] }))
  const plain = registerBuiltinHomeEntries()
  await Promise.resolve()
  expect(homeEntries.get(OWNER_INPUT_ENTRY)).toBeUndefined()
  plain()
  const owned = registerBuiltinHomeEntries(call as unknown as Call)
  try {
    await vi.waitFor(() => expect(homeEntries.get(OWNER_INPUT_ENTRY)?.badge?.getSnapshot()).toBe(1))
  } finally {
    owned()
  }
})
