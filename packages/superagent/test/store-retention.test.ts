import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openStore, type Store } from '../src/app/store.js'
import { ARCHIVE_AFTER_MS, archiveExpired } from '../src/app/store-retention.js'
import type { Decision, Thread, Ticket, Trigger } from '../src/core/index.js'

const DAY = 24 * 3600_000
const NOW = Date.parse('2026-11-14T00:00:00.000Z')
const ago = (days: number): string => new Date(NOW - days * DAY).toISOString()

let directory: string
let store: Store
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'store-retention-'))
  store = openStore(join(directory, 'orchestrator.sqlite'))
})
afterEach(() => {
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

const trigger = (id: string, thread: string, at: string): Trigger => ({
  id,
  source: 'github',
  threads: [{ source: 'github', id: thread }],
  actor: { source: 'github', id: 'alice' },
  human: true,
  at,
  text: id,
  meta: {},
})
const thread = (id: string, lastAt: string, fields: Partial<Thread> = {}): Thread => ({
  key: `github:${id}`,
  ref: { source: 'github', id },
  createdAt: lastAt,
  lastAt,
  subscriptions: [],
  correlated: [],
  pending: [],
  meta: {},
  ...fields,
})
const decision = (id: string, threadId: string, at: string, fields: Partial<Decision> = {}): Decision => ({
  id,
  evalId: `e-${id}`,
  threadKey: `github:${threadId}`,
  triggerIds: [],
  policyVersion: '1',
  at,
  kind: 'ignore',
  reason: [],
  strength: 'inferred',
  ...fields,
})
const ticket = (id: string, state: 'open' | 'ended', fields: Partial<Ticket> = {}): Ticket => ({
  id,
  title: id,
  decisionId: '',
  mandate: {
    strength: 'explicit',
    policyVersion: '',
    basis: { via: 'listed' },
    actor: { source: 'x', id: '' },
    scope: '',
  },
  channels: [],
  assignments: [],
  inputs: [],
  undelivered: [],
  createdAt: ago(40),
  updatedAt: ago(40),
  origin: { triggerId: '', triggerIds: [] },
  ...(state === 'ended'
    ? { ended: { at: ago(30), by: 'executor' as const, reason: 'closed', outcome: 'closed' as const } }
    : {}),
  ...fields,
})
/** An expired conversation: a quiet thread with one trigger and one decision, all older than the horizon. */
function seedExpired(id: string, days = 20): void {
  store.threads.save(thread(id, ago(days)))
  store.triggers.save(trigger(`t-${id}`, id, ago(days)))
  store.triggers.saveDisposition(`t-${id}`, { fanout: [], at: '' })
  store.decisions.save(decision(`d-${id}`, id, ago(days), { triggerIds: [`t-${id}`] }))
}
const left = () => ({
  threads: store.threads
    .list()
    .map((item) => item.key)
    .sort(),
  triggers: store.db
    .prepare('SELECT id FROM trigger ORDER BY id')
    .all()
    .map((row) => String(row.id)),
  decisions: store.db
    .prepare('SELECT id FROM decision ORDER BY id')
    .all()
    .map((row) => String(row.id)),
})

it('archives the thread, triggers and decisions of a conversation that ended more than 14 days ago', () => {
  expect(ARCHIVE_AFTER_MS).toBe(14 * DAY)
  seedExpired('1')
  expect(archiveExpired(store, NOW)).toEqual({ archived: 3 })
  expect(left()).toEqual({ threads: [], triggers: [], decisions: [] })
  // The rows move to the archive rather than vanishing.
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM thread_archive').get()?.n).toBe(1)
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM trigger_archive').get()?.n).toBe(1)
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM decision_archive').get()?.n).toBe(1)
  expect(store.triggers.disposition('t-1')).toBeUndefined()
  // A second run finds nothing more.
  expect(archiveExpired(store, NOW)).toEqual({ archived: 0 })
})

it('keeps what is 14 days old or newer', () => {
  seedExpired('recent', 13)
  expect(archiveExpired(store, NOW)).toEqual({ archived: 0 })
  expect(left().threads).toEqual(['github:recent'])
  // The boundary: exactly 14 days old is not yet past the horizon.
  seedExpired('edge', 14)
  expect(archiveExpired(store, NOW)).toEqual({ archived: 0 })
  // Each kind on its own: a thread and a decision, no trigger newer than the horizon to hold them.
  store.threads.save(thread('edge-thread', ago(14)))
  store.decisions.save(decision('d-edge-lonely', 'edge-lonely', ago(14)))
  expect(archiveExpired(store, NOW)).toEqual({ archived: 0 })
  store.threads.save(thread('past-thread', ago(14.001)))
  store.decisions.save(decision('d-past-lonely', 'past-lonely', ago(14.001)))
  expect(archiveExpired(store, NOW)).toEqual({ archived: 2 })
})

it('keeps a conversation whose thread is subscribed by an open ticket, with its triggers and decisions', () => {
  seedExpired('live')
  store.threads.save(thread('live', ago(20), { subscriptions: ['open-1'] }))
  store.tickets.save(ticket('open-1', 'open'))
  expect(archiveExpired(store, NOW)).toEqual({ archived: 0 })
  expect(left()).toEqual({ threads: ['github:live'], triggers: ['t-live'], decisions: ['d-live'] })
})

it('keeps an old decision with the live thread it was made on, even when it names no trigger', () => {
  store.threads.save(thread('busy', ago(20), { subscriptions: ['open-5'] }))
  store.tickets.save(ticket('open-5', 'open'))
  store.decisions.save(decision('d-solo', 'busy', ago(20)))
  expect(archiveExpired(store, NOW)).toEqual({ archived: 0 })
  expect(left().decisions).toEqual(['d-solo'])
})

it('keeps a conversation whose ticket ended only recently, and archives it once that ticket is past the horizon too', () => {
  seedExpired('wake')
  store.threads.save(thread('wake', ago(20), { subscriptions: ['done-1'] }))
  store.tickets.save(
    ticket('done-1', 'ended', { ended: { at: ago(3), by: 'executor', reason: 'closed', outcome: 'closed' } }),
  )
  expect(archiveExpired(store, NOW)).toEqual({ archived: 0 })
  store.tickets.save(ticket('done-1', 'ended'))
  expect(archiveExpired(store, NOW)).toEqual({ archived: 3 })
})

it('keeps a thread that still has queued triggers or an evaluation running', () => {
  // The queued ids name no stored trigger, so only the thread's own state can hold it.
  store.threads.save(thread('queued', ago(20), { pending: ['ghost-1'] }))
  store.threads.save(
    thread('evaluating', ago(20), {
      evaluating: {
        id: 'e',
        threadKey: 'github:evaluating',
        triggerIds: ['ghost-2'],
        strength: 'explicit',
        actor: { source: 'github', id: 'alice' },
        basis: { via: 'followup' },
        policyVersion: '',
        startedAt: '',
        deadline: '',
      },
    }),
  )
  expect(archiveExpired(store, NOW)).toEqual({ archived: 0 })
})

it('keeps the conversation of a trigger another thread has queued', () => {
  seedExpired('holds')
  store.threads.save(thread('queues-it', ago(20), { pending: ['t-holds'] }))
  expect(archiveExpired(store, NOW)).toEqual({ archived: 0 })
  expect(left().triggers).toEqual(['t-holds'])
})

it('keeps a trigger and decision an open ticket, a pending message or an effect refers to, and their thread with them', () => {
  seedExpired('by-ticket')
  store.tickets.save(
    ticket('open-2', 'open', { origin: { triggerId: 't-by-ticket', triggerIds: ['t-by-ticket'] } }),
  )
  seedExpired('by-decision')
  store.tickets.save(ticket('open-4', 'open', { decisionId: 'd-by-decision' }))
  seedExpired('by-outbox')
  store.receipts.add({
    id: 'm1',
    channel: { source: 'github', thread: 'by-outbox', address: {} },
    text: 'hi',
    kind: 'reply',
  })
  seedExpired('by-effect')
  store.db
    .prepare('INSERT INTO effect (kind, key, value, seq, due, since) VALUES (?,?,?,?,?,?)')
    .run('assessment', 'e-d-by-effect', JSON.stringify({ triggerId: 't-by-effect' }), 1, 0, ago(1))
  seedExpired('free')
  expect(archiveExpired(store, NOW)).toEqual({ archived: 3 })
  expect(left()).toEqual({
    threads: ['github:by-decision', 'github:by-effect', 'github:by-outbox', 'github:by-ticket'],
    triggers: ['t-by-decision', 't-by-effect', 't-by-outbox', 't-by-ticket'],
    decisions: ['d-by-decision', 'd-by-effect', 'd-by-outbox', 'd-by-ticket'],
  })
})

it('releases a message once it went out: a sent receipt no longer pins its conversation', () => {
  seedExpired('sent')
  const message = {
    id: 'm2',
    channel: { source: 'github', thread: 'sent', address: {} },
    text: 'hi',
    kind: 'reply' as const,
  }
  store.receipts.add(message)
  expect(archiveExpired(store, NOW)).toEqual({ archived: 0 })
  store.receipts.settle(message, 'sent')
  expect(archiveExpired(store, NOW)).toEqual({ archived: 3 })
})

it('keeps every thread a shared trigger belongs to when one of them is live', () => {
  store.threads.save(thread('a', ago(20)))
  store.threads.save(thread('b', ago(20), { subscriptions: ['open-3'] }))
  store.tickets.save(ticket('open-3', 'open'))
  store.triggers.save({
    ...trigger('shared', 'a', ago(20)),
    threads: [
      { source: 'github', id: 'a' },
      { source: 'github', id: 'b' },
    ],
  })
  expect(archiveExpired(store, NOW)).toEqual({ archived: 0 })
  expect(left().threads).toEqual(['github:a', 'github:b'])
})

it('keeps a thread that a newer trigger reached, even when the thread record carries no activity time', () => {
  store.threads.save(thread('busy', ago(20)))
  store.triggers.save(trigger('old', 'busy', ago(20)))
  store.triggers.save(trigger('new', 'busy', ago(1)))
  expect(archiveExpired(store, NOW)).toEqual({ archived: 0 })
})
