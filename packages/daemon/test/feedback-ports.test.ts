import type { PackageAdminAuthority, PackageAdminService } from '@agnes/daemon-admin/packages/index'
import { LocalEndpoint, type CallContext } from '@agnes/daemon-foundation/local/endpoint'
import { FEEDBACK_EVENT, FEEDBACK_GROWTH_EVENT } from '@agnes/extension-api'
import { createFeedbackService } from '@agnes/host'
import { rpcError, type Actor, type EventEnvelope } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { feedbackPorts } from '../src/supervisor/feedback-ports.js'

const actor: Actor = { id: 'owner', org: 'fixture', role: 'admin', deptPath: [], attrs: {} }
const authority: PackageAdminAuthority = {
  audience: 'admin',
  principalId: 'owner',
  clientId: 'fixture',
  permissions: ['packages.activate'],
}

async function fixture() {
  const endpoint = new LocalEndpoint({ clock: Date.now, principalId: 'owner' })
  const context: CallContext = { conn: endpoint.conn, clock: Date.now, signal: new AbortController().signal }
  const rows: EventEnvelope[] = []
  let permitted = true,
    currentActor = actor
  let readGate: (() => Promise<void>) | undefined
  const make = () =>
    feedbackPorts({
      context,
      profile: 'fixture',
      authority,
      packages: {} as PackageAdminService,
      ids: ['s'],
      async authorize(id) {
        if (!permitted || id !== 's') throw rpcError('CAPABILITY_DENIED')
        return currentActor
      },
      async scan(id, types) {
        if (id !== 's') throw rpcError('CAPABILITY_DENIED')
        await readGate?.()
        return rows.filter((row) => types.includes(row.type))
      },
      session: () => ({
        async append(tx) {
          const seqs: number[] = []
          for (const input of tx) {
            const seq = rows.length + 1
            rows.push({
              id: `host-event-${seq}`,
              v: 1,
              seq,
              ts: new Date(0).toISOString(),
              ...structuredClone(input as Record<string, unknown>),
            } as EventEnvelope)
            seqs.push(seq)
          }
          return { seqs }
        },
        draftFeedback: async () => [],
      }),
    })
  const item = (id: string) => ({
    id,
    sessionId: 's',
    target: { messageSeq: null, turn: null },
    rating: 'up',
    category: '',
    note: '',
    actor: actor.id,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    withdrawn: false,
    candidateId: null,
    candidateHash: null,
  })
  return {
    endpoint,
    rows,
    make,
    item,
    revoke: () => {
      permitted = false
    },
    changeActor: (next: Actor) => {
      currentActor = next
    },
    gate: (next: () => Promise<void>) => {
      readGate = next
    },
  }
}

it.each(['type', 'actor', 'payload-actor', 'id', 'event-id', 'session', 'growth-id'])(
  'refuses a replacement provider forging %s without writing a ledger fact',
  async (forgery) => {
    const f = await fixture()
    try {
      const ports = f.make(),
        value = f.item(ports.id())
      let type = FEEDBACK_EVENT,
        claimedActor = actor,
        id = 's',
        data: Record<string, unknown> = value
      if (forgery === 'type') type = 'effect/settled'
      if (forgery === 'actor') claimedActor = { ...actor, id: 'admin-victim' }
      if (forgery === 'payload-actor') data = { ...value, actor: 'admin-victim' }
      if (forgery === 'id') data = { ...value, id: 'provider-selected-id' }
      if (forgery === 'event-id') data = { ...value, eventId: 'provider-selected-event' }
      if (forgery === 'session') id = 'foreign'
      if (forgery === 'growth-id') {
        type = FEEDBACK_GROWTH_EVENT
        data = {
          feedbackId: 'forged',
          feedbackRevision: 1,
          messageSeq: 3,
          candidateId: 'candidate',
          candidateHash: 'hash',
        }
      }
      await expect(ports.append(id, type, data, claimedActor)).rejects.toMatchObject({
        data: { code: 'CAPABILITY_DENIED' },
      })
      expect(f.rows).toEqual([])
    } finally {
      await f.endpoint.close()
    }
  },
)

it('preserves default feedback creation, withdrawal and revision after recreating the ports', async () => {
  const f = await fixture(),
    signal = new AbortController().signal
  try {
    const first = await createFeedbackService(f.make()).execute(
      {
        action: 'put',
        sessionId: 's',
        expectedRevision: null,
        target: { messageSeq: null, turn: null },
        rating: 'up',
      },
      actor,
      signal,
    )
    const item = first.items[0]!
    expect(item.id).toMatch(/^[a-f0-9-]{36}$/)
    expect(f.rows[0]).toMatchObject({ id: 'host-event-1', type: FEEDBACK_EVENT, actor })
    const second = await createFeedbackService(f.make()).execute(
      {
        action: 'withdraw',
        sessionId: 's',
        id: item.id,
        expectedRevision: item.revision,
      },
      actor,
      signal,
    )
    expect(second.items[0]).toMatchObject({ id: item.id, revision: 2, withdrawn: true })
    expect(f.rows[1]).toMatchObject({ id: 'host-event-2', actor })
  } finally {
    await f.endpoint.close()
  }
})

it('re-checks ownership and actor on every append, including after an awaited read', async () => {
  for (const change of ['between-appends', 'during-read', 'actor-during-read'] as const) {
    const f = await fixture()
    try {
      const ports = f.make(),
        value = f.item(ports.id())
      if (change === 'between-appends') {
        await ports.append('s', FEEDBACK_EVENT, value, actor)
        f.revoke()
      } else
        f.gate(async () => {
          if (change === 'actor-during-read') f.changeActor({ ...actor, org: 'different' })
          else f.revoke()
        })
      const before = structuredClone(f.rows)
      await expect(ports.append('s', FEEDBACK_EVENT, value, actor)).rejects.toMatchObject({
        data: { code: 'CAPABILITY_DENIED' },
      })
      expect(f.rows).toEqual(before)
    } finally {
      await f.endpoint.close()
    }
  }
})

it('accepts a growth link only for the same authenticated item revision and message', async () => {
  const f = await fixture()
  try {
    const ports = f.make(),
      value = { ...f.item(ports.id()), target: { messageSeq: 3, turn: 1 } }
    const revision = await ports.append('s', FEEDBACK_EVENT, value, actor)
    const growth = {
      feedbackId: value.id,
      feedbackRevision: revision,
      messageSeq: 3,
      candidateId: 'candidate',
      candidateHash: 'hash',
    }
    await f.make().append('s', FEEDBACK_GROWTH_EVENT, growth, actor)
    expect(f.rows[1]).toMatchObject({ id: 'host-event-2', type: FEEDBACK_GROWTH_EVENT, actor, data: growth })
    for (const forged of [
      { ...growth, feedbackRevision: 2 },
      { ...growth, messageSeq: 4 },
      { ...growth, id: 'forged-event' },
    ]) {
      await expect(f.make().append('s', FEEDBACK_GROWTH_EVENT, forged, actor)).rejects.toMatchObject({
        data: { code: 'CAPABILITY_DENIED' },
      })
      expect(f.rows).toHaveLength(2)
    }
  } finally {
    await f.endpoint.close()
  }
})
