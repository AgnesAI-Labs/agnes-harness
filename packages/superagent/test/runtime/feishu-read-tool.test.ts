// The worker tool orchestrator_feishu_read: it reads messages of its own ticket's chats by id and its own ticket's
// topics, through the scoped bot CLI, and refuses anything else with isError.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Store } from '../../src/app/store.js'
import type { Ticket } from '../../src/core/index.js'
import { feishuReadTool, ticketChats } from '../../src/runtime/feishu-read-tool.js'
import {
  FEISHU_READ,
  handleTool,
  type ToolsHost,
  toolCatalog,
  toolParameters,
} from '../../src/runtime/tools.js'
import { messageTrigger } from '../../src/sources/feishu.js'
import { bound, fakeCli, message } from '../sources/fake-cli.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})
const ticket = (id: string, triggerIds: string[]): Ticket => ({
  id,
  title: id,
  decisionId: `d-${id}`,
  mandate: {
    strength: 'explicit',
    policyVersion: '',
    basis: { via: 'listed' },
    actor: { source: 'feishu', id: 'ou_alice' },
    scope: '',
  },
  channels: [],
  assignments: [{ id: 'a1', state: 'running', createdAt: '' }],
  inputs: [],
  undelivered: [],
  createdAt: '',
  updatedAt: '',
  origin: { triggerId: triggerIds[0]!, triggerIds },
})

/** A worker of ticket `t1`, which came from a topic of oc_team; oc_other holds another ticket's topic. */
function setup(fake = defaultChannels()) {
  const directory = mkdtempSync(join(tmpdir(), 'feishu-read-tool-'))
  const store = new Store(join(directory, 'db.sqlite'))
  cleanups.push(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const request = messageTrigger(message('om_1', { thread: 'omt_1', mentioned: true }), 'om_1')!
  const elsewhere = messageTrigger(message('om_x', { chat: 'oc_other', thread: 'omt_x' }), 'om_x')!
  bound(request)
  bound(elsewhere)
  store.triggers.save(request)
  store.triggers.save(elsewhere)
  for (const [trigger, owner] of [
    [request, 't1'],
    [elsewhere, 't2'],
  ] as const)
    store.threads.save({
      key: `feishu:${trigger.threads[0]!.id}`,
      ref: trigger.threads[0]!,
      createdAt: '',
      subscriptions: [owner],
      correlated: [],
      pending: [],
      meta: { threadId: trigger.meta.threadId },
    })
  const t1 = ticket('t1', [request.id])
  store.tickets.save(t1)
  store.tickets.save(ticket('t2', [elsewhere.id]))
  const tool = feishuReadTool({ store, io: (signal) => ({ ...fake.io, signal }) }, t1)
  const host: ToolsHost = {
    registry: { owner: () => ({ role: { kind: 'worker', ticketId: 't1' }, child: false }) as never },
    store,
    main: undefined as never,
    executor: undefined as never,
    unavailable: () => undefined,
    extra: (current) => (current.id === 't1' ? [tool] : []),
  }
  const call = (input: unknown) =>
    handleTool(host, {
      sessionId: 'superagent:worker:t1',
      toolName: 'orchestrator_feishu_read',
      input,
      signal: new AbortController().signal,
    })
  return { store, t1, fake, call }
}
function defaultChannels() {
  return fakeCli({
    history: [
      message('om_1', { thread: 'omt_1', at: '2026-11-14T08:00:00.000Z', mentioned: true }),
      message('om_2', { thread: 'omt_1', at: '2026-11-14T08:01:00.000Z', text: 'second', quoted: 'om_1' }),
      message('om_q', { at: '2026-11-14T07:00:00.000Z', text: 'quoted earlier' }),
      message('om_x', { chat: 'oc_other', thread: 'omt_x' }),
    ],
  })
}
const json = (answer: { content: { type: string; text?: string }[] }) =>
  JSON.parse((answer.content[0] as { text: string }).text)

it('reads messages of its own chats by id and its own topic, oldest or newest first', async () => {
  const { call, fake } = setup()
  const byId = await call({ chat_id: 'oc_team', message_ids: ['om_q', 'om_missing'] })
  expect(byId.isError).toBeUndefined()
  expect(json(byId)).toEqual({
    messages: [{ id: 'om_q', from: 'ou_alice', at: '2026-11-14T07:00:00.000Z', text: 'quoted earlier' }],
    missing: ['om_missing'],
  })
  const topic = await call({ chat_id: 'oc_team', thread_id: 'omt_1', order: 'desc', limit: 5 })
  expect(json(topic)).toMatchObject({
    thread_id: 'omt_1',
    messages: [{ id: 'om_2', reply_to: 'om_1' }, { id: 'om_1' }],
  })
  // Its topic by its first message as well.
  expect((await call({ chat_id: 'oc_team', thread_id: 'om_1' })).isError).toBeUndefined()
})

it("refuses another ticket's chat or topic, a topic it does not follow, and a read that is neither or both", async () => {
  const { call, fake, store, t1 } = setup()
  expect(ticketChats(store, t1)).toEqual(
    new Map([
      [
        'oc_team',
        new Map([
          ['omt_1', 'omt_1'],
          ['om_1', 'omt_1'],
        ]),
      ],
    ]),
  )
  const refused = async (input: unknown, reason: string) => {
    const answer = await call(input)
    expect(answer.isError).toBe(true)
    expect((answer.content[0] as { text: string }).text).toContain(reason)
  }
  await refused({ chat_id: 'oc_other', message_ids: ['om_x'] }, "not one of this ticket's chats")
  await refused({ chat_id: 'oc_other', thread_id: 'omt_x' }, "not one of this ticket's chats")
  await refused({ chat_id: 'oc_team', thread_id: 'omt_x' }, "not one of this ticket's topics")
  await refused({ chat_id: 'oc_team' }, 'Give either message_ids or thread_id')
  await refused({ chat_id: 'oc_team', message_ids: ['om_1'], thread_id: 'omt_1' }, 'Give either')
  await refused({ chat_id: 'oc_team', message_ids: ['../etc'] }, 'Invalid input')
  // A message the channel reports in another chat is refused, never shown.
  fake.state.history = [message('om_x', { chat: 'oc_other' })]
  await refused({ chat_id: 'oc_team', message_ids: ['om_x'] }, 'outside the requested chat')
  expect(fake.calls.filter((args) => args[1] === '+threads-messages-list')).toEqual([])
})

it('refuses old or different bot work before invoking the CLI', async () => {
  const { call, store, t1, fake } = setup()
  const trigger = store.triggers.get(t1.origin.triggerId)!
  trigger.meta.botIdentity = 'feishu:cli_other:ou_other'
  store.triggers.save(trigger)
  expect((await call({ chat_id: 'oc_team', message_ids: ['om_q'] })).isError).toBe(true)
  expect(fake.calls).toEqual([])
})

it('declares the real input schema to the model, and only the tool of a ticket runs it', () => {
  const declared = toolCatalog().find((tool) => tool.name === 'orchestrator_feishu_read')!
  expect(declared).toBe(FEISHU_READ)
  expect(toolParameters(declared.schema)).toMatchObject({
    type: 'object',
    properties: {
      chat_id: { type: 'string' },
      message_ids: { type: 'array' },
      thread_id: { type: 'string' },
    },
    additionalProperties: false,
  })
})
