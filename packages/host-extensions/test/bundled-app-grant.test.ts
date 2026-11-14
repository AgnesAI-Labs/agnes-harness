import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context, type Fiber } from '@agnes/cordis'
import type {
  BoundWakes,
  ChannelRuntime,
  ProfileManagedDefinition,
  ProfileManagedHandle,
  ProfileManagedInit,
} from '@agnes/extension-api'
import type { ResolvedPackage } from '@agnes/host-common/profile/types'
import {
  HOST_CAPABILITY_GRANTS,
  type HostGrantDeclaration,
  hashDirectory,
  parseSource,
  type RuntimePluginSnapshot,
} from '@agnes/package-manager'
import type { RowOrigin } from '@agnes/plugin-runtime/host'
import { AGNES_ERRORS, type ManagedServiceDescriptor } from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { pinOptionalBundledRowGrants } from '../src/assemble/host-grants.js'
import { createRowServiceHost } from '../src/ext-host/row-services.js'
import type { BundledAppClientContext } from '../src/profile/bundled-app.js'
import { type BundledAppChannelBridge, BundledAppChannelHub } from '../src/profile/bundled-app-channels.js'
import type { ChannelRuntimeFactory } from '../src/profile/channel-runtime.js'
import { ProfileManagedResources } from '../src/profile/managed.js'
import type { ProfileStreams } from '../src/profile/streams.js'

const SUPERAGENT = {
  id: '@agnes/superagent',
  ref: 'file:./bundled-plugins/superagent',
  row: 'ext:agnes.superagent/main',
  exportName: 'superagentPlugin',
}
const JUDGMENT = {
  id: '@agnes/judgment',
  ref: 'file:./bundled-plugins/judgment',
  row: 'ext:agnes.judgment/main',
  exportName: 'judgmentPlugin',
}
type Identity = typeof SUPERAGENT
const descriptor: ManagedServiceDescriptor = {
  id: 'app',
  scope: 'profile',
  artifact: { kind: 'in-process' },
  healthPath: '/health',
  apiVersion: '1.0.0',
  listeners: [],
  startupTimeoutMs: 5000,
  shutdownTimeoutMs: 5000,
  requires: [],
}
const wakes: BoundWakes = {
  async enqueue() {
    throw new Error('unbound')
  },
  async read() {
    throw new Error('unbound')
  },
}
const temporary: string[] = []
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => undefined)
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

/** A release-shaped payload whose digest stands in for the shipped bundled-plugin digest. */
function release(identity: Identity, manifestExtra: Record<string, unknown> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agh-bundled-app-')))
  temporary.push(root)
  const directory = join(root, 'payload')
  mkdirSync(directory)
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name: identity.id,
      version: '0.1.0',
      license: 'MIT',
      type: 'module',
      exports: './index.mjs',
      agnes: {
        plugins: [
          {
            id: identity.row,
            export: identity.exportName,
            apiRange: '^5.0.0',
            runtime: 'in-process',
            inject: ['profileRuntime'],
            capabilities: { store: true, managedServices: [descriptor] },
          },
        ],
      },
      ...manifestExtra,
    }),
  )
  writeFileSync(join(directory, 'index.mjs'), `export const ${identity.exportName} = { apply() {} }\n`)
  return { root, directory, digest: hashDirectory(directory) }
}

type Fixture = ReturnType<typeof release>

