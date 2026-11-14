/** What the main session is told: notices of saved settings and prompts, ended tickets, follow-ups and worker reports. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  changedPaths,
  eventNotice,
  followupNotice,
  followupRelay,
  promptsNotice,
  reportRelay,
  resultRelay,
  settingsNotice,
  subscriptionNotice,
} from '../src/app/notices.js'
import { openStore, type Store } from '../src/app/store.js'
import type { Thread, Ticket, Trigger } from '../src/core/index.js'
import { githubKind } from '../src/sources/github.js'
import { SourceRegistry } from '../src/sources/registry.js'

let directory: string
let store: Store
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'notices-'))
  store = openStore(join(directory, 'orchestrator.sqlite'))
})
afterEach(() => {
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

const at = '2026-11-01T00:00:00.000Z'
const ticket = (fields: Partial<Ticket> = {}): Ticket => ({
  id: 't1',
  title: 'Fix the copy',
  decisionId: 'd1',
  mandate: {
    strength: 'explicit',
    policyVersion: '1',
    basis: { via: 'listed' },
    actor: { source: 'github', id: 'alice' },
    scope: 'copy',
  },
  channels: [],
  assignments: [{ id: 'a1', state: 'running', createdAt: at, startedAt: at }],
  inputs: [],
  undelivered: [],
  createdAt: at,
  updatedAt: at,
  origin: { triggerId: 'origin', triggerIds: ['origin'] },
  ...fields,
})
const comment = (id: string, text: string, fields: Partial<Trigger> = {}): Trigger => ({
  id,
  source: 'github',
  threads: [{ source: 'github', id: '7' }],
  actor: { source: 'github', id: 'alice' },
  human: true,
  at,
  text,
  meta: {},
  ...fields,
})

it('names a notice of a saved prompt revision or a saved settings block, and the paths that changed', () => {
  expect(promptsNotice(4)).toEqual([
    'prompts',
    { prompt_config_saved: 4, effect: 'next-request', read: 'prompts/4' },
    'Prompt configuration saved (revision 4)',
  ])
  expect(settingsNotice('eval', ['eval.mode'])).toEqual([
    'settings:eval',
    { settings_saved: 'eval', changed: ['eval.mode'], read: 'settings/eval' },
    'Settings saved: eval',
  ])
  expect(settingsNotice()).toEqual(['settings', { settings_saved: true, read: 'settings' }, 'Settings saved'])
  expect(
    changedPaths(
      { eval: { mode: 'auto', n: 1 }, rules: [{ on: true }] },
      { eval: { mode: 'off', n: 1 }, rules: [{ on: false }] },
    ),
  ).toEqual(['eval.mode', 'rules.0.on'])
  expect(changedPaths({ a: 1 }, { a: 1 })).toEqual([])
  const wide = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]))
  expect(changedPaths({}, wide)).toHaveLength(20)
})

it('turns an event the main session did not cause into a notice, and nothing for the rest', () => {
  const ended = eventNotice(
    {
      type: 'ticket.ended',
      at,
      data: { ticketId: 't1', by: 'executor', outcome: 'merged', reason: 'PR merged' },
    },
    (id) => (id === 't1' ? ticket() : undefined),
  )
  expect(ended?.[1]).toMatchObject({ ticket_ended: { ticket_id: 't1' } })
  expect(ended?.[2]).toBe('Ticket t1 ended (PR merged)')
  // A ticket the store no longer has is named by the event alone.
  expect(
    eventNotice({
      type: 'ticket.ended',
      at,
      data: { ticketId: 'gone', by: 'human', outcome: 'stopped' },
    })?.[1],
  ).toEqual({ ticket_ended: 'gone', by: 'human', outcome: 'stopped', reason: 'stopped', at })
  expect(eventNotice({ type: 'trigger.requeued', at, data: { triggerId: 'x' } })?.[1]).toMatchObject({
    trigger_requeued: 'x',
    read: 'trigger/x',
  })
  expect(
    eventNotice({
      type: 'thread.unsubscribed',
      at,
      data: { threadKey: 'github:7', ticketId: 't1', by: 'person' },
    }),
  ).toEqual(subscriptionNotice('github:7', at))
  expect(
    eventNotice({
      type: 'thread.unsubscribed',
      at,
      data: { threadKey: 'github:7', ticketId: 't1', by: 'executor', reason: 'unrelated' },
    })?.[2],
  ).toBe('Ticket t1 no longer follows thread github:7: unrelated')
  // Every receipt gets its own name, so two ended tickets do not coalesce.
  const again = eventNotice({ type: 'trigger.requeued', at, data: { triggerId: 'x' } })
  expect(again?.[0]).not.toBe(eventNotice({ type: 'trigger.requeued', at, data: { triggerId: 'x' } })?.[0])
  expect(eventNotice({ type: 'ticket.created', at, data: { ticketId: 't1' } } as never)).toBeUndefined()
})

it('relays a worker report once, shortens a long summary behind its resource, and keeps routine progress inside', () => {
  const long = 'x'.repeat(700)
  const relay = resultRelay(ticket(), 'ready', long)
  expect(JSON.parse(relay.text)).toMatchObject({
    kind: 'worker_report',
    state: 'ready',
    summary: 'x'.repeat(600),
    chars: 700,
    read: 'ticket/t1/result',
  })
  expect(resultRelay(ticket(), 'ready', long).id).toBe(relay.id)
  expect(resultRelay(ticket(), 'ready', `${long}!`).id).not.toBe(relay.id)
  expect(reportRelay(ticket(), { state: 'progress', summary: 'working' })).toBeUndefined()
  expect(
    JSON.parse(reportRelay(ticket(), { state: 'progress', summary: 'answer', answers: 'q1' })!.text),
  ).toMatchObject({
    answer_to: 'q1',
  })
  const asking = ticket({ attention: { id: 'q9', question: 'Desktop too?' } })
  expect(
    reportRelay(asking, { state: 'blocked', summary: 'waiting', question: 'Desktop too?' }),
  ).toMatchObject({
    id: 'attention:t1:q9',
  })
  expect(
    JSON.parse(reportRelay(asking, { state: 'blocked', summary: 'waiting', question: 'Desktop too?' })!.text)
      .kind,
  ).toBe('worker_attention')
})

it("tells the main session of a follow-up that reached a live ticket, and of nothing the ticket's worker cannot decide", () => {
  const sources = new SourceRegistry(() => store.settings())
  sources.register(githubKind)
  const thread: Thread = {
    key: 'github:7',
    ref: { source: 'github', id: '7' },
    createdAt: at,
    subscriptions: ['t1'],
    correlated: [],
    pending: [],
    meta: {},
  }
  store.threads.save(thread)
  store.tickets.save(ticket())
  const message = comment('c1', 'also fix the title')
  store.triggers.save(message)
  // Without a disposition no ticket has the message.
  expect(followupNotice(store, sources, message.id)).toBeUndefined()
  store.triggers.saveDisposition(message.id, { fanout: ['t1'], at })
  const notice = followupNotice(store, sources, message.id)
  expect(notice?.id).toBe(`followup:${message.id}`)
  expect(JSON.parse(notice!.text)).toMatchObject({
    kind: 'follow_up',
    trigger_id: message.id,
    text: 'also fix the title',
    delivered_to: [{ ticket_id: 't1', title: 'Fix the copy', state: 'working' }],
  })
  expect(followupRelay({ trigger_id: 'x' }, []).id).toBe('followup:x')
  // A person who sent the message to Eval takes it from the worker.
  store.triggers.saveDisposition(message.id, { fanout: ['t1'], at, requeued: true })
  expect(followupNotice(store, sources, message.id)).toBeUndefined()
})
