import { type ChildProcess, spawn } from 'node:child_process'
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
  statSync,
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
import type { Block, ChannelSurfaceBlock } from '@agnes/extension-api/channel-contract'
import { initializeHome } from '@agnes/host'
import type { DecisionHandle, PackageOperationReceipt } from '@agnes/protocol'
import { createClient, memoryJournal } from '@agnes/sdk'
import { expect, it } from 'vitest'
import { startLoopProvider } from './fixtures/loop-provider.js'
import { sourceTranspileCache } from './source-transpile-cache.js'

const sourceDaemon = fileURLToPath(new URL('./fixtures/source-loop-daemon.ts', import.meta.url))
const CHAT = '@acme/fake-chat'
const DESK = '@acme/desk'
const STEP_MS = 60_000
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
const empty = { type: 'object', properties: {}, additionalProperties: false } as const

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), STEP_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function until<T>(read: () => Promise<T | undefined> | T | undefined, label: string): Promise<T> {
  const deadline = Date.now() + STEP_MS
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`${label} timed out`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

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

// The target service answers the test through request and reply files, and records its events.
function deskSource(exchange: string) {
  return `
import { appendFileSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
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
    reply(id, { ok: true, value: (await (op.startsWith('sessions.') ? init.sessions[op.slice(9)](...args) : init.channels[op](...args))) ?? null })
  } catch (error) {
    reply(id, { ok: false, error: { message: String(error?.message), data: error?.data } })
  }
}
export const main = {
  inject: ['profileRuntime'],
  apply(ctx) {
    ctx.profileRuntime.register({
      id: 'desk',
      configSchema: { type: 'object', properties: {}, additionalProperties: false },
      defaultConfig: {},
      async start(init) {
        init.channels.onEvent(async (event) => appendFileSync(join(exchange, 'events.jsonl'), JSON.stringify(event) + '\\n'))
        init.channels.onPairingChange(() => appendFileSync(join(exchange, 'changes.log'), 'x'))
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
  const chat = join(root, 'chat-plugin'),
    desk = join(root, 'desk-plugin')
  for (const [directory, name, row, source] of [
    [
      chat,
      CHAT,
      {
        id: 'ext:acme/fake-chat/main',
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
      desk,
      DESK,
      {
        id: 'ext:acme/desk/main',
        inject: ['profileRuntime'],
        capabilities: {
          store: true,
          managedServices: [service('desk', { channelTargets: true, sessions: true })],
          services: managedServiceCapabilities('desk', empty),
        },
      },
      deskSource(join(root, 'desk')),
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
          plugins: [{ export: 'main', apiRange: '^5.15.0', runtime: 'in-process', ...row }],
          ...(name === DESK
            ? {
                provides: ['bundle'],
                bundles: {
                  worker: {
                    presets: {
                      'desk-worker': {
                        name: 'desk-worker',
                        extends: 'standard',
                        surfaces: ['daemon', 'sdk'],
                        approval: { on_unavailable: 'park' },
                        ext_ui: { unattended: 'park' },
                      },
                    },
                    launch: {
                      title: { en: 'Desk worker' },
                      description: { en: 'Channel interaction fixture.' },
                      preset: 'desk-worker',
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
  return { chat, desk }
}

function writeProfile(root: string, baseUrl: string) {
  const secretDir = join(root, 'secrets')
  mkdirSync(join(secretDir, 'fixture'), { recursive: true, mode: 0o700 })
  writeFileSync(join(secretDir, 'fixture', 'model'), 'synthetic-loop-fixture', { mode: 0o600 })
  const model = {
    id: 'loop-script',
    name: 'Scripted loop fixture',
    route: 'loop-fixture',
    api: 'openai-completions',
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    toolCallFormats: ['native'],
    thinkingReplay: 'drop',
    contract_id: null,
  }
  writeFileSync(
    join(root, 'profiles', 'local-dev', 'profile.yaml'),
    JSON.stringify({
      name: 'local-dev',
      cacheDir: sourceTranspileCache(),
      computerUse: { enabled: false },
      adapters: { secrets: { kind: 'file', path: secretDir } },
      provider: {
        package: '@agnes/ai',
        catalog: { include: [] },
        routes: [
          {
            route: model.route,
            api: 'openai-completions',
            baseUrl,
            credentialRef: 'secret://fixture/model',
            models: [model],
          },
        ],
      },
    }),
  )
}

function boot(root: string) {
  const daemon = spawn(process.execPath, ['--import', 'tsx', sourceDaemon, root, root], {
    env: { PATH: process.env.PATH, TMPDIR: tmpdir(), AGH_HOME: root },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  const exited = new Promise<number | null>((resolve) => daemon.once('exit', resolve))
  const log = { stderr: '' }
  const ready = new Promise<void>((resolve, reject) => {
    daemon.once('error', reject)
    daemon.stderr?.on('data', (data) => {
      log.stderr += String(data)
      if (log.stderr.includes('agnesd listening on ')) resolve()
    })
    daemon.once('exit', (code) => reject(new Error(`source daemon exited ${code}: ${log.stderr}`)))
  })
  return { daemon, exited, ready, log }
}

async function stop(child: ChildProcess, exited: Promise<number | null>) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  try {
    expect(await bounded(exited, 'daemon shutdown')).toBe(0)
  } catch (error) {
    child.kill('SIGKILL')
    await exited
    throw error
  }
}

function filesUnder(path: string): string[] {
  return readdirSync(path).flatMap((name) => {
    const full = join(path, name)
    const stat = statSync(full, { throwIfNoEntry: false })
    return stat?.isDirectory() ? filesUnder(full) : stat?.isFile() ? [full] : []
  })
}

it.skipIf(process.platform === 'win32')(
  'pairs a channel chat with a plugin service after approval, routes owner text, sends back and releases on removal',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-channel-targets-')))
    const workspace = join(root, 'workspace')
    initializeHome(root, 'local-dev')
    for (const dir of [workspace, join(root, 'chat'), join(root, 'desk')]) mkdirSync(dir)
    const provider = await startLoopProvider()
    writeProfile(root, provider.baseUrl)
    const plugins = writePlugins(root, workspace)
    let running = boot(root)
    let sdk: ReturnType<typeof createClient> | undefined
    const sockets = new Set<string>()
    const failures: unknown[] = []
    let code = ''
    try {
      const connect = async () => {
        await bounded(running.ready, 'source daemon boot')
        const owner = JSON.parse(readFileSync(join(root, 'daemon', 'owner.json'), 'utf8'))
        sockets.add(owner.socketPath)
        const client = createClient({
          journal: memoryJournal(),
          auth: { kind: 'local' },
          transport: { kind: 'unix', path: owner.socketPath },
          timeouts: { request: STEP_MS },
        })
        await client.initialize()
        sdk = client
        return client
      }
      let client = await connect()
      await client.workspace.add(workspace)
      const operation = async (receipt: PackageOperationReceipt) => {
        const result = await until(async () => {
          const value = await client.packages.operation.get({
            profile: receipt.profile,
            operationId: receipt.operationId,
          })
          if (['failed', 'cancelled', 'rolled-back'].includes(value.state))
            throw new Error(`package ${value.operation}: ${JSON.stringify(value.error)}`)
          return value.state === 'completed' ? value : undefined
        }, `package ${receipt.operationId}`)
        return result
      }
      const command = async () => ({
        profile: 'local-dev',
        clientId: await client.clientId(),
        commandId: randomUUID(),
      })
      const install = async (id: string, directory: string) => {
        const source = { type: 'file' as const, ref: `file:${directory}` }
        const preview = (await operation(await client.packages.inspect({ ...(await command()), source })))
          .preview
        if (!preview?.capabilityHash) throw new Error('plugin preview has no capability hash')
        expect(preview.blockers, `${id} installs without blockers`).toEqual([])
        await operation(
          await client.packages.install({
            ...(await command()),
            source,
            expectedIntegrity: preview.integrity,
          }),
        )
        await operation(
          await client.packages.trust({
            ...(await command()),
            id,
            expectedIntegrity: preview.integrity,
            capabilityHash: preview.capabilityHash,
          }),
        )
        await operation(await client.packages.enable({ ...(await command()), id }))
      }
      await install(DESK, plugins.desk)
      await install(CHAT, plugins.chat)
      const questionBundle = `${DESK}#worker`

      const pairing = (params: Record<string, unknown>) =>
        client.request('_agnes/v1/channels.pairing', params as never) as Promise<{
          receipt?: { state: string; code?: string; decision?: unknown }
          code?: string
          targets?: { owner: string; service: string; packageId: string; paired: boolean }[]
        }>
      const target = await until(
        async () => (await pairing({ action: 'targets' })).targets?.find((row) => row.packageId === DESK),
        'desk target',
      )
      const catalog = (await client.request('_agnes/v1/channels.catalog', {})) as {
        providers: { extension: string; packageId: string }[]
      }
      const extension = catalog.providers.find((row) => row.packageId === CHAT)?.extension
      if (!extension) throw new Error('fake chat provider is not in the channel catalogue')
      const mint = (operationId: string, over: Record<string, unknown> = {}) =>
        pairing({
          action: 'mint',
          extension,
          instanceId: 'desk-bot',
          target: { owner: target.owner, service: 'desk' },
          operationId,
          ...over,
        })

      const asked = await until(async () => {
        try {
          return await mint('mint-1')
        } catch (error) {
          if (JSON.stringify(error).includes('CHANNEL_UNAVAILABLE')) return undefined
          throw error
        }
      }, 'channel instance connects')
      expect(asked.receipt?.state, 'minting waits for a person first').toBe('approval-required')
      expect(asked.code, 'no usable code before approval').toBeUndefined()
      await expect(
        mint('mint-1', { instanceId: 'other-bot' }),
        'same operation, other parameters',
      ).rejects.toMatchObject({
        data: { code: 'ID_CONFLICT' },
      })
      const decide = async (option: string) => {
        const { decisions } = (await client.request('_agnes/v1/profile.decisions.list', {})) as {
          decisions: { handle: DecisionHandle; revision: number }[]
        }
        const [decision] = decisions
        if (!decision) throw new Error('no pairing decision was listed')
        await client.request('_agnes/v1/profile.decisions.answer', {
          handle: decision.handle,
          revision: decision.revision,
          commandId: randomUUID(),
          response: { option, value: null },
        })
      }
      await decide('rejected')
      expect((await mint('mint-1')).receipt, 'a rejected approval mints nothing').toMatchObject({
        state: 'refused',
      })
      await mint('mint-2')
      await decide('allowed-once')
      const minted = await mint('mint-2')
      expect(minted.receipt?.state).toBe('completed')
      code = minted.code ?? ''
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
      expect((await mint('mint-2')).code, 'the code is shown once').toBeUndefined()

      const chatDir = join(root, 'chat'),
        deskDir = join(root, 'desk')
      let events = 0
      const inject = (text: string, over: Record<string, unknown> = {}) => {
        const id = `${Date.now()}-${++events}`
        const file = join(chatDir, `tmp-${id}.json`)
        writeFileSync(
          file,
          JSON.stringify({
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
          }),
        )
        renameSync(file, join(chatDir, `in-${id}.json`))
      }
      const sent = () => {
        try {
          return readFileSync(join(chatDir, 'sent.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map(
              (line) =>
                JSON.parse(line) as {
                  target: { chatId: string }
                  message: { blocks: Block[] }
                  messageId: string
                },
            )
        } catch {
          return []
        }
      }
      const deskEvents = () => {
        try {
          return readFileSync(join(deskDir, 'events.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        } catch {
          return []
        }
      }
      const asDesk = async (op: string, ...args: unknown[]) => {
        const id = randomUUID()
        writeFileSync(join(deskDir, `${id}.tmp`), JSON.stringify({ op, args }))
        renameSync(join(deskDir, `${id}.tmp`), join(deskDir, `req-${id}.json`))
        return until(() => {
          try {
            return JSON.parse(readFileSync(join(deskDir, `res-${id}.json`), 'utf8')) as {
              ok: boolean
              value?: { id?: string; sessionId?: string; messageId?: string; state?: string } | null
              error?: { data?: { code?: string } }
            }
          } catch {
            return undefined
          }
        }, `desk ${op}`)
      }

      inject(code.toLowerCase().replace('-', ' '))
      await until(
        () =>
          sent().some((row) =>
            row.message.blocks.some((block) => block.kind === 'text' && block.markdown.includes('已与')),
          )
            ? true
            : undefined,
        'pairing reply',
      )
      const paired = await asDesk('pairing')
      expect(paired.value, 'the service sees its pairing').toMatchObject({
        instanceId: 'desk-bot',
        provider: 'fake-chat',
        userId: 'owner-1',
        chatId: 'owner-dm',
        running: true,
        textChars: 105,
      })
      const pairingId = paired.value?.id as string

      inject('remind me at five', { sender: { userId: 'someone-else', raw: {} } })
      inject('remind me at five')
      const [event] = await until(() => (deskEvents().length ? deskEvents() : undefined), 'owner event')
      expect(event, 'only the paired owner reaches the service').toMatchObject({
        kind: 'message',
        origin: 'owner',
        pairingId,
        instanceId: 'desk-bot',
        chat: { id: 'owner-dm', type: 'dm' },
        sender: { userId: 'owner-1' },
        text: 'remind me at five',
      })
      expect(deskEvents()).toHaveLength(1)

      const reply = await asDesk('send', pairingId, { deliveryKey: 'reminder-1', text: 'It is five.' })
      expect(reply.ok, JSON.stringify(reply.error)).toBe(true)
      const delivered = sent().find((row) =>
        row.message.blocks.some((block) => block.kind === 'text' && block.markdown === 'It is five.'),
      )
      expect(delivered, 'the reply reaches the paired chat').toMatchObject({
        target: { chatId: 'owner-dm' },
        messageId: reply.value?.messageId,
      })

      await client.request('_agnes/v1/admin.managedWorkspaces.grant', { packageId: DESK, workspace })
      const started = await asDesk('sessions.start', {
        bundle: questionBundle,
        workspace,
        input: 'CHANNEL_QUESTION_PROBE',
        startKey: 'native-question',
        retention: 'task',
      })
      expect(started.ok, JSON.stringify(started.error)).toBe(true)
      const sessionId = started.value?.sessionId
      if (!sessionId) throw new Error('managed child not started')
      expect((await asDesk('watchSession', pairingId, 'foreign-child')).ok).toBe(false)
      expect((await asDesk('watchSession', pairingId, sessionId)).ok).toBe(true)
      const native = await until(
        () => sent().find((row) => row.message.blocks.some((block) => block.kind === 'surface')),
        'native question card',
      )
      const block = native.message.blocks.find((row) => row.kind === 'surface') as ChannelSurfaceBlock
      if (block.form.state !== 'open') throw new Error('native question not open')
      expect(block.form.fields.map((field) => field.kind).sort()).toEqual(['multi', 'single', 'text'])
      const questionWaiting = async (id: string) => {
        const result = (await asDesk('sessions.status', id)) as unknown as {
          ok: boolean
          value?: { flags: string[] }
        }
        return result.ok && result.value?.flags.includes('waitingOnUserInput') ? true : undefined
      }
      const turnEnded = async (id: string) => {
        const result = (await asDesk('sessions.events', id)) as unknown as {
          ok: boolean
          value?: { events: { kind: string; status?: string }[] }
        }
        return result.ok &&
          result.value?.events.some((event) => event.kind === 'turn' && event.status === 'completed')
          ? true
          : undefined
      }
      await until(() => turnEnded(sessionId), 'default native question turn returns')
      await until(() => questionWaiting(sessionId), 'default worker reports open native question')

      const action = {
        sessionId,
        surfaceId: block.surfaceId,
        revision: block.revision,
        actionId: block.form.actionId,
        input: { answers: { single: 'A', multi: ['A', 'B'], text: 'verified answer' } },
        selection: {},
      }
      const clicked = { kind: 'cardAction', cardBizId: native.messageId, value: 'surface', surface: action }
      inject('', { ...clicked, sender: { userId: 'stranger', raw: {} } })
      inject('', { ...clicked, cardBizId: 'forwarded-message' })
      await new Promise((resolve) => setTimeout(resolve, 200))
      const child = await client.session.attach(sessionId)
      expect((await child.uiRead({ surfaceId: block.surfaceId })).surfaces.at(0)?.status).toBe('open')
      inject('', clicked)
      await until(
        async () =>
          (await child.uiRead({ surfaceId: block.surfaceId })).surfaces.at(0)?.status === 'closed'
            ? true
            : undefined,
        'channel submits native answers',
      )
      const edits = () => {
        try {
          return readFileSync(join(chatDir, 'edits.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        } catch {
          return []
        }
      }
      await until(
        () =>
          edits().some(
            (row) =>
              row.ref.messageId === native.messageId &&
              row.message.blocks.some(
                (b: ChannelSurfaceBlock) => b.kind === 'surface' && b.form.state === 'closed',
              ),
          )
            ? true
            : undefined,
        'settled card edit',
      )
      inject('', clicked)
      await child.detach()

      const fullStart = await asDesk('sessions.start', {
        bundle: questionBundle,
        workspace,
        input: 'CHANNEL_QUESTION_PROBE',
        startKey: 'native-question-full',
        retention: 'task',
        permission: 'full-access',
      })
      expect(fullStart.ok, JSON.stringify(fullStart.error)).toBe(true)
      const fullSessionId = fullStart.value?.sessionId
      if (!fullSessionId) throw new Error('full access question child not started')
      await until(() => turnEnded(fullSessionId), 'full access native question turn returns')
      await until(() => questionWaiting(fullSessionId), 'full access worker reports open native question')
      const fullChild = await client.session.attach(fullSessionId)
      const fullRecord = (await fullChild.uiRead()).surfaces.find((record) => record.status === 'open')
      if (!fullRecord) throw new Error('full access native question missing')
      await fullChild.uiAction({
        surfaceId: fullRecord.surface.id,
        revision: fullRecord.surface.revision,
        actionId: 'submit',
        commandId: randomUUID(),
        input: { answers: { single: 'A', multi: ['A'], text: 'answer' } },
        selection: {},
      })
      await until(
        async () =>
          (await fullChild.uiRead({ surfaceId: fullRecord.surface.id })).surfaces[0]?.status === 'closed'
            ? true
            : undefined,
        'full access native question closes',
      )
      await fullChild.detach()

      for (const verdict of ['rejected', 'allowed-once'] as const) {
        const marker = verdict === 'rejected' ? 'DENY' : 'ALLOW'
        const childStart = await asDesk('sessions.start', {
          bundle: `${DESK}#worker`,
          workspace,
          input: `CHANNEL_APPROVAL_${marker}`,
          startKey: `approval-${marker}`,
          retention: 'task',
        })
        expect(childStart.ok, JSON.stringify(childStart.error)).toBe(true)
        const approvalSessionId = childStart.value?.sessionId
        if (!approvalSessionId) throw new Error('approval child not started')
        expect((await asDesk('watchSession', pairingId, approvalSessionId)).ok).toBe(true)
        const card = await until(
          () =>
            sent().find((row) =>
              row.message.blocks.some(
                (item) =>
                  item.kind === 'approval' &&
                  item.decisionKey?.startsWith(`${encodeURIComponent(approvalSessionId)}/`),
              ),
            ),
          `managed ${verdict} approval card`,
        )
        const approval = card.message.blocks.find((item) => item.kind === 'approval')
        if (!approval?.decisionKey) throw new Error('approval card has no decision key')
        inject('', {
          kind: 'cardAction',
          cardBizId: card.messageId,
          value: 'approval',
          approval: { decisionKey: approval.decisionKey, verdict },
        })
        await until(async () => {
          const result = (await asDesk('sessions.events', approvalSessionId)) as unknown as {
            ok: boolean
            value?: { events: { kind: string; outcome?: string }[] }
          }
          const outcome = verdict === 'rejected' ? 'rejected' : 'allowed'
          return result.ok &&
            result.value?.events.some(
              (event) => event.kind === 'approvalOutcome' && event.outcome === outcome,
            )
            ? true
            : undefined
        }, `managed ${verdict} outcome`)
        await until(async () => {
          const result = (await asDesk('sessions.result', approvalSessionId)) as unknown as {
            ok: boolean
            value?: { turn: { status: string } | null }
          }
          return result.ok && result.value?.turn?.status === 'completed' ? true : undefined
        }, `managed ${verdict} continued turn`)
        if (verdict === 'allowed-once')
          await until(
            () => (existsSync(join(workspace, 'approval-allow.txt')) ? true : undefined),
            'approved shell runs',
          )
        else expect(existsSync(join(workspace, 'approval-deny.txt'))).toBe(false)
      }

      await sdk?.close()
      await stop(running.daemon, running.exited)
      running = boot(root)
      client = await connect()
      const afterRestart = await until(async () => {
        const value = await asDesk('pairing')
        return value.ok ? value : undefined
      }, 'desk after restart')
      expect(afterRestart.value, 'the pairing survives a restart').toMatchObject({ id: pairingId })
      expect((await asDesk('delivery', pairingId, 'reminder-1')).value).toEqual({
        state: 'delivered',
        messageId: reply.value?.messageId,
      })

      await until(async () => {
        const result = await asDesk('send', pairingId, {
          deliveryKey: 'after-restart',
          text: 'Restored without inbound.',
        })
        return result.ok ? true : undefined
      }, 'paired send after restart')
      expect(
        sent().find((row) =>
          row.message.blocks.some(
            (item) => item.kind === 'text' && item.markdown === 'Restored without inbound.',
          ),
        )?.target,
      ).toMatchObject({ chatId: 'owner-dm', accountId: 'app-1', chatType: 'dm' })

      await operation(await client.packages.disable({ ...(await command()), id: DESK }))
      await operation(await client.packages.remove({ ...(await command()), id: DESK }))
      rmSync(join(deskDir, 'events.jsonl'), { force: true })
      await install(DESK, plugins.desk)
      const reinstalled = await until(async () => {
        const value = await asDesk('pairing')
        return value.ok ? value : undefined
      }, 'reinstalled desk')
      expect(reinstalled.value, 'removing the package released its pairing').toBeNull()
    } catch (error) {
      failures.push(
        new Error(`${String(error)}\nSource daemon stderr:\n${running.log.stderr}`, { cause: error }),
      )
    } finally {
      for (const close of [
        () => sdk?.close(),
        () => provider.close(),
        () => stop(running.daemon, running.exited),
        () => {
          if (code) {
            const leaked = filesUnder(root).filter((file) => {
              try {
                return readFileSync(file).includes(code)
              } catch {
                return false
              }
            })
            expect(leaked, 'the pairing code is never written to disk').toEqual([])
          }
        },
        () => {
          rmSync(root, { recursive: true, force: true })
          for (const socket of sockets) rmSync(dirname(socket), { recursive: true, force: true })
        },
      ]) {
        try {
          await close()
        } catch (error) {
          failures.push(error)
        }
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'channel targets e2e and cleanup failed')
  },
  240_000,
)