async function harness(options: {
  identity?: Identity
  fixture?: Fixture
  /** The tree the installed row actually runs; defaults to the release payload. */
  installed?: string
  declarations?: readonly HostGrantDeclaration[]
  source?: string
  current?: () => boolean
  definition?: Partial<ProfileManagedDefinition<unknown>> & Record<string, unknown>
  /** Also run a channel package row whose channel runtime is `runtime`, sharing `hub` with the grant. */
  channel?: { hub: BundledAppChannelHub; runtime: ChannelRuntimeFactory }
}) {
  const identity = options.identity ?? SUPERAGENT
  const fixture = options.fixture ?? release(identity)
  const installed = options.installed ?? fixture.directory
  const integrity = hashDirectory(installed)
  const pkg: ResolvedPackage = {
    id: identity.id,
    version: '0.1.0',
    source: options.source ?? identity.ref,
    integrity,
    trust: 'trusted',
    enabled: true,
  }
  const source: RuntimePluginSnapshot = {
    trusted: true,
    enabled: true,
    generation: 1,
    snapshot: {
      packageId: pkg.id,
      source: parseSource(pkg.source),
      snapshotId: integrity,
      version: pkg.version,
      integrity,
      treeIntegrity: integrity,
      profile: 'local-dev',
      capabilityHash: 'test',
      directory: installed,
      contributions: [],
    },
  }
  const origin: RowOrigin = Object.freeze({
    trustTier: 'third-party',
    packageId: identity.id,
    snapshotId: integrity,
    rowRevision: 'row:1',
    rowId: identity.row,
    exportName: identity.exportName,
    declaredProvides: [],
  })
  const hostGrants = pinOptionalBundledRowGrants(
    [pkg],
    () => source,
    options.declarations ?? HOST_CAPABILITY_GRANTS,
    () => ({ root: fixture.root, path: 'payload' }),
    [{ id: identity.id, ref: identity.ref }],
  )
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'agh-bundled-app-data-')))
  temporary.push(dataDir)
  const leases: { context: BundledAppClientContext; closed: boolean; client: object }[] = []
  let alive = true
  const current = options.current ?? (() => alive)
  const managed = new ProfileManagedResources(
    `bundled-app:${randomUUID()}`,
    () => wakes,
    () => current(),
  )
  closers.push(() => managed.close())
  const data = new Map<string, unknown>()
  const host = createRowServiceHost(() => ({ version: pkg.version, integrity }), {
    managed,
    streams: {} as ProfileStreams,
    namespace: () => ({
      get: (key) => structuredClone(data.get(key)),
      set: (key, value) => {
        data.set(key, structuredClone(value))
      },
      delete: (key) => {
        data.delete(key)
      },
      entries: () => [...data].map(([key, value]) => ({ key, value })),
      transaction: (fn) => fn(),
    }),
    describe: (packageId) =>
      packageId === CHAT.packageId
        ? {
            integrity,
            declaredCapabilities: {
              store: true,
              network: ['chat.example.test'],
              managedServices: [{ ...descriptor, id: 'channel' }],
            },
          }
        : { integrity, declaredCapabilities: { store: true, managedServices: [descriptor] } },
    hostGrants,
    ...(options.channel
      ? {
          channelRuntime: options.channel.runtime,
          channelStateDirectory: join(dataDir, 'channels'),
          channelScope: { home: dataDir, profile: 'local-dev', dataDir, workspace: dataDir },
          resolveSecret: () => {
            throw new Error('no secrets in this test')
          },
          channelLog: { debug() {}, info() {}, warn() {}, error() {} },
        }
      : {}),
    bundledApp: {
      ...(options.channel ? { channels: options.channel.hub } : {}),
      stateRoot: join(dataDir, 'bundled-apps'),
      scope: { home: dataDir, profile: 'local-dev', dataDir, workspace: dataDir },
      client(context) {
        const lease = { context, closed: false, client: { lease: leases.length } }
        leases.push(lease)
        return {
          client: lease.client,
          async close() {
            lease.closed = true
          },
        }
      },
    },
  })
  const root = new Context()
  const origins = new WeakMap<Fiber, RowOrigin>()
  host.installRoot(root, { lookup: (fiber) => origins.get(fiber) })
  const inits: ProfileManagedInit[] = []
  let handle: ProfileManagedHandle<unknown> | undefined
  const definition = {
    id: 'app',
    configSchema: {
      type: 'object',
      properties: { bundledApp: { type: 'object' } },
      additionalProperties: false,
    },
    defaultConfig: {},
    async start(init: ProfileManagedInit) {
      inits.push(init)
      init.onShutdown(async () => ({ state: 'settled' }))
      init.ready()
      return { started: inits.length }
    },
    ...options.definition,
  } as ProfileManagedDefinition<unknown>
  if (options.channel) {
    root.provide('providers', { register: () => () => {} })
    const chat = Object.freeze({ ...origin, ...CHAT })
    await root.plugin((ctx) => {
      origins.set(ctx.fiber, chat)
      ctx.profileRuntime.registerChannel!(chatProvider)
    })
  }
  const row = root.plugin((ctx) => {
    origins.set(ctx.fiber, origin)
    handle = ctx.profileRuntime.register(definition)
  })
  await row
  await managed.publish()
  await handle?.get()
  return {
    dataDir,
    leases,
    managed,
    row,
    init: () => inits.at(-1) as ProfileManagedInit,
    handle: handle as ProfileManagedHandle<unknown>,
    retire() {
      alive = false
    },
  }
}

