/** Source message links and the candidate card the main session reads. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { TextCache } from '../src/app/cache.js'
import { candidateCard, type LinkHost, repliedTo, sourceLink } from '../src/app/links.js'
import { openStore, type Store } from '../src/app/store.js'
import type { Candidate, Ticket, Trigger } from '../src/core/index.js'
import type { Commands } from '../src/infra/commands.js'
import { githubKind } from '../src/sources/github.js'
import { SourceRegistry } from '../src/sources/registry.js'

let directory: string
let store: Store
let host: LinkHost
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'links-'))
  store = openStore(join(directory, 'orchestrator.sqlite'))
  const sources = new SourceRegistry(() => store.settings())
  sources.register(githubKind)
  host = {
    store,
    links: new TextCache(1000),
    commands: {} as Commands,
    sources,
    lifetime: new AbortController().signal,
  }
})
afterEach(() => {
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

const at = '2026-11-01T00:00:00.000Z'
const trigger = (id: string, fields: Partial<Trigger> = {}): Trigger => ({
  id,
  source: 'github',
  threads: [{ source: 'github', id: '7' }],
  actor: { source: 'github', id: 'alice' },
  human: true,
  at,
  text: `text of ${id}`,
  meta: {},
  ...fields,
})
const ticket = (id: string, fields: Partial<Ticket> = {}): Ticket => ({
  id,
  title: id,
  decisionId: 'd',
  mandate: {
    strength: 'explicit',
    policyVersion: '1',
    basis: { via: 'listed' },
    actor: { source: 'github', id: 'alice' },
    scope: '',
  },
  channels: [],
  assignments: [],
  inputs: [],
  undelivered: [],
  createdAt: at,
  updatedAt: at,
  origin: { triggerId: 'o', triggerIds: ['o'] },
  ...fields,
})

it('links a trigger to the page its Source named, and to nothing for a Source with no link to look up', async () => {
  expect(
    await sourceLink(host, trigger('a', { url: 'https://github.com/acme/widgets/issues/7#c1' })),
  ).toEqual({
    source_url: 'https://github.com/acme/widgets/issues/7#c1',
  })
  expect(await sourceLink(host, trigger('b'))).toEqual({})
})

it('reads the trigger a message answers from the store, where its Source can say which it is', () => {
  const parent = trigger('parent')
  store.triggers.save(parent)
  const answering = trigger('child')
  // GitHub names no parent without a network read.
  expect(repliedTo(host, answering)).toBeUndefined()
  expect(repliedTo({ store, sources: { repliesTo: () => 'parent' } }, answering)).toEqual(parent)
  expect(repliedTo({ store, sources: { repliesTo: () => 'archived' } }, answering)).toBeUndefined()
})

it('builds the candidate card with its batch, what was handed back, and the tickets it relates to', async () => {
  const candidate: Candidate = {
    evalId: 'e1',
    thread: {
      key: 'github:7',
      ref: { source: 'github', id: '7' },
      createdAt: at,
      subscriptions: [],
      correlated: [],
      pending: [],
      meta: {},
    },
    triggers: [trigger('first'), trigger('second', { url: 'https://github.com/acme/widgets/issues/7#c2' })],
    strength: 'explicit',
    policyVersion: '1',
    tickets: [ticket('old', { ended: { at, by: 'executor', reason: 'merged', outcome: 'merged' } })],
  }
  store.triggers.saveDisposition('second', {
    fanout: ['t-live'],
    at,
    handbacks: [{ ticketId: 't-live', reason: 'Another request', at }],
  })
  const card = await candidateCard(host, candidate)
  expect(card).toMatchObject({
    trigger_id: 'second',
    source_url: 'https://github.com/acme/widgets/issues/7#c2',
    strength: 'explicit',
    mode: store.settings().eval.mode,
    batch: [expect.objectContaining({ trigger_id: 'first' })],
    handed_back: [{ trigger_id: 'second', ticket_id: 't-live', reason: 'Another request' }],
    delivered_to: ['t-live'],
    tickets_total: 1,
    related_tickets: [expect.objectContaining({ ticket_id: 'old', state: 'merged' })],
  })
  expect(card.next_action).toContain('orchestrator_route')
  expect(await candidateCard(host, { ...candidate, strength: 'inferred' })).toMatchObject({
    next_action: expect.stringContaining('orchestrator_eval'),
  })
})

it('refers a candidate to the live tickets its text names, apart from the ones it already relates to', async () => {
  store.threads.save({
    key: 'github:12',
    ref: { source: 'github', id: '12' },
    createdAt: at,
    subscriptions: ['t-12', 't-known'],
    correlated: [],
    pending: [],
    meta: {},
  })
  store.tickets.save(ticket('t-12'))
  store.tickets.save(ticket('t-known'))
  const candidate: Candidate = {
    evalId: 'e2',
    thread: {
      key: 'github:7',
      ref: { source: 'github', id: '7' },
      createdAt: at,
      subscriptions: [],
      correlated: [],
      pending: [],
      meta: {},
    },
    triggers: [trigger('ref', { text: 'This continues #12' })],
    strength: 'explicit',
    policyVersion: '1',
    tickets: [ticket('t-known')],
  }
  const card = await candidateCard(host, candidate)
  expect(card.referenced_tickets).toEqual([expect.objectContaining({ ticket_id: 't-12' })])
})
