// A real daemon with the shipped Superagent payload and the test channel plugin, for the Feishu Source e2es: how a test
// starts it, configures the Source, drives the channel and reads Superagent's records.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { MessageEvent } from '@agnes/extension-api/channel-contract'
import { expect } from 'vitest'
import { openStore } from '../../src/app/store.js'
import { key } from '../../src/core/index.js'
import { SettingsSchema } from '../../src/policy.js'
import { SERVICE_ID } from '../../src/runtime/index.js'
import { writeChannelPlugin } from './channel-plugin.js'
import { type DaemonHandle, startDaemon } from './daemon-harness.js'
import { makeHomes } from './homes.js'
import { byShell } from './shell.js'

export const PROFILE = 'local-dev'
const PACKAGE = '@agnes/superagent'
export const INSTANCE = 'feishu-test'
export const EXTENSION = `plugin/${createHash('sha256').update('ext:agnes.superagent/main').digest('hex').slice(0, 16)}`
const STEP_MS = 120_000
/** The state directory the platform gives the service by default (see the bundled-app grant). */
const defaultStateDir = (aghHome: string) =>
  join(
    aghHome,
    'data',
    'bundled-apps',
    createHash('sha256').update(`${PROFILE}\0${PACKAGE}\0${SERVICE_ID}`).digest('hex').slice(0, 32),
  )
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
export async function until<T>(
  label: string,
  probe: () => T | Promise<T>,
  ms = STEP_MS,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await probe()
    if (value) return value as NonNullable<T>
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(200)
  }
}
export const tool = (marker: string, name: string, args: unknown) =>
  `[[${marker} TOOL${JSON.stringify({ name, args })}ENDTOOL]]`
/** A message of Alice in `oc_team` (or in `chat`, a direct chat when `direct`) as the channel delivers it, sent now. */
export const groupMessage = (
  id: string,
  fields: {
    text: string
    mentioned?: boolean
    thread?: string
    quoted?: string
    eventId?: string
    chat?: string
    direct?: boolean
    sender?: string
  },
): MessageEvent => ({
  kind: 'message',
  eventId: fields.eventId ?? `ev-${id}`,
  accountId: 'cli_app',
  chat: {
    id: fields.chat ?? 'oc_team',
    type: fields.direct ? 'dm' : 'group',
    ...(fields.thread ? { threadId: fields.thread } : {}),
  },
  sender: { userId: fields.sender ?? 'ou_alice', displayName: 'Alice', kind: 'user', raw: {} },
  at: new Date().toISOString(),
  messageId: id,
  text: fields.text,
  attachments: [],
  mentions: { bot: fields.mentioned ?? false, replyToBot: false, quoteBot: false },
  ...(fields.quoted ? { quotedMessageId: fields.quoted } : {}),
})

/** The Feishu Source settings that subscribe only `oc_team` (@ only) of the instance `channel`. */
const groupsOn = (channel: string) => ({
  instance: channel,
  claim: 'groups',
  chats: [{ chatId: 'oc_team', listen: 'mentions' }],
})
/** Writes Superagent's settings: GitHub on acme/app, the Feishu Source as `feishu` says, Alice allowed. */
function configure(database: string, root: string, gh: string, feishu: Record<string, unknown>) {
  const store = openStore(database)
  try {
    store.saveSettings(
      SettingsSchema.parse({
        sources: {
          github: { enabled: true, config: { repository: 'acme/app', cli: gh } },
          feishu: { enabled: true, config: feishu },
        },
        policy: { sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }] } } },
        executor: {
          // Windows PowerShell, the prepare shell there, has no `&&`, and its `>` writes UTF-16.
          prepare: byShell(
            'git init -q repo && echo prepared > repo/PREPARED',
            "git init -q repo; if ($LASTEXITCODE) { exit $LASTEXITCODE }; Set-Content repo/PREPARED 'prepared'",
          ),
          directory: join(root, 'work'),
        },
      }),
    )
  } finally {
    store.close()
  }
}

/**
 * Starts a daemon with the shipped payload and the test channel plugin (instance `feishu-test` and `others`, with or
 * without reads), and configures Superagent's Feishu Source with `feishu`, by default subscribing `oc_team` of the
 * instance `channel`.
 */
export async function bootstrap(
  root: string,
  options: { reads: boolean; channel: string; others?: string[]; feishu?: Record<string, unknown> },
) {
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
  // The daemon starts as the deployment guide starts it: as usual, with the operator's HOME and PATH.
  const daemon = await startDaemon({
    aghHome,
    home: homes.operatorHome,
    path: process.env.PATH ?? '',
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
    ...(options.others ? { others: options.others } : {}),
  })
  /** Installs, trusts and enables the plugin package in `directory`. */
  const install = async (directory: string) => {
    const source = { type: 'file' as const, ref: `file:${directory}` }
    const preview = (
      await operation(await client().packages.inspect({ ...(await command('inspect')), source }))
    ).preview
    if (!preview?.capabilityHash) throw new Error(`the plugin in ${directory} has no capability hash`)
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
        id: preview.id,
        expectedIntegrity: preview.integrity,
        capabilityHash: preview.capabilityHash,
      }),
    )
    await operation(await client().packages.enable({ ...(await command('enable')), id: preview.id }))
  }
  await install(chat.directory)

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
  const disable = async () =>
    operation(await client().packages.disable({ ...(await command('disable')), id: PACKAGE }))
  /** Disables Superagent, writes its Feishu settings (by default subscribing `oc_team` of `channel`), and enables it. */
  const reconfigure = async (channel: string, feishu: Record<string, unknown> = groupsOn(channel)) => {
    await disable()
    configure(database, stateDir, join(homes.shimsDir, 'gh'), feishu)
    await operation(await client().packages.enable({ ...(await command('enable')), id: PACKAGE }))
  }
  await reconfigure(options.channel, options.feishu)
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
    install,
    disable,
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
export type Bootstrapped = Awaited<ReturnType<typeof bootstrap>>

/** Takes Feishu message `id` in as a ticket through the main session and returns its id, once its worker session runs. */
export async function acceptRequest(world: Bootstrapped, id = 'om_1'): Promise<string> {
  const triggerId = key('feishu', id)
  await until(`the Feishu request ${id} stored`, () => world.triggers().includes(triggerId))
  const main = await world.client().session.load('superagent:orchestrator', { history: 'none' })
  await main.followUp(
    tool(`route-${id}`, 'orchestrator_route', {
      decisions: [
        {
          kind: 'accept',
          trigger_id: triggerId,
          title: 'Fix the login page',
          worktree_name: `fix-login-${id.replaceAll('_', '-')}`,
          acknowledgement: 'On it: fixing the login page.',
        },
      ],
    }),
  )
  await world.answered(`route-${id}`)
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
export const reached = (world: Bootstrapped, id: string, ticketId: string) =>
  world
    .query<{ value: string }>('SELECT value FROM disposition WHERE id = ?', key('feishu', id))
    .some((row) => (JSON.parse(row.value) as { fanout: string[] }).fanout.includes(ticketId))
export const githubPolls = (world: Bootstrapped) =>
  world.homes.ghCalls().filter((call) => call.argv.join(' ').includes('notifications')).length
