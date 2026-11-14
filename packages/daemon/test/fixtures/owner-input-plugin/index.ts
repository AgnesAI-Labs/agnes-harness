import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CHANNEL_CONFIG_SCHEMA,
  channelServiceCapabilities,
  managedServiceCapabilities,
} from '@agnes/extension-api'
import { initializeHome } from '@agnes/host'
import type { DecisionHandle, PackageOperationReceipt, SessionViewResult } from '@agnes/protocol'
import { createClient, memoryJournal } from '@agnes/sdk'
import { startLoopProvider } from '../loop-provider.js'
import { bounded, STEP_MS, spawnDaemon, stopDaemon, writeProfile } from '../managed-probe.js'

export const CHAT = '@acme/fake-chat'
export const COMPANION = '@acme/companion'
const daemonEntry = fileURLToPath(new URL('../owner-input-daemon.ts', import.meta.url))

const manifest = {
  id: 'fake-chat',
  displayName: 'Fake chat',
  version: '0.1.0',
  connection: { modes: ['stream'], default: 'stream' },
  capabilities: {
    edit: true,
    card: true,
    thread: false,
    attachment: false,
    reactions: false,
    typing: false,
    voice: false,
  },
  credentials: {
    required: [],
    optional: [],
    exposes: ['kind', 'channel', 'accountId', 'userId', 'chatId', 'chatType'],
  },
  limits: { textChars: 500, cardBytes: 4096, editWindowMs: 0 },
  events: { supported: ['message', 'cardAction'] },
  directory: { supported: false, unit: 'dept' },
}

const service = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  scope: 'profile',
  artifact: { kind: 'in-process' },
  healthPath: '/health',
  listeners: [],
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 5_000,
  apiVersion: '1.0.0',
  requires: [],
  ...extra,
})

// An in-memory channel adapter: the test drops inbound events into `exchange` and reads what it sent.
function chatSource(exchange: string, workspace: string) {
  return `
import { appendFileSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const exchange = ${JSON.stringify(exchange)}
const manifest = ${JSON.stringify(manifest)}
let sent = 0
const adapter = () => {
  let onEvent, timer
  return {
    manifest,
    async connect(options) {
      onEvent = options.onEvent
      timer = setInterval(() => {
        for (const file of readdirSync(exchange).filter((name) => name.startsWith('in-')).sort()) {
          const event = JSON.parse(readFileSync(join(exchange, file), 'utf8'))
          rmSync(join(exchange, file))
          onEvent(event)
        }
      }, 50)
    },
    async disconnect() { clearInterval(timer) },
    toSession() { return null },
    resolveScope(event) { return { scope: event.chat.id, isDirectMessage: event.chat.type === 'dm' } },
    render() { return null },
    async send(target, message) {
      const messageId = 'sent-' + ++sent + '-' + process.pid
      appendFileSync(join(exchange, 'sent.jsonl'), JSON.stringify({ target, message, messageId }) + '\\n')
      return { chatId: target.chatId, messageId, accountId: 'app-1', chatType: 'dm' }
    },
    async update(ref, message) { appendFileSync(join(exchange, 'edits.jsonl'), JSON.stringify({ ref, message }) + '\\n') },
    renderApproval() { return { blocks: [] } },
    onApprovalAction(event) { return event.kind === 'cardAction' ? event.approval ?? null : null },
    onSurfaceAction(event) { return event.kind === 'cardAction' ? event.surface ?? null : null },
    credentialOf(event) {
      return { kind: 'channel', channel: manifest.id, accountId: event.accountId, userId: event.sender.userId, chatId: event.chat.id, chatType: event.chat.type }
    },
    capabilities() { return manifest.capabilities },
  }
}
export const main = {
  inject: ['profileRuntime', 'services', 'providers'],
  apply(ctx) {
    ctx.profileRuntime.registerChannel(
      { id: manifest.id, version: '1.0.0', manifest, create: adapter },
      { instances: [{ id: 'desk-bot', workspace: ${JSON.stringify(workspace)}, agent: 'default', credentialRefs: {}, allowFrom: [], requireMention: true }] },
    )
  },
}
`
}

