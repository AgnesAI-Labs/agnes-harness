// The Feishu Source on a real daemon: the shipped payload subscribes, through the bundled-app channels, to the group
// of a channel plugin that runs in the same daemon, takes a group @ message in as a ticket, replies under it, and wakes
// the ticket with a follow-up; a channel instance that is missing leaves the Source waiting for setup while GitHub
// polls on; and on a channel without reads (as the released Feishu plugin is) it runs live and says what it lacks.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { MessageEvent } from '@agnes/extension-api/channel-contract'
import { afterAll, expect, it } from 'vitest'
import { openStore } from '../../src/app/store.js'
import { key } from '../../src/core/index.js'
import { SettingsSchema } from '../../src/policy.js'
import { agentPaths } from '../../src/runtime/environment.js'
import { SERVICE_ID } from '../../src/runtime/index.js'
import { CHANNEL_PACKAGE, writeChannelPlugin } from '../fixtures/channel-plugin.js'
import { type DaemonHandle, startDaemon, stopAllDaemons } from '../fixtures/daemon-harness.js'
import { makeHomes } from '../fixtures/homes.js'

afterAll(stopAllDaemons)

const PROFILE = 'local-dev'
const PACKAGE = '@agnes/superagent'
const INSTANCE = 'feishu-test'
const EXTENSION = `plugin/${createHash('sha256').update('ext:agnes.superagent/main').digest('hex').slice(0, 16)}`
const STEP_MS = 120_000
/** The state directory the platform gives the service by default (see the bundled-app grant). */
const defaultStateDir = (aghHome: string) =>
  join(
    aghHome,
    'data',
    'bundled-apps',
    createHash('sha256').update(`${PROFILE}\0${PACKAGE}\0${SERVICE_ID}`).digest('hex').slice(0, 32),
  )
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until<T>(label: string, probe: () => T | Promise<T>, ms = STEP_MS): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await probe()
    if (value) return value as NonNullable<T>
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(200)
  }
}
const tool = (marker: string, name: string, args: unknown) =>
  `[[${marker} TOOL${JSON.stringify({ name, args })}ENDTOOL]]`
/** A group message of `oc_team` as the channel delivers it, sent now. */
const groupMessage = (
  id: string,
  fields: { text: string; mentioned?: boolean; thread?: string; quoted?: string; eventId?: string },
): MessageEvent => ({
  kind: 'message',
  eventId: fields.eventId ?? `ev-${id}`,
  accountId: 'cli_app',
  chat: { id: 'oc_team', type: 'group', ...(fields.thread ? { threadId: fields.thread } : {}) },
  sender: { userId: 'ou_alice', displayName: 'Alice', kind: 'user', raw: {} },
  at: new Date().toISOString(),
  messageId: id,
  text: fields.text,
  attachments: [],
  mentions: { bot: fields.mentioned ?? false, replyToBot: false, quoteBot: false },
  ...(fields.quoted ? { quotedMessageId: fields.quoted } : {}),
})

/** Writes Superagent's settings: GitHub on acme/app, the Feishu Source on `channel` with oc_team, Alice allowed. */
function configure(database: string, root: string, gh: string, channel: string) {
  const store = openStore(database)
  try {
    store.saveSettings(
      SettingsSchema.parse({
        sources: {
          github: { enabled: true, config: { repository: 'acme/app', cli: gh } },
          feishu: { enabled: true, config: { channel, chats: [{ chatId: 'oc_team', listen: 'mentions' }] } },
        },
        policy: { sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }] } } },
        executor: {
          prepare: 'git init -q repo && echo prepared > repo/PREPARED',
          directory: join(root, 'work'),
        },
      }),
    )
  } finally {
    store.close()
  }
}

/**
 * Starts a daemon with the shipped payload and the test channel plugin (instance `feishu-test`, with or without reads),
 * and configures Superagent on the Feishu channel instance `channel`.
 */
