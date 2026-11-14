import type { Event } from '@agnes/core-common/types'
import { validateAgainst } from '@agnes/protocol'
import { UITimeline } from '@agnes/protocol/gen/agnes-v1'
import { expect, it } from 'vitest'
import { projectUI } from '../../src/project/ui.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }

const item = (itemId: string, text: string, extra: Record<string, unknown> = {}) => ({
  itemId,
  target: 'next-turn',
  content: [{ type: 'text', text }],
  actor,
  enqueuedAt: '2026-11-14T00:00:00Z',
  kind: 'follow_up',
  origin: 'principal',
  ...extra,
})

const inbox = (seq: number, items: unknown[]): Event =>
  ({
    seq,
    ts: '2026-11-14T00:00:00Z',
    id: `01J6ZM2Q3R4S5T6V7W8X9Y0Z${String(seq).padStart(2, '0')}`,
    type: 'inbox',
    register: 'inbox',
    data: { items },
    actor,
    origin: 'system',
    trust: 'trusted',
    lane: 'main',
    v: 1,
  }) as Event

it('carries the delivering commandId on a pending input and omits it when the input had none', async () => {
  const timeline = await projectUI(
    [
      inbox(1, [
        item('i1', 'first', { commandId: 'superagent:m1', admissionId: 'a1' }),
        item('i2', 'second', { admissionId: 'a2' }),
      ]),
    ],
    { sessionKey: 'k' },
  )
  expect(timeline.pendingInputs).toEqual([
    { itemId: 'i1', preview: 'first', commandId: 'superagent:m1' },
    { itemId: 'i2', preview: 'second' },
  ])
  expect(timeline.pendingInputs?.[1]).not.toHaveProperty('commandId')
  expect(validateAgainst(UITimeline, { ...timeline, generation: 1 }).ok).toBe(true)
})