/**
 * The companion: a managed service with `sessions` and `channelTargets`. Every `onEvent` call is logged
 * to `calls.jsonl`. While `control-hang` exists the handler never returns (the service never
 * acknowledges); while `control-throws` holds a count above zero, each call takes one from it and
 * throws. A handled event is logged to `events.jsonl`. The test drives `init.sessions` and
 * `init.channels` through request and reply files.
 */
function companionSource(exchange: string) {
  return `
import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const exchange = ${JSON.stringify(exchange)}
const pending = new Set()
const reply = (id, body) => {
  writeFileSync(join(exchange, id + '.tmp'), JSON.stringify(body))
  renameSync(join(exchange, id + '.tmp'), join(exchange, 'res-' + id + '.json'))
}
async function answer(init, file) {
  const id = file.slice(4, -5)
  try {
    const { op, args } = JSON.parse(readFileSync(join(exchange, file), 'utf8'))
    const [area, method] = op.split('.')
    reply(id, { ok: true, value: (await init[area][method](...args)) ?? null })
  } catch (error) {
    reply(id, { ok: false, error: { message: String(error?.message), code: error?.code, data: error?.data } })
  }
}
async function onEvent(event) {
  appendFileSync(join(exchange, 'calls.jsonl'), JSON.stringify({ receiptId: event.receiptId ?? null, eventId: event.eventId, text: event.text ?? null, pid: process.pid, at: Date.now() }) + '\\n')
  if (existsSync(join(exchange, 'control-hang'))) await new Promise(() => {})
  const throws = join(exchange, 'control-throws')
  if (existsSync(throws)) {
    const left = Number(readFileSync(throws, 'utf8'))
    if (left > 0) {
      writeFileSync(throws, String(left - 1))
      throw new Error('scripted onEvent failure')
    }
  }
  appendFileSync(join(exchange, 'events.jsonl'), JSON.stringify(event) + '\\n')
}
export const main = {
  inject: ['profileRuntime'],
  apply(ctx) {
    ctx.profileRuntime.register({
      id: 'companion',
      configSchema: { type: 'object', properties: {}, additionalProperties: false },
      defaultConfig: {},
      async start(init) {
        init.channels.onEvent(onEvent)
        const timer = setInterval(() => {
          for (const file of readdirSync(exchange))
            if (file.startsWith('req-') && !pending.has(file)) {
              pending.add(file)
              void answer(init, file)
            }
        }, 50)
        init.onShutdown(async () => {
          clearInterval(timer)
          return { state: 'settled' }
        })
        init.ready()
        return {}
      },
    })
  },
}
`
}

function writePlugins(root: string, workspace: string) {
  const directories = { chat: join(root, 'chat-plugin'), companion: join(root, 'companion-plugin') }
  const empty = { type: 'object', properties: {}, additionalProperties: false } as const
  for (const [directory, name, row, source] of [
    [
      directories.chat,
      CHAT,
      {
        id: 'ext:acme/fake-chat/main',
        apiRange: '^5.15.0',
        inject: ['profileRuntime', 'services', 'providers'],
        capabilities: {
          store: true,
          network: ['*'],
          services: [
            ...managedServiceCapabilities('channel', CHANNEL_CONFIG_SCHEMA),
            ...channelServiceCapabilities(),
          ],
          managedServices: [service('channel')],
        },
      },
      chatSource(join(root, 'chat'), workspace),
    ],
    [
      directories.companion,
      COMPANION,
      {
        id: 'ext:acme/companion/main',
        apiRange: '^5.21.0',
        inject: ['profileRuntime'],
        capabilities: {
          store: true,
          managedServices: [service('companion', { channelTargets: true, sessions: true })],
          services: managedServiceCapabilities('companion', empty),
        },
      },
      companionSource(join(root, 'companion')),
    ],
  ] as const) {
    mkdirSync(directory, { recursive: true })
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({
        name,
        version: '1.0.0',
        license: 'MIT',
        type: 'module',
        exports: './index.mjs',
        agnes: {
          plugins: [{ export: 'main', runtime: 'in-process', ...row }],
          ...(name === COMPANION
            ? {
                provides: ['bundle'],
                bundles: {
                  worker: {
                    presets: {
                      'companion-worker': {
                        name: 'companion-worker',
                        extends: 'standard',
                        surfaces: ['daemon', 'sdk'],
                      },
                    },
                    launch: {
                      title: { en: 'Companion worker' },
                      description: { en: 'Owner input admission fixture.' },
                      preset: 'companion-worker',
                    },
                  },
                },
              }
            : {}),
        },
      }),
    )
    writeFileSync(join(directory, 'index.mjs'), source)
  }
  return directories
}