/** A channel package row; its provider never connects anywhere, the channel runtime is stubbed. */
const CHAT = { packageId: '@sample/chat', rowId: 'ext:sample.chat/main', exportName: 'chatPlugin' }
const chatProvider = {
  id: 'sample',
  version: '1.0.0',
  manifest: {
    id: 'sample',
    displayName: 'Sample',
    version: '1.0.0',
    connection: { modes: ['websocket'], default: 'websocket' },
    capabilities: { edit: false, card: false, thread: true, attachment: false },
    credentials: { required: [], optional: [], exposes: [] },
    limits: { textChars: 1000, cardBytes: 1000, editWindowMs: 0 },
    events: { supported: ['message'] },
  },
  create() {
    throw new Error('the stubbed channel runtime never creates an adapter')
  },
} as unknown as import('@agnes/extension-api').ChannelProvider

const denied = (fn: () => unknown) =>
  expect(fn).toThrow(expect.objectContaining({ code: AGNES_ERRORS.CAPABILITY_DENIED }))

it('package with the bundledApp host grant gets bundledApp with a platform-chosen stateDirectory', async () => {
  const app = await harness({})
  const grant = app.init().bundledApp
  expect(grant, 'the whitelisted bundled package receives the grant').toBeDefined()
  if (!grant) return
  expect(grant.stateDirectory.startsWith(join(app.dataDir, 'bundled-apps'))).toBe(true)
  expect(statSync(grant.stateDirectory).isDirectory()).toBe(true)
  if (process.platform !== 'win32') expect(statSync(grant.stateDirectory).mode & 0o077).toBe(0)
  expect(app.leases).toHaveLength(1)
  expect(grant.client).toBe(app.leases[0]?.client)
  expect(app.leases[0]?.context).toMatchObject({
    stateDirectory: grant.stateDirectory,
    clientId: expect.stringContaining(SUPERAGENT.id),
  })
  expect(() => grant.assertCurrent()).not.toThrow()
  // Channel access is wired by the channel runtime; until then every call is refused.
  denied(() => grant.channels.subscribe('feishu', ['chat'], () => {}))
  await expect(grant.channels.listChats('feishu')).rejects.toMatchObject({
    code: AGNES_ERRORS.CAPABILITY_DENIED,
  })
  // The production release declaration whitelists exactly this package.
  expect(
    HOST_CAPABILITY_GRANTS.filter((declaration) =>
      [declaration.package, ...Object.values(declaration.extensions)].some((grant) => grant.bundledApp),
    ).map((declaration) => declaration.packageId),
  ).toEqual([SUPERAGENT.id])
  // The directory is stable for the same package across restarts.
  await app.managed.publish('upgrade', true)
  await app.handle.get()
  expect(app.init().bundledApp?.stateDirectory).toBe(grant.stateDirectory)
})

it('in-process plugins without the grant get no bundledApp', async () => {
  // Judgment holds other Host grants through the same release path, but not bundledApp.
  const judgment = await harness({ identity: JUDGMENT })
  expect(judgment.init()).toBeDefined()
  expect(judgment.init().bundledApp).toBeUndefined()
  expect(judgment.leases).toEqual([])
  // A release declaration without bundledApp grants nothing either.
  const none = await harness({
    declarations: [{ packageId: SUPERAGENT.id, package: {}, extensions: {}, seams: {} }],
  })
  expect(none.init().bundledApp).toBeUndefined()
  expect(none.leases).toEqual([])
})

