/** Views over a ticket that ended long ago, whose threads, triggers and decisions `archiveExpired` has moved away. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { followupNotice } from '../src/app/notices.js'
import { openStore, type Store } from '../src/app/store.js'
import { archiveExpired } from '../src/app/store-retention.js'
import { overview } from '../src/app/views/overview.js'
import { snapshot, ticketSummary, triggerView } from '../src/app/views/records.js'
import { decisionList, search, threadDetail, threadList } from '../src/app/views/threads.js'
import { ticketDetail, ticketList } from '../src/app/views/tickets.js'
import type { Decision, Thread, Ticket, Trigger } from '../src/core/index.js'
import { githubKind } from '../src/sources/github.js'
import { SourceRegistry } from '../src/sources/registry.js'

const DAY = 24 * 3600_000
const NOW = Date.parse('2026-11-14T00:00:00.000Z')
const ago = (days: number): string => new Date(NOW - days * DAY).toISOString()

let directory: string
let store: Store
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'archived-views-'))
  store = openStore(join(directory, 'orchestrator.sqlite'))
})
afterEach(() => {
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

const trigger = (id: string): Trigger => ({
  id,
  source: 'github',
  threads: [{ source: 'github', id: '7' }],
  actor: { source: 'github', id: 'alice' },
  human: true,
  at: ago(30),
  text: `text of ${id}`,
  meta: {},
})
const thread: Thread = {
  key: 'github:7',
  ref: { source: 'github', id: '7' },
  createdAt: ago(30),
  lastAt: ago(30),
  subscriptions: ['ended-1'],
  correlated: [],
  pending: [],
  meta: {},
}
const decision: Decision = {
  id: 'd-7',
  evalId: 'e-7',
  threadKey: 'github:7',
  triggerIds: ['t-origin'],
  policyVersion: '1',
  at: ago(30),
  kind: 'accept',
  reason: [],
  strength: 'explicit',
  ticketId: 'ended-1',
}
const ended: Ticket = {
  id: 'ended-1',
  title: 'Fix the copy',
  decisionId: 'd-7',
  mandate: {
    strength: 'explicit',
    policyVersion: '1',
    basis: { via: 'listed' },
    actor: { source: 'github', id: 'alice' },
    scope: 'copy',
  },
  channels: [{ source: 'github', thread: 'github:7', address: { number: '7' } }],
  assignments: [{ id: 'a1', state: 'ended', createdAt: ago(30), startedAt: ago(30), endedAt: ago(20) }],
  inputs: [{ id: 'i1', kind: 'trigger', triggerId: 't-follow', at: ago(30) }],
  undelivered: [],
  createdAt: ago(30),
  updatedAt: ago(20),
  origin: { triggerId: 't-origin', triggerIds: ['t-origin'] },
  ended: { at: ago(20), by: 'executor', reason: 'merged', outcome: 'merged' },
}
/** The ended ticket with the conversation it came from, then archived as the daily run does. */
function seedArchived(): void {
  store.threads.save(thread)
  for (const id of ['t-origin', 't-follow']) {
    store.triggers.save(trigger(id))
    store.triggers.saveDisposition(id, { fanout: ['ended-1'], at: ago(30) })
  }
  store.decisions.save({ ...decision, triggerIds: ['t-origin', 't-follow'] })
  store.tickets.save(ended)
  expect(archiveExpired(store, NOW).archived).toBe(4)
}
function host() {
  const sources = new SourceRegistry(() => store.settings())
  sources.register(githubKind)
  return { store, sources, links: () => ({ url: '', label: { zh: '', en: '' } }) }
}

it('shows an ended ticket whose triggers and decision were archived, marking what is gone', () => {
  seedArchived()
  expect(store.triggers.get('t-origin')).toBeUndefined()
  expect(store.decisions.get('d-7')).toBeUndefined()
  const detail = ticketDetail(host(), 'ended-1')
  expect(detail).toMatchObject({ id: 'ended-1', state: 'ended', decision: undefined, decisionArchived: true })
  expect(detail?.inputs).toEqual([expect.objectContaining({ id: 'i1', archived: true })])
  expect(detail?.inputs[0]).not.toHaveProperty('trigger')
  expect(detail?.threads).toEqual([])
  const view = snapshot(host())
  expect(ticketSummary(ended)).toMatchObject({ id: 'ended-1', state: 'ended' })
  expect(ticketList(host(), 'ended', 0, 10).items.map((row) => row.id)).toEqual(['ended-1'])
  expect(view.store.tickets.get('ended-1')).toBeDefined()
})

it('lists and searches around archived rows without failing, and reads an archived thread as absent', () => {
  seedArchived()
  expect(threadList(host(), 'all', 0, 10).items).toEqual([])
  expect(threadDetail(host(), 'github:7', undefined, 20)).toBeUndefined()
  expect(decisionList(host(), [], 0, 10).items).toEqual([])
  expect(() => search(host(), 'text of', { entries: () => [][Symbol.iterator]() })).not.toThrow()
  const health = { runtime: { state: 'ready' as const, detail: '' } }
  expect(() => overview(host(), health, 'v1', { running: 0, queued: 0 })).not.toThrow()
})

it('words nothing for a trigger or a decision the live store no longer holds', () => {
  seedArchived()
  expect(followupNotice(store, host().sources, 't-follow')).toBeUndefined()
  // A trigger view of a row read before it was archived still renders without its thread or decision.
  expect(() => triggerView(snapshot(host()), trigger('t-follow'))).not.toThrow()
  expect(triggerView(snapshot(host()), trigger('t-follow'))).toMatchObject({
    id: 't-follow',
    disposition: { decision: undefined },
  })
})