export async function until<T>(
  read: () => Promise<T | undefined> | T | undefined,
  label: string,
): Promise<T> {
  const deadline = Date.now() + STEP_MS
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`${label} timed out`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

export const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export type PluginReply<T = Record<string, unknown>> = {
  ok: boolean
  value?: T | null
  error?: { message: string; code?: number; data?: { code?: string; reason?: string } }
}

type Client = ReturnType<typeof createClient>
type ManagedResult = {
  state: string
  reason?: string
  version?: number
  inputId?: string
  turn?: number
  seq?: number
  delivery?: string
  reviewLocation?: string
  historyCoverage?: string
}

/**
 * A real source daemon with the local Web listener, the fake chat channel and the companion service,
 * the owner paired with the companion. `unix` is a local SDK client; `web` comes in as the owner's
 * Web page. The daemon can be stopped (SIGTERM), killed (SIGKILL) or crash at an admission point.
 */
export async function openHarness(name: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `agnes-${name}-`)))
  const workspace = join(root, 'workspace')
  const faults = join(root, 'faults')
  const chatDir = join(root, 'chat')
  const companionDir = join(root, 'companion')
  initializeHome(root, 'local-dev')
  for (const dir of [workspace, faults, chatDir, companionDir]) mkdirSync(dir)
  const provider = await startLoopProvider()
  writeProfile(root, provider.baseUrl)
  const plugins = writePlugins(root, workspace)
  const sockets = new Set<string>()
  let daemon: ReturnType<typeof spawnDaemon> | undefined
  let unix: Client | undefined
  let web: Client | undefined
  const stderr: string[] = []

  const connect = async () => {
    const owner = JSON.parse(readFileSync(join(root, 'daemon', 'owner.json'), 'utf8'))
    sockets.add(owner.socketPath)
    unix = createClient({
      journal: memoryJournal(),
      auth: { kind: 'local' },
      transport: { kind: 'unix', path: owner.socketPath },
      timeouts: { request: STEP_MS },
    })
    await unix.initialize()
    const discovery = JSON.parse(readFileSync(join(root, 'daemon', 'discovery.json'), 'utf8')) as {
      web?: { url: string }
    }
    if (!discovery.web) throw new Error('the daemon published no local Web endpoint')
    web = createClient({
      journal: memoryJournal(),
      auth: { kind: 'local' },
      transport: { kind: 'ws', url: discovery.web.url },
      timeouts: { request: STEP_MS },
    })
    await web.initialize()
  }
  const disconnect = async () => {
    const clients = [unix, web]
    unix = undefined
    web = undefined
    for (const client of clients) await client?.close().catch(() => undefined)
  }
  const boot = async () => {
    daemon = spawnDaemon(daemonEntry, [root, root, faults], root)
    await bounded(daemon.ready, 'source daemon boot')
    await connect()
  }
  const lost = async () => {
    const exited = daemon?.exited
    if (daemon) stderr.push(daemon.output.stderr)
    daemon = undefined
    await disconnect()
    await bounded(exited ?? Promise.resolve(null), 'daemon exit')
    // The old session worker sees its supervisor go and shuts its plugins down before a new one boots.
    await pause(2_000)
  }
  const sdk = () => {
    if (!unix) throw new Error('no daemon client connected')
    return unix
  }
  const owner = () => {
    if (!web) throw new Error('no Web client connected')
    return web
  }

  /** Writes one request for the companion; `wait: false` leaves it unanswered (the daemon may die). */
  const request = (op: string, args: unknown[]) => {
    const id = randomUUID()
    writeFileSync(join(companionDir, `${id}.tmp`), JSON.stringify({ op, args }))
    renameSync(join(companionDir, `${id}.tmp`), join(companionDir, `req-${id}.json`))
    return id
  }
  const reply = <T>(id: string, label: string) =>
    until(() => {
      try {
        return JSON.parse(readFileSync(join(companionDir, `res-${id}.json`), 'utf8')) as PluginReply<T>
      } catch {
        return undefined
      }
    }, label)
  const companion = <T = ManagedResult>(op: string, ...args: unknown[]) =>
    reply<T>(request(op, args), `companion ${op}`)
  /** A request the daemon died on: its file is removed so a later worker never answers it. */
  const fire = (op: string, ...args: unknown[]) => {
    const id = request(op, args)
    return () => rmSync(join(companionDir, `req-${id}.json`), { force: true })
  }

  const lines = (file: string) => {
    try {
      return readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    } catch {
      return []
    }
  }
  const sent = () =>
    lines(join(chatDir, 'sent.jsonl')) as { message: { blocks: { kind: string; markdown?: string }[] } }[]
  const calls = () =>
    lines(join(companionDir, 'calls.jsonl')) as { receiptId: string | null; eventId: string; text: string }[]
  const handled = () =>
    lines(join(companionDir, 'events.jsonl')) as { receiptId?: string; eventId: string; text?: string }[]

  let events = 0
  /** One inbound chat event from the owner; the same `eventId` again is the platform redelivering it. */
  const inject = (text: string, over: Record<string, unknown> = {}) => {
    const id = `${Date.now()}-${++events}`
    const event = {
      kind: 'message',
      eventId: `event-${id}`,
      messageId: `message-${id}`,
      accountId: 'app-1',
      text,
      attachments: [],
      at: new Date().toISOString(),
      chat: { id: 'owner-dm', type: 'dm' },
      sender: { userId: 'owner-1', displayName: 'Owner', raw: {} },
      mentions: { bot: false, replyToBot: false, quoteBot: false },
      ...over,
    }
    writeFileSync(join(chatDir, `tmp-${id}.json`), JSON.stringify(event))
    renameSync(join(chatDir, `tmp-${id}.json`), join(chatDir, `in-${id}.json`))
    return event
  }
  /** The owner says `text` in the paired chat; resolves with the receipt id the companion was handed. */
  const ownerSays = async (text: string) => {
    inject(text)
    const event = await until(() => handled().find((row) => row.text === text), `companion handles "${text}"`)
    if (!event.receiptId) throw new Error(`no receipt id on "${text}"`)
    return event.receiptId
  }

  const operation = async (receipt: PackageOperationReceipt) =>
    until(async () => {
      const value = await sdk().packages.operation.get({
        profile: receipt.profile,
        operationId: receipt.operationId,
      })
      if (['failed', 'cancelled', 'rolled-back'].includes(value.state))
        throw new Error(`package ${value.operation}: ${JSON.stringify(value.error)}`)
      return value.state === 'completed' ? value : undefined
    }, `package ${receipt.operationId}`)
  const command = async () => ({
    profile: 'local-dev',
    clientId: await sdk().clientId(),
    commandId: randomUUID(),
  })
  const install = async (id: string, directory: string) => {
    const source = { type: 'file' as const, ref: `file:${directory}` }
    const preview = (await operation(await sdk().packages.inspect({ ...(await command()), source }))).preview
    if (!preview?.capabilityHash) throw new Error('plugin preview has no capability hash')
    if (preview.blockers.length) throw new Error(`${id} blockers: ${JSON.stringify(preview.blockers)}`)
    await operation(
      await sdk().packages.install({ ...(await command()), source, expectedIntegrity: preview.integrity }),
    )
    await operation(
      await sdk().packages.trust({
        ...(await command()),
        id,
        expectedIntegrity: preview.integrity,
        capabilityHash: preview.capabilityHash,
      }),
    )
    await operation(await sdk().packages.enable({ ...(await command()), id }))
  }

  /**
   * Mints a pairing code (approved by the owner), says it in the chat, and returns the new pairing id.
   * With `previous`, the owner first revokes that pairing: re-pairing the same chat keeps its id (the chat's)
   * and records a new pairing time.
   */
  let mints = 0
  const pair = async (previous?: string) => {
    const pairing = (params: Record<string, unknown>) =>
      sdk().request('_agnes/v1/channels.pairing', params as never) as Promise<{
        receipt?: { state: string }
        code?: string
        targets?: { owner: string; service: string; packageId: string }[]
      }>
    if (previous) await pairing({ action: 'revoke', pairingId: previous })
    const target = await until(
      async () => (await pairing({ action: 'targets' })).targets?.find((row) => row.packageId === COMPANION),
      'companion target',
    )
    const catalog = (await sdk().request('_agnes/v1/channels.catalog', {})) as {
      providers: { extension: string; packageId: string }[]
    }
    const extension = catalog.providers.find((row) => row.packageId === CHAT)?.extension
    if (!extension) throw new Error('fake chat provider is not in the channel catalogue')
    const operationId = `mint-${++mints}`
    const mint = () =>
      pairing({
        action: 'mint',
        extension,
        instanceId: 'desk-bot',
        target: { owner: target.owner, service: 'companion' },
        operationId,
      })
    const asked = await until(async () => {
      try {
        return await mint()
      } catch (error) {
        if (JSON.stringify(error).includes('CHANNEL_UNAVAILABLE')) return undefined
        throw error
      }
    }, 'channel instance connects')
    if (asked.receipt?.state === 'approval-required') {
      const { decisions } = (await sdk().request('_agnes/v1/profile.decisions.list', {})) as {
        decisions: { handle: DecisionHandle; revision: number }[]
      }
      const [decision] = decisions
      if (!decision) throw new Error('no pairing decision was listed')
      await sdk().request('_agnes/v1/profile.decisions.answer', {
        handle: decision.handle,
        revision: decision.revision,
        commandId: randomUUID(),
        response: { option: 'allowed-once', value: null },
      })
    }
    const code = (await mint()).code
    if (!code) throw new Error('no pairing code was minted')
    const replies = sent().length
    inject(code.toLowerCase().replace('-', ' '))
    await until(
      () =>
        sent()
          .slice(replies)
          .some((row) => row.message.blocks.some((block) => block.markdown?.includes('已与')))
          ? true
          : undefined,
      'pairing reply',
    )
    return until(async () => {
      const value = (await companion<{ id: string }>('channels.pairing')).value
      return value?.id ? value.id : undefined
    }, 'companion sees its pairing')
  }

  /** A managed session of the companion bound to task `task`, after its first turn ended. */
  const start = async (task: string, input = `Start ${task}.`, binding = true) => {
    const started = await companion<{ sessionId: string }>('sessions.start', {
      bundle: `${COMPANION}#worker`,
      workspace,
      input,
      startKey: task,
      retention: 'task',
      ...(binding ? { taskBinding: { id: task, generation: 0 } } : {}),
    })
    if (!started.ok || !started.value) throw new Error(`start ${task}: ${JSON.stringify(started.error)}`)
    return started.value.sessionId
  }
  const turns = async (sessionId: string) =>
    (await sdk().call<SessionViewResult>('_agnes/v1/session.view', { sessionId, maxNodes: 5000 })).timeline
  /** Waits until the session has `count` ended turns and nothing running. */
  const settled = (sessionId: string, count: number) =>
    until(async () => {
      const ended = (await turns(sessionId)).turns.filter((turn) => turn.status !== 'running')
      const status = (await companion<{ kind: string }>('sessions.status', sessionId)).value
      return ended.length >= count && status?.kind !== 'active' ? ended.length : undefined
    }, `session ${sessionId} settles after ${count} turns`)
  /** How often `text` shows in the session's view: every user message and every node rendered. */
  const occurrences = async (sessionId: string, text: string) =>
    JSON.stringify((await turns(sessionId)).nodes).split(text).length - 1
  const target = (task: string) => ({ taskId: task, taskGeneration: 0, startKey: task })
  const admit = (sessionId: string, key: string, task: string, input: Record<string, unknown>) =>
    companion('sessions.admitInput', sessionId, { key, target: target(task), input })
  const result = async (sessionId: string, key: string) => {
    const reply = await companion('sessions.inputResult', sessionId, { key })
    if (!reply.ok || !reply.value) throw new Error(`inputResult ${key}: ${JSON.stringify(reply.error)}`)
    return reply.value
  }
  const reaches = (sessionId: string, key: string, state: string) =>
    until(async () => {
      const value = await result(sessionId, key)
      return value.state === state ? value : undefined
    }, `input ${key} reaches ${state}`)

  const close = async () => {
    const failures: unknown[] = []
    for (const step of [
      () => disconnect(),
      () => daemon && stopDaemon(daemon.child, daemon.exited),
      () => provider.close(),
      () => {
        rmSync(root, { recursive: true, force: true })
        for (const socket of sockets) rmSync(dirname(socket), { recursive: true, force: true })
      },
    ]) {
      try {
        await step()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length) throw new AggregateError(failures, 'owner input e2e cleanup failed')
  }

  return {
    root,
    workspace,
    provider,
    plugins,
    sdk,
    owner,
    boot,
    /** Graceful stop (SIGTERM) and wait for exit 0. */
    async stop() {
      if (!daemon) throw new Error('no daemon running')
      const { child, exited } = daemon
      await disconnect()
      await stopDaemon(child, exited)
      if (daemon) stderr.push(daemon.output.stderr)
      daemon = undefined
      await pause(1_000)
    },
    /** SIGKILL from outside: a host crash. */
    async kill() {
      daemon?.child.kill('SIGKILL')
      await lost()
    },
    /** Arms a crash point inside admission; `crashed()` waits for the daemon to die there. */
    arm(point: 'afterReserve' | 'afterSubmit') {
      writeFileSync(join(faults, point), '')
    },
    async crashed() {
      const signal = await bounded(
        new Promise<string | null>((resolve) => {
          const child = daemon?.child
          if (!child) return resolve(null)
          if (child.exitCode !== null || child.signalCode !== null) return resolve(child.signalCode)
          child.once('exit', (_code, sig) => resolve(sig))
        }),
        'daemon crash',
      )
      await lost()
      return { signal, armed: readdirSync(faults) }
    },
    control(name: 'hang' | 'throws', value?: string) {
      const file = join(companionDir, `control-${name}`)
      if (value === undefined) rmSync(file, { force: true })
      else writeFileSync(file, value)
    },
    controlValue: (name: string) =>
      existsSync(join(companionDir, `control-${name}`))
        ? readFileSync(join(companionDir, `control-${name}`), 'utf8')
        : undefined,
    install,
    pair,
    inject,
    ownerSays,
    calls,
    handled,
    companion,
    fire,
    start,
    settled,
    turns,
    occurrences,
    admit,
    result,
    reaches,
    target,
    stderr: () => [...stderr, daemon?.output.stderr ?? ''].join('\n---\n'),
    close,
  }
}

export type Harness = Awaited<ReturnType<typeof openHarness>>

/** Boots, installs and trusts both plugins, grants the workspace and pairs the owner's chat. */
export async function setUp(h: Harness) {
  await h.boot()
  await h.sdk().workspace.add(h.workspace)
  await h.install(COMPANION, h.plugins.companion)
  await h.install(CHAT, h.plugins.chat)
  await h
    .sdk()
    .request('_agnes/v1/admin.managedWorkspaces.grant', { packageId: COMPANION, workspace: h.workspace })
  return h.pair()
}