async function bootstrap(root: string, options: { reads: boolean; channel: string }) {
  let handle: DaemonHandle | undefined
  const homes = makeHomes(root)
  homes.writeGhScript({
    rules: [
      { args: ['api', 'user', '--jq', '.login'], stdout: 'agent-bot\n' },
      { args: ['api', 'user'], stdout: '{"login":"agent-bot","id":42}\n' },
      { args: ['api', 'repos/acme/app'], stdout: '{"name":"acme/app","push":true}\n' },
    ],
  })
  const aghHome = join(root, 'agh')
  // The daemon runs as the deployment guide starts it: the agent's HOME and shims in the state directory the platform
  // gives Superagent by default. The home is not created here; Superagent writes it when it starts.
  const agent = agentPaths(defaultStateDir(aghHome))
  const daemon = await startDaemon({
    aghHome,
    home: agent.home,
    path: `${agent.shimsDir}:${process.env.PATH ?? ''}`,
    plugins: ['./bundled-plugins/superagent'],
    onHandle: (started) => {
      handle = started
    },
  })
  const client = () => daemon.client
  const command = async (step: string) => ({
    profile: PROFILE,
    clientId: await client().clientId(),
    commandId: `feishu-e2e-${step}-${randomUUID()}`,
  })
  const operation = async (receipt: { profile: string; operationId: string }) =>
    until(`package ${receipt.operationId}`, async () => {
      const result = await client().packages.operation.get(receipt)
      if (['failed', 'cancelled', 'rolled-back'].includes(result.state))
        throw new Error(`package ${result.operation}: ${JSON.stringify(result.error)}`)
      return result.state === 'completed' ? result : undefined
    })
  // The channel plugin's instance routes sessions into a workspace the daemon knows.
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  await client().workspace.add(workspace)
  const chat = writeChannelPlugin(join(root, 'chat-plugin'), {
    instance: INSTANCE,
    workspace,
    reads: options.reads,
  })
  const source = { type: 'file' as const, ref: `file:${chat.directory}` }
  const preview = (
    await operation(await client().packages.inspect({ ...(await command('inspect')), source }))
  ).preview
  if (!preview?.capabilityHash) throw new Error('the channel plugin has no capability hash')
  expect(preview.blockers).toEqual([])
  await operation(
    await client().packages.install({
      ...(await command('install')),
      source,
      expectedIntegrity: preview.integrity,
    }),
  )
  await operation(
    await client().packages.trust({
      ...(await command('trust')),
      id: CHANNEL_PACKAGE,
      expectedIntegrity: preview.integrity,
      capabilityHash: preview.capabilityHash,
    }),
  )
  await operation(await client().packages.enable({ ...(await command('enable')), id: CHANNEL_PACKAGE }))

  const { dataDir } = JSON.parse(readFileSync(join(aghHome, 'daemon', 'discovery.json'), 'utf8')) as {
    dataDir: string
  }
  const apps = join(dataDir, 'bundled-apps')
  const stateDir = await until('the Superagent database', () => {
    const found = existsSync(apps)
      ? readdirSync(apps).filter((name) => existsSync(join(apps, name, 'superagent.sqlite')))
      : []
    return found.length === 1 ? join(apps, found[0]!) : undefined
  })
  expect(stateDir, "the agent's HOME lies in the state directory the platform gave").toBe(
    defaultStateDir(aghHome),
  )
  const database = join(stateDir, 'superagent.sqlite')
  /** Disables Superagent, writes its settings on `channel`, and enables it again. */
  const reconfigure = async (channel: string) => {
    await operation(await client().packages.disable({ ...(await command('disable')), id: PACKAGE }))
    configure(database, stateDir, join(homes.shimsDir, 'gh'), channel)
    await operation(await client().packages.enable({ ...(await command('enable')), id: PACKAGE }))
  }
  await reconfigure(options.channel)
  const query = <T>(sql: string, ...values: string[]): T[] => {
    const db = new DatabaseSync(database, { readOnly: true })
    try {
      return db.prepare(sql).all(...values) as T[]
    } finally {
      db.close()
    }
  }
  /** The Feishu Source's health entries as it last changed them, from its records. */
  const feishuHealth = () => {
    const [row] = query<{ value: string }>('SELECT value FROM kv WHERE key = ?', 'feishu-health')
    return (row ? JSON.parse(row.value) : {}) as Record<
      string,
      { state: string; detail: string; code?: string }
    >
  }
  const answered = (marker: string) =>
    until(`the tool result of ${marker}`, () =>
      daemon
        .modelRequests()
        .find((request) => request.lastRole === 'tool' && request.marker.includes(marker)),
    )
  return {
    daemon,
    client,
    chat,
    homes,
    stateDir,
    query,
    feishuHealth,
    answered,
    reconfigure,
    stop: () => handle?.stop(),
    /** What the daemon said about Superagent and the channels, and Superagent's records, for a failure message. */
    diagnostics: async () => {
      const call = (service: string) =>
        client()
          .extensions.callScoped({ extension: EXTENSION, service, input: {} })
          .then(
            (result) => JSON.stringify(result).slice(0, 3000),
            (error: unknown) => `refused: ${JSON.stringify(error).slice(0, 500)}`,
          )
      const main = await client()
        .session.load('superagent:orchestrator', { history: 'none' })
        .then(
          () => true,
          () => false,
        )
      const kv = query<{ key: string; value: string }>('SELECT key, value FROM kv')
        .map((row) => `${row.key}=${row.value.slice(0, 200)}`)
        .join('\n')
      const lines = daemon
        .stderr()
        .split('\n')
        .filter((line) => /superagent|feishu|channel|bundled|error/i.test(line))
        .slice(-60)
      const effects = query<{ kind: string; error: string | null }>('SELECT kind, error FROM effect')
      return `status: ${await call('superagent.status')}\nsetup: ${await call('superagent.state')}\nsources: ${await call('superagent.sources.list')}\nmain session: ${main}\nkv:\n${kv}\n${lines.join('\n')}\neffects: ${JSON.stringify(effects)}\ntriggers: ${JSON.stringify(query('SELECT id FROM trigger'))}\nsent: ${JSON.stringify(chat.sent())}`
    },
    triggers: () =>
      query<{ id: string }>("SELECT id FROM trigger WHERE json_extract(value, '$.source') = ?", 'feishu').map(
        (row) => row.id,
      ),
    tickets: () =>
      query<{ value: string }>('SELECT value FROM ticket').map(
        (row) => JSON.parse(row.value) as { id: string; origin: { triggerIds: string[] } },
      ),
  }
}
type Bootstrapped = Awaited<ReturnType<typeof bootstrap>>

