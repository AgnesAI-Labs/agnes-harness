import { createHash } from 'node:crypto'
import type {
  ChannelTargetEvent,
  ManagedInputAdmission,
  ManagedInputResult,
  PersistenceMetadataNamespace,
} from '@agnes/extension-api'
import { describe, expect, it, vi } from 'vitest'
import { type ChannelTargetLink, ChannelTargets } from '../../src/profile/channel-targets.js'
import type { HostManagedSessions } from '../../src/profile/managed-sessions.js'
import { withOwnerReceipts } from '../../src/profile/owner-input-receipts.js'

const CHANNEL = '@sample/chat#plugin/aa'
const DESK = { owner: '@sample/desk#plugin/bb', service: 'desk' }
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

function namespace(): PersistenceMetadataNamespace {
  const map = new Map<string, unknown>()
  return {
    get: (key) => structuredClone(map.get(key)),
    set: (key, value) => void map.set(key, structuredClone(value)),
    delete: (key) => void map.delete(key),
    entries: () => [...map].map(([key, value]) => ({ key, value: structuredClone(value) })),
    transaction: (work) => work(),
  }
}

const link: ChannelTargetLink = {
  provider: 'chat',
  textChars: 1000,
  card: true,
  cardBytes: 4000,
  rendered: () => 1,
  connected: () => true,
  send: async () => ({ messageId: 'm-1' }),
}

/** A desk service paired with one chat, holding an acknowledged receipt for `text`. */
async function paired(text = 'ship the fix') {
  let now = Date.parse('2026-11-14T00:00:00.000Z')
  const targets = new ChannelTargets(namespace(), () => now, [0, 0])
  const bridge = targets.bridge(CHANNEL)
  bridge.attach('desk-bot', link)
  const abort = new AbortController()
  const port = targets.port({ ...DESK, packageId: '@sample/desk', signal: abort.signal, assertCurrent() {} })
  port.onEvent(async () => {})
  const pair = () => {
    const { code } = targets.mint({ channel: CHANNEL, instanceId: 'desk-bot' }, DESK)
    const chat = {
      id: 'a'.repeat(32),
      accountId: 'app-1',
      credentials: 'fp-1',
      route: 'route-1',
      chatId: 'dm-1',
      userId: 'owner',
      label: 'Owner',
    }
    expect(bridge.confirm('desk-bot', code, chat)).toBeTruthy()
    return bridge.find('desk-bot', 'dm-1')!
  }
  const pairing = pair()
  const event: ChannelTargetEvent = {
    kind: 'message',
    origin: 'owner',
    pairingId: pairing.id,
    instanceId: 'desk-bot',
    eventId: 'e1',
    messageId: 'om-1',
    at: '2026-11-14T00:00:00.000Z',
    chat: { id: 'dm-1', type: 'dm' },
    sender: { userId: 'owner' },
    text,
  }
  const { receiptId } = bridge.receive(pairing, event) as { receiptId: string }
  await bridge.deliver(pairing, { ...event, receiptId })
  const repair = async () => {
    await port.unpair(pairing.id)
    now += 1000
    pair()
  }
  return { targets, receiptId, pairing, repair }
}

const result = (state: 'queued' | 'enqueued' | 'needsOwner'): ManagedInputResult => ({
  state,
  inputId: 'k1',
  version: 1,
  reason: state === 'needsOwner' ? 'receiptUnknown' : 'eligible',
  reviewLocation: '/?session=s1&ownerInput=k1',
})

function host(answer: () => Promise<ManagedInputResult> = async () => result('enqueued')) {
  const calls = {
    admitInput: vi.fn(async (_sessionId: string, _input: ManagedInputAdmission) => result('enqueued')),
    admitResolved: vi.fn(async (..._args: unknown[]) => answer()),
    list: vi.fn(async () => []),
  }
  const sessions = calls as unknown as HostManagedSessions
  return { sessions, calls }
}

const admission = (input: ManagedInputAdmission['input']): ManagedInputAdmission => ({
  key: 'k1',
  target: { taskId: 't1', taskGeneration: 1, startKey: 's1' },
  input,
})