it('a tree whose integrity differs from the release digest gets no bundledApp', async () => {
  const fixture = release(SUPERAGENT)
  const tampered = join(dirname(fixture.directory), 'installed')
  mkdirSync(tampered)
  for (const name of ['package.json', 'index.mjs'])
    writeFileSync(join(tampered, name), readFileSync(join(fixture.directory, name)))
  writeFileSync(join(tampered, 'extra.mjs'), 'export {}\n')
  const app = await harness({ fixture, installed: tampered })
  expect(app.init().bundledApp).toBeUndefined()
  expect(app.leases).toEqual([])
})

it('grant is fenced on disable and on generation change', async () => {
  const disabled = await harness({})
  const grant = disabled.init().bundledApp
  if (!grant) throw new Error('grant missing')
  await disabled.row.dispose()
  await disabled.managed.publish('disable')
  denied(() => grant.assertCurrent())
  expect(disabled.leases[0]?.closed, 'disable closes the client connection').toBe(true)
  expect(() => disabled.leases[0]?.context.assertCurrent()).toThrow()

  const upgraded = await harness({})
  const old = upgraded.init().bundledApp
  if (!old) throw new Error('grant missing')
  upgraded.retire()
  await upgraded.managed.publish('upgrade')
  denied(() => old.assertCurrent())
  expect(upgraded.leases[0]?.closed, 'generation change closes the client connection').toBe(true)
  await expect(upgraded.handle.get()).rejects.toThrow()
})

it('grant cannot be supplied by package code or configuration', async () => {
  const forged = {
    stateDirectory: '/tmp/forged',
    client: { forged: true },
    channels: {},
    assertCurrent() {},
  }
  // A package without the release grant cannot request it through its definition or config.
  const ungranted = await harness({
    declarations: [],
    definition: { bundledApp: forged, defaultConfig: { bundledApp: { stateDirectory: '/tmp/forged' } } },
  })
  expect(ungranted.init().bundledApp).toBeUndefined()
  expect(ungranted.leases).toEqual([])
  // A manifest field cannot ask for Host grants; the row fails verification and grants nothing.
  const manifest = await harness({
    fixture: release(SUPERAGENT, { agnesHostGrants: { bundledApp: true } }),
    declarations: [],
  })
  expect(manifest.init().bundledApp).toBeUndefined()
  // The same package id from an ordinary source is not the shipped payload.
  const local = await harness({ source: 'file:./superagent' })
  expect(local.init().bundledApp).toBeUndefined()
  // A granted package cannot replace the Host-chosen values.
  const granted = await harness({
    definition: { bundledApp: forged, defaultConfig: { bundledApp: { stateDirectory: '/tmp/forged' } } },
  })
  const grant = granted.init().bundledApp
  expect(grant?.stateDirectory).not.toBe(forged.stateDirectory)
  expect(grant?.client).toBe(granted.leases[0]?.client)
})