/** Takes `om_1` in as a ticket through the main session and returns its id, once its worker session runs. */
async function acceptRequest(world: Bootstrapped): Promise<string> {
  const triggerId = key('feishu', 'om_1')
  await until('the Feishu request stored', () => world.triggers().includes(triggerId))
  const main = await world.client().session.load('superagent:orchestrator', { history: 'none' })
  await main.followUp(
    tool('route-om_1', 'orchestrator_route', {
      decisions: [
        {
          kind: 'accept',
          trigger_id: triggerId,
          title: 'Fix the login page',
          worktree_name: 'fix-login',
          acknowledgement: 'On it: fixing the login page.',
        },
      ],
    }),
  )
  await world.answered('route-om_1')
  const ticket = await until('the ticket', () =>
    world.tickets().find((item) => item.origin.triggerIds.includes(triggerId)),
  )
  await until('the worker session', () =>
    world
      .client()
      .session.load(`superagent:worker:${ticket.id}`, { history: 'none' })
      .then(
        () => true,
        () => false,
      ),
  )
  return ticket.id
}
/** Whether the Trigger of Feishu message `id` reached ticket `ticketId`. */
const reached = (world: Bootstrapped, id: string, ticketId: string) =>
  world
    .query<{ value: string }>('SELECT value FROM disposition WHERE id = ?', key('feishu', id))
    .some((row) => (JSON.parse(row.value) as { fanout: string[] }).fanout.includes(ticketId))
const githubPolls = (world: Bootstrapped) =>
  world.homes.ghCalls().filter((call) => call.argv.join(' ').includes('notifications')).length

it.skipIf(process.platform === 'win32')(
  'waits for a missing channel instance while GitHub polls on, then takes a group @ message in, replies in its topic and wakes the ticket with a follow-up',
  async () => {
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
  },
  420_000,
)

it.skipIf(process.platform === 'win32')(
  'runs live on a channel without reads: says what it lacks, takes a request in, posts the reply and wakes the ticket with a quote',
  async () => {
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
  },
  420_000,
)
