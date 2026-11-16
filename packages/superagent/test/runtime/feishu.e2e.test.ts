// The Feishu Source on a real daemon: the shipped payload subscribes, through the bundled-app channels, to the group
// of a channel plugin that runs in the same daemon, takes a group @ message in as a ticket, replies under it, and wakes
// the ticket with a follow-up; a channel instance that is missing leaves the Source waiting for setup while GitHub
// polls on; and on a channel without reads (as the released Feishu plugin is) it runs live and says what it lacks.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { key } from '../../src/core/index.js'
import { stopAllDaemons } from '../fixtures/daemon-harness.js'
import {
  acceptRequest,
  type Bootstrapped,
  bootstrap,
  githubPolls,
  groupMessage,
  INSTANCE,
  reached,
  sleep,
  tool,
  until,
} from '../fixtures/feishu-world.js'

afterAll(stopAllDaemons)

it('waits for a missing channel instance while GitHub polls on, then takes a group @ message in, replies in its topic and wakes the ticket with a follow-up', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sa-feishu-e2e-')))
  let world: Bootstrapped | undefined
  try {
    world = await bootstrap(root, { reads: true, channel: 'feishu-absent' })
    const current = world
    // No such instance: setup is still required, and the Source retries; GitHub is not held up.
    const refused = await until('the setup-required report', () => current.feishuHealth().feishu)
    expect(refused).toMatchObject({ state: 'paused', code: 'feishuChannelRefused' })
    expect(refused.detail).toBe(
      'Setup required: the channel instance feishu-absent refused the chats (CHANNEL_UNAVAILABLE); retrying',
    )
    const polled = githubPolls(current)
    await until('GitHub polling on', () => githubPolls(current) > polled, 90_000)

    await current.reconfigure(INSTANCE)
    await until(
      'the subscription',
      () => current.feishuHealth().feishu?.detail === `Listening to 1 chats on ${INSTANCE}`,
    )
    // Every read is declared: no feature is reported missing.
    const health = await until('the feature report', () =>
      current.feishuHealth().reads?.state === 'ready' ? current.feishuHealth() : undefined,
    )
    expect(health.members).toMatchObject({ state: 'ready' })
    expect(health.history?.code).not.toBe('feishuNoHistory')

    current.chat.emit(
      groupMessage('om_1', { text: '@Superagent please fix the login page', mentioned: true }),
    )
    const ticketId = await acceptRequest(current)
    // The acknowledgement goes out once, under the request, in its topic, with its outgoing id as delivery key.
    const sent = await until('the acknowledgement', () =>
      current.chat.sent().length ? current.chat.sent() : undefined,
    )
    expect(sent).toHaveLength(1)
    expect(sent[0]!.target).toMatchObject({ chatType: 'group', chatId: 'oc_team', threadId: 'om_1' })
    expect(sent[0]!.target.deliveryKey).toMatch(/^[0-9a-f]{32}$/)
    expect(sent[0]!.message).toMatchObject({
      blocks: [{ kind: 'text', markdown: 'On it: fixing the login page.' }],
      replyTo: { chatId: 'oc_team', messageId: 'om_1' },
    })

    // A follow-up in the topic the reply opened reaches the same ticket.
    current.chat.emit(
      groupMessage('om_2', { text: 'also the header, please', thread: 'omt_1', quoted: 'om_1' }),
    )
    await until('the follow-up on the ticket', () => reached(current, 'om_2', ticketId))

    // The same message again, as a redelivery and then as history recovery reads it: taken in once, no new reply.
    current.chat.emit(
      groupMessage('om_1', {
        text: '@Superagent please fix the login page',
        mentioned: true,
        eventId: 'ev-again',
      }),
      false,
    )
    const emitted = Date.now()
    await until(
      'a history round over the messages',
      () =>
        current.chat
          .reads()
          .some(
            (read) =>
              read.method === 'listHistory' && Date.parse((read.args[1] as { end: string }).end) > emitted,
          ),
      100_000,
    )
    await sleep(2_000)
    expect(current.triggers().sort()).toEqual([key('feishu', 'om_1'), key('feishu', 'om_2')].sort())
    expect(current.chat.sent()).toHaveLength(1)
    expect(current.tickets()).toHaveLength(1)
  } catch (error) {
    throw new Error(`${String(error)}\n${(await world?.diagnostics()) ?? ''}`)
  } finally {
    await world?.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 420_000)

it('runs live on a channel without reads: says what it lacks, takes a request in, posts the reply and wakes the ticket with a quote', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sa-feishu-basic-e2e-')))
  let world: Bootstrapped | undefined
  try {
    world = await bootstrap(root, { reads: false, channel: INSTANCE })
    const current = world
    await until(
      'the subscription',
      () => current.feishuHealth().feishu?.detail === `Listening to 1 chats on ${INSTANCE}`,
    )
    const warnings = await until('the missing-feature warnings', () => {
      const health = current.feishuHealth()
      return health.history?.code === 'feishuNoHistory' &&
        health.members?.code === 'feishuNoMembers' &&
        health.reads?.code === 'feishuNoReads'
        ? health
        : undefined
    })
    expect(warnings.history?.detail).toContain('nothing is recovered after a restart or disconnect')
    expect(warnings.members?.detail).toContain('the allowlist in the settings applies')
    expect(warnings.reads?.detail).toContain('orchestrator_feishu_read')
    expect(warnings.feishu).toMatchObject({ state: 'ready' })

    current.chat.emit(
      groupMessage('om_1', { text: '@Superagent please fix the login page', mentioned: true }),
    )
    const ticketId = await acceptRequest(current)
    const sent = await until('the reply', () =>
      current.chat.sent().length ? current.chat.sent() : undefined,
    )
    expect(sent).toHaveLength(1)
    expect(sent[0]!.message).toMatchObject({ replyTo: { chatId: 'oc_team', messageId: 'om_1' } })

    // Without topics, a quote of the bot's reply joins the request's Thread and wakes the ticket.
    current.chat.emit(groupMessage('om_2', { text: 'and the header', quoted: sent[0]!.messageId }))
    await until('the quote on the ticket', () => reached(current, 'om_2', ticketId))

    // The worker's Feishu read answers isError with the reason, and the session goes on.
    const worker = await current.client().session.load(`superagent:worker:${ticketId}`, { history: 'none' })
    await until('the worker idle', async () => (await worker.projectUI()).opState === null)
    await worker.followUp(
      tool('fr', 'orchestrator_feishu_read', { chat_id: 'oc_team', message_ids: ['om_1'] }),
    )
    const read = await current.answered('fr')
    expect(read.toolResult).toContain('The Feishu channel does not support reading messages by id')
    // GitHub polls on beside it.
    const polled = githubPolls(current)
    await until('GitHub polling on', () => githubPolls(current) > polled, 90_000)
    expect(current.chat.reads()).toEqual([])
  } catch (error) {
    throw new Error(`${String(error)}\n${(await world?.diagnostics()) ?? ''}`)
  } finally {
    await world?.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 420_000)