describe('owner input receipts', () => {
  it("ownerMessage resolves the caller's own receipt and sends text in resolution, not in args", async () => {
    const { targets, receiptId, pairing } = await paired()
    const input = admission({ kind: 'ownerMessage', receiptId })
    const elsewhere = host()
    const other = withOwnerReceipts(elsewhere.sessions, targets.receipts, { ...DESK, service: 'other' })
    expect(other).not.toHaveProperty('admitResolved')
    await other.admitInput('s1', input)
    expect(elsewhere.calls.admitResolved.mock.calls[0]![2], "another service's receipt is unknown").toEqual({
      kind: 'unresolved',
      receiptId,
      reason: 'receiptUnknown',
    })

    const { sessions, calls } = host()
    const plugin = withOwnerReceipts(sessions, targets.receipts, DESK)
    await expect(plugin.admitInput('s1', input)).resolves.toMatchObject({ state: 'enqueued' })
    expect(calls.admitInput).not.toHaveBeenCalled()
    expect(calls.admitResolved).toHaveBeenCalledWith('s1', input, {
      kind: 'receipt',
      receiptId,
      text: 'ship the fix',
      contentDigest: sha256('ship the fix'),
      source: {
        instanceId: 'desk-bot',
        pairingId: pairing.id,
        eventId: 'e1',
        messageId: 'om-1',
        kind: 'message',
        at: '2026-11-14T00:00:00.000Z',
      },
    })
    expect(JSON.stringify(calls.admitResolved.mock.calls[0]![1])).not.toContain('ship the fix')
  })

  it('a receipt from a pairing that has since changed resolves to pairingChanged', async () => {
    const { targets, receiptId, repair } = await paired()
    await repair()
    const { sessions, calls } = host(async () => result('needsOwner'))
    await withOwnerReceipts(sessions, targets.receipts, DESK).admitInput(
      's1',
      admission({ kind: 'ownerMessage', receiptId }),
    )
    expect(calls.admitResolved.mock.calls[0]![2]).toEqual({
      kind: 'unresolved',
      receiptId,
      reason: 'pairingChanged',
    })
    expect(targets.receipts.resolve(DESK, receiptId), 'an unresolved receipt is never deleted').toMatchObject(
      {
        reason: 'pairingChanged',
      },
    )
  })

  it('the plugin-facing sessions object has no admitResolved', async () => {
    const { sessions } = host()
    const plugin = withOwnerReceipts(sessions, undefined, DESK)
    expect(plugin).not.toHaveProperty('admitResolved')
    expect(Object.keys(plugin).sort()).toEqual(
      [
        'admitInput',
        'archive',
        'events',
        'inputResult',
        'interrupt',
        'list',
        'result',
        'send',
        'start',
        'status',
        'toolResult',
        'usage',
      ].sort(),
    )
    await expect(plugin.list()).resolves.toEqual([])
  })

  it('the receipt is deleted after a recorded admission and kept when the daemon refuses', async () => {
    const refused = await paired()
    const failing = host(async () => {
      throw Object.assign(new Error('refused'), { data: { code: 'CAPABILITY_DENIED' } })
    })
    const input = admission({ kind: 'ownerMessage', receiptId: refused.receiptId })
    await expect(
      withOwnerReceipts(failing.sessions, refused.targets.receipts, DESK).admitInput('s1', input),
    ).rejects.toThrow('refused')
    expect(refused.targets.receipts.resolve(DESK, refused.receiptId)).toMatchObject({ kind: 'receipt' })

    const unfinished = host(async () => result('queued'))
    await withOwnerReceipts(unfinished.sessions, refused.targets.receipts, DESK).admitInput('s1', input)
    expect(
      refused.targets.receipts.resolve(DESK, refused.receiptId),
      'a queued record is not complete yet',
    ).toMatchObject({ kind: 'receipt' })

    const recorded = host(async () => result('enqueued'))
    await withOwnerReceipts(recorded.sessions, refused.targets.receipts, DESK).admitInput('s1', input)
    expect(refused.targets.receipts.resolve(DESK, refused.receiptId)).toEqual({
      kind: 'unresolved',
      receiptId: refused.receiptId,
      reason: 'receiptUnknown',
    })
  })

  it('recoveryContinuation and legacyOwnerMessage pass through without resolution', async () => {
    const { targets } = await paired()
    const { sessions, calls } = host()
    const plugin = withOwnerReceipts(sessions, targets.receipts, DESK)
    const recovery = admission({ kind: 'recoveryContinuation', turnEndSeq: 7 })
    const legacy = admission({ kind: 'legacyOwnerMessage', text: 'old', originalInbox: null })
    await plugin.admitInput('s1', recovery)
    await plugin.admitInput('s1', legacy)
    expect(calls.admitInput.mock.calls).toEqual([
      ['s1', recovery],
      ['s1', legacy],
    ])
    expect(calls.admitResolved).not.toHaveBeenCalled()
  })
})