it('channels reach the channel host', async () => {
  // The channel runtime of a channel row attaches its running instance to the hub it is handed,
  // as the channel bridge does; the bundled app reaches that instance only through its grant.
  const hub = new BundledAppChannelHub()
  const bridges: BundledAppChannelBridge[] = []
  const sent: unknown[] = []
  const runtime: ChannelRuntimeFactory = async (_provider, init, context) => {
    const bridge = context.subscriptions
    if (!bridge) throw new Error('the channel runtime was not handed the bundled-app hub')
    bridges.push(bridge)
    const unlink = bridge.attach('team', {
      connected: () => true,
      capabilities: () => ({
        edit: false,
        card: false,
        thread: true,
        attachment: false,
        read: { chats: true },
      }),
      send: async (target, message) => {
        sent.push([target, message])
        return { chatId: target.chatId, messageId: 'sent-1' }
      },
      reads: () => ({ listChats: async () => ({ chats: [{ id: 'group-a', name: 'Team' }] }) }),
      bound: () => false,
    })
    init.onShutdown(async () => {
      unlink()
      return { state: 'settled' }
    })
    init.ready()
    return { status: () => ({ provider: 'sample', instances: [] }) } as unknown as ChannelRuntime
  }
  const app = await harness({ channel: { hub, runtime } })
  const grant = app.init().bundledApp
  if (!grant) throw new Error('grant missing')
  // The channel row starts beside the app, and nothing above waits for it.
  await vi.waitFor(() => expect(bridges).toHaveLength(1))

  const received: string[] = []
  grant.channels.subscribe('team', ['group-a'], (event) => received.push(event.eventId))
  const bridge = bridges[0]!
  expect(bridge.claimed('team', 'group-a')).toBe(true)
  bridge.deliver('team', {
    kind: 'message',
    eventId: 'event-1',
    messageId: 'message-1',
    accountId: 'account',
    text: 'hello',
    attachments: [],
    at: '2026-11-14T00:00:00.000Z',
    chat: { id: 'group-a', type: 'group' },
    sender: { userId: 'user', raw: {} },
    mentions: { bot: false, replyToBot: false, quoteBot: false },
  })
  expect(received).toEqual(['event-1'])
  expect(await grant.channels.listChats('team')).toEqual([{ id: 'group-a', name: 'Team' }])
  await expect(
    grant.channels.send('team', { chatId: 'group-a' }, { blocks: [{ kind: 'text', markdown: 'on it' }] }),
  ).resolves.toEqual({ chatId: 'group-a', messageId: 'sent-1' })
  expect(sent).toHaveLength(1)
  // Undeclared reads stay refused through the grant.
  await expect(grant.channels.listMembers('team', 'group-a')).rejects.toMatchObject({
    code: AGNES_ERRORS.CAPABILITY_DENIED,
  })

  // Disabling the bundled app ends its claim and its channel access.
  await app.row.dispose()
  await app.managed.publish('disable')
  expect(bridge.claimed('team', 'group-a')).toBe(false)
  denied(() => grant.channels.subscribe('team', ['group-b'], () => {}))
  await expect(grant.channels.listChats('team')).rejects.toMatchObject({
    code: AGNES_ERRORS.CAPABILITY_DENIED,
  })
})

/** A service whose shutdown records what its grant allows while it runs. */
function recordingShutdown(
  seen: Record<string, unknown>[],
  leases: () => { closed: boolean; context: BundledAppClientContext }[],
  inits: ProfileManagedInit[] = [],
) {
  return {
    async start(init: ProfileManagedInit) {
      inits.push(init)
      init.onShutdown(async (reason) => {
        const lease = leases()[0]
        const allowed = (fn: () => unknown) => {
          try {
            fn()
            return true
          } catch {
            return false
          }
        }
        seen.push({
          reason,
          grant: allowed(() => init.bundledApp?.assertCurrent()),
          connect: allowed(() => lease?.context.assertCurrent()),
          signal: lease?.context.signal.aborted,
          closed: lease?.closed,
        })
        return { state: 'settled' }
      })
      init.ready()
      return {}
    },
  }
}

it('keeps the grant and its client usable for the shutdown, then fences and closes it', async () => {
  for (const change of ['disable', 'upgrade'] as const) {
    const seen: Record<string, unknown>[] = []
    let leases: { closed: boolean; context: BundledAppClientContext }[] = []
    const inits: ProfileManagedInit[] = []
    const app = await harness({ definition: recordingShutdown(seen, () => leases, inits) })
    leases = app.leases
    const grant = inits[0]?.bundledApp
    if (!grant) throw new Error('grant missing')
    if (change === 'disable') await app.row.dispose()
    else app.retire()
    await app.managed.publish(change)
    // During the shutdown the service is no longer current, but its grant and client still work.
    expect(seen, change).toEqual([
      { reason: change, grant: true, connect: true, signal: false, closed: false },
    ])
    // Once the shutdown returned, the grant is fenced and the connection closed.
    denied(() => grant.assertCurrent())
    expect(app.leases[0]?.closed).toBe(true)
    expect(app.leases[0]?.context.signal.aborted).toBe(true)
    expect(() => app.leases[0]?.context.assertCurrent()).toThrow()
  }
})

it('refuses the grant of a retired app until its shutdown begins, when a publication waits for an earlier one', async () => {
  // The second instance is still starting when the next publication retires it: that publication aborts its
  // lifetime at once, but stops it only once the start returns, which the gate holds. The app is still current.
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const seen: Record<string, unknown>[] = []
  let leases: { closed: boolean; context: BundledAppClientContext }[] = []
  const inits: ProfileManagedInit[] = []
  const recording = recordingShutdown(seen, () => leases.slice(-1), inits)
  const app = await harness({
    definition: {
      async start(init: ProfileManagedInit) {
        const value = await recording.start(init)
        if (inits.length === 2) await gate
        return value
      },
    },
  })
  leases = app.leases
  await app.managed.publish('upgrade', true)
  await vi.waitFor(() => expect(inits).toHaveLength(2))
  const grant = inits[1]?.bundledApp
  if (!grant) throw new Error('grant missing')
  grant.assertCurrent()
  const retiring = app.managed.publish('upgrade', true)
  try {
    // Retired but not yet told to shut down: neither the grant nor its client may act or reconnect.
    denied(() => grant.assertCurrent())
    expect(() => app.leases[1]?.context.assertCurrent()).toThrow()
    await expect(grant.channels.listChats('team')).rejects.toMatchObject({
      code: AGNES_ERRORS.CAPABILITY_DENIED,
    })
  } finally {
    release()
    await retiring
  }
  // Its shutdown, when it came, still had the grant; afterwards the grant is closed for good.
  expect(seen.at(-1)).toMatchObject({ grant: true, connect: true, signal: false, closed: false })
  denied(() => grant.assertCurrent())
  expect(app.leases[1]?.closed).toBe(true)
})

it('stops a bundled app at once when a target drops its row, and starts it again when a later one keeps it', async () => {
  const seen: Record<string, unknown>[] = []
  let leases: { closed: boolean; context: BundledAppClientContext }[] = []
  const app = await harness({ definition: recordingShutdown(seen, () => leases) })
  leases = app.leases
  // A target that keeps the row changes nothing.
  await app.managed.retireDropped([{ id: SUPERAGENT.row }])
  expect(seen).toEqual([])
  expect(app.managed.statuses(SUPERAGENT.id).map((row) => row.state)).toEqual(['ready'])
  // A target without the row stops the service before any publication, as a disable, with its grant usable.
  await app.managed.retireDropped([{ id: 'ext:other/main' }, { id: SUPERAGENT.row, disabled: true }])
  expect(seen).toEqual([{ reason: 'disable', grant: true, connect: true, signal: false, closed: false }])
  expect(app.leases[0]?.closed).toBe(true)
  await expect(app.handle.get()).rejects.toThrow()
  // If the row stays after all (the target was not applied), the next publication starts the service again.
  await app.managed.publish()
  await app.handle.get()
  expect(app.leases).toHaveLength(2)
  expect(app.leases[1]?.closed).toBe(false)
})

it('leaves resources without the bundled-app grant to the publication', async () => {
  const judgment = await harness({ identity: JUDGMENT })
  await judgment.managed.retireDropped([])
  expect(await judgment.handle.get()).toBeDefined()
})

it('stops a package without the grant, and an upgraded bundled app, only when the publication retires them', async () => {
  // A package without the grant whose row a target drops: the target's early stop leaves it running.
  const seen: Record<string, unknown>[] = []
  const judgment = await harness({ identity: JUDGMENT, definition: recordingShutdown(seen, () => []) })
  await judgment.managed.retireDropped([{ id: 'ext:other/main' }])
  expect(seen).toEqual([])
  expect(judgment.managed.statuses(JUDGMENT.id).map((row) => row.state)).toEqual(['ready'])
  await judgment.row.dispose()
  await judgment.managed.publish('disable')
  expect(seen.map((entry) => entry.reason)).toEqual(['disable'])

  // A bundled app whose row the target keeps, as an upgrade does: it stops when the new generation's
  // publication retires it, not before.
  const upgraded: Record<string, unknown>[] = []
  let leases: { closed: boolean; context: BundledAppClientContext }[] = []
  const app = await harness({ definition: recordingShutdown(upgraded, () => leases) })
  leases = app.leases
  await app.managed.retireDropped([{ id: SUPERAGENT.row }])
  expect(upgraded).toEqual([])
  expect(app.leases[0]?.closed).toBe(false)
  app.retire()
  await app.managed.publish('upgrade')
  expect(upgraded).toEqual([{ reason: 'upgrade', grant: true, connect: true, signal: false, closed: false }])
})
