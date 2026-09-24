import { AsyncLocalStorage } from 'node:async_hooks'
import type {
  ExtensionAPI,
  HookEvent,
  HookHandler,
  HookInvocationSnapshot,
  PlatformFacts,
} from '@agnes/extension-api'
import { EXTENSION_ERROR_CODES, ExtensionError, unavailableProjections } from '@agnes/extension-api'
import type { CcHookGroup } from '../extensions/hooks-runner/src/config.js'
import {
  type HooksRunnerExtensionDeps,
  preparedHooksRunnerExtension,
} from '../extensions/hooks-runner/src/index.js'
import type { CcHookMap } from '../extensions/hooks-runner/src/map.js'
import { runnerLease } from './runner-context.js'
import { loadRunnerExtension } from './runner-extension.js'
import type { SeamInitContext } from './seam-init.js'

const MAX_FRAME = 1024 * 1024
const MAX_QUEUED = 2 * MAX_FRAME
type Message = Record<string, unknown>
type Bootstrap = {
  groups: CcHookGroup[]
  map: CcHookMap
  profile: SeamInitContext['profile']
  lease: ExtensionAPI['ctx']['lease']
  platform: PlatformFacts
  workspaceSnapshots: boolean
}

let handlers = new Map<string, HookHandler<HookEvent>>()
const invocations = new Map<string, AbortController>()
const capabilityPending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>()
const invocationScope = new AsyncLocalStorage<string>()
let buffered = Buffer.alloc(0)
let capabilitySequence = 0
let disposer: (() => void | Promise<void>) | undefined
let phase: 'new' | 'preparing' | 'ready' | 'closing' = 'new'

const record = (value: unknown): value is Message =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function send(message: Message): void {
  const body = Buffer.from(JSON.stringify({ protocol: 1, ...message }))
  if (body.byteLength > MAX_FRAME || process.stdout.writableLength + body.byteLength + 4 > MAX_QUEUED)
    throw new Error('E_EXT_ISOLATION_PROTOCOL: outbound frame limit')
  const output = Buffer.allocUnsafe(body.byteLength + 4)
  output.writeUInt32BE(body.byteLength)
  body.copy(output, 4)
  process.stdout.write(output)
}

function capability(method: string, input: unknown): Promise<unknown> {
  const invocationId = invocationScope.getStore()
  if (!invocationId) return Promise.reject(new Error('capability unavailable outside invocation'))
  const requestId = `c-${++capabilitySequence}`
  return new Promise((resolve, reject) => {
    capabilityPending.set(requestId, { resolve, reject })
    send({ kind: 'capability', requestId, invocationId, method, input })
  })
}

function bootstrap(value: unknown): Bootstrap {
  if (!record(value)) throw new Error('invalid bootstrap')
  const groups = value.groups
  const map = value.map
  const profile = value.profile
  const lease = value.lease
  const platform = value.platform
  const workspaceSnapshots = value.workspaceSnapshots === true
  if (!Array.isArray(groups) || !record(map) || !record(profile) || !record(lease) || !record(platform))
    throw new Error('invalid bootstrap')
  return {
    groups: groups as CcHookGroup[],
    map: map as CcHookMap,
    profile: profile as unknown as SeamInitContext['profile'],
    lease: runnerLease(lease),
    platform: Object.freeze(platform) as unknown as PlatformFacts,
    workspaceSnapshots,
  }
}

async function prepare(message: Message): Promise<void> {
  if (
    typeof message.extensionId !== 'string' ||
    message.packageDigest !== process.env.AGNES_PACKAGE_DIGEST ||
    message.manifestDigest !== process.env.AGNES_MANIFEST_DIGEST ||
    typeof message.data !== 'object'
  )
    throw new Error('invalid extension identity')
  if (record(message.data) && message.data.kind === 'extension') {
    if (!record(message.data.context) || message.data.context.extId !== message.extensionId)
      throw new Error('extension identity mismatch')
    const loaded = await loadRunnerExtension(message.data, capability, (event) => {
      if (phase !== 'ready') return false
      send({ kind: 'unregister', event })
      return true
    })
    handlers = loaded.handlers
    disposer = loaded.dispose
    phase = 'ready'
    send({
      kind: 'ready',
      events: [...new Set(loaded.registrations.values())],
      hooks: [...loaded.registrations].map(([id, event]) => ({ id, event })),
    })
    return
  }
  if (message.extensionId !== 'agnes/hooks-runner') throw new Error('unknown fixed adapter')
  const input = bootstrap(message.data)
  const shutdown = new AbortController()
  const log = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} })
  const sandbox = {
    enforcement: () => ({ level: 'l1', scope: ['process'] }),
    exec: (argv: string[], options: Record<string, unknown>) =>
      capability('exec', { argv, options }) as ReturnType<NonNullable<SeamInitContext['sandbox']>['exec']>,
  } as unknown as NonNullable<SeamInitContext['sandbox']>
  const init = {
    profile: input.profile,
    log,
    signal: shutdown.signal,
    sandbox,
  } as unknown as SeamInitContext
  const api = {
    registerHook(event: HookEvent, handler: HookHandler<HookEvent>) {
      if (handlers.has(event)) throw new Error('duplicate hook event')
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    events: { append: (name: string, data: unknown) => capability('events.append', { name, data }) },
    ctx: {
      extId: 'agnes/hooks-runner',
      version: '0.1.0',
      trust: 'builtin',
      lease: input.lease,
      log,
      signal: shutdown.signal,
      info: { agnesVersion: '0.0.0', apiVersion: '1.0.0', profileName: input.profile.name },
      platform: input.platform,
    },
    registerTool() {
      throw new Error('tools unavailable')
    },
    registerSlot() {
      throw new Error('slots unavailable')
    },
    registerResource() {
      throw new Error('resources unavailable')
    },
  } as unknown as ExtensionAPI
  const deps: HooksRunnerExtensionDeps = {
    map: input.map,
    sandbox,
    workspaceSnapshots: input.workspaceSnapshots,
    workspaceSandboxProxy: true,
    runHttp: (_client, spec, payload) =>
      capability('http.run', {
        spec: { ...spec, signal: undefined },
        payload,
      }) as ReturnType<NonNullable<HooksRunnerExtensionDeps['runHttp']>>,
  }
  const returned = await preparedHooksRunnerExtension(init, deps, input.groups)(api)
  if (typeof returned === 'function') disposer = returned
  else if (returned !== undefined) throw new Error('invalid disposer')
  phase = 'ready'
  send({ kind: 'ready', events: [...handlers.keys()] })
}

async function invoke(message: Message): Promise<void> {
  if (typeof message.requestId !== 'string' || typeof message.event !== 'string')
    throw new Error('invalid invocation')
  const requestId = message.requestId
  const event = message.event as HookEvent
  const handler = handlers.get(event)
  if (!handler || !record(message.context) || !record(message.context.platform) || invocations.has(requestId))
    throw new Error('unknown or duplicate hook invocation')
  const controller = new AbortController()
  invocations.set(requestId, controller)
  try {
    const context = message.context
    const result = await invocationScope.run(requestId, () =>
      handler(
        (Array.isArray(context.surface) && record(message.payload)
          ? { ...message.payload, getSurface: () => context.surface }
          : message.payload) as never,
        {
          session: context.session as never,
          lease: runnerLease(context.lease),
          projections: unavailableProjections,
          replayed: context.replayed === true,
          platform: Object.freeze(context.platform) as never,
          ...(record(context.workspaceHooks)
            ? { workspaceHooks: context.workspaceHooks as HookInvocationSnapshot }
            : {}),
          signal: controller.signal,
          log: Object.freeze({ debug() {}, info() {}, warn() {}, error() {} }),
        },
      ),
    )
    send({ kind: 'result', requestId, value: result ?? null, undefined: result === undefined })
  } catch {
    send({ kind: 'error', requestId })
  } finally {
    invocations.delete(requestId)
  }
}

function dispatch(message: Message): void {
  if (message.protocol !== 1 || typeof message.kind !== 'string') throw new Error('invalid envelope')
  if (message.kind === 'prepare') {
    if (phase !== 'new') throw new Error('duplicate prepare')
    phase = 'preparing'
    void prepare(message).catch(() => process.exit(70))
    return
  }
  if (message.kind === 'invoke') {
    if (phase !== 'ready') throw new Error('invocation before ready')
    void invoke(message)
    return
  }
  if (message.kind === 'cancel') {
    if (typeof message.requestId !== 'string') throw new Error('invalid cancel')
    invocations.get(message.requestId)?.abort()
    return
  }
  if (message.kind === 'capability-result') {
    if (typeof message.requestId !== 'string') throw new Error('invalid capability result')
    const pending = capabilityPending.get(message.requestId)
    if (!pending) throw new Error('unknown capability result')
    capabilityPending.delete(message.requestId)
    if (message.ok === true) pending.resolve(message.value)
    else
      pending.reject(
        typeof message.code === 'string' && EXTENSION_ERROR_CODES.includes(message.code as never)
          ? new ExtensionError(
              message.code as (typeof EXTENSION_ERROR_CODES)[number],
              'host capability refused',
            )
          : new Error('host capability failed'),
      )
    return
  }
  if (message.kind === 'close') {
    if (phase === 'closing') throw new Error('duplicate close')
    phase = 'closing'
    for (const controller of invocations.values()) controller.abort()
    void Promise.resolve()
      .then(() => disposer?.())
      .then(
        () => {
          send({ kind: 'closed' })
          process.exit(0)
        },
        () => process.exit(70),
      )
    return
  }
  throw new Error('unknown message kind')
}

process.stdin.on('data', (chunk: Buffer) => {
  try {
    buffered = Buffer.concat([buffered, chunk])
    while (buffered.byteLength >= 4) {
      const length = buffered.readUInt32BE(0)
      if (length > MAX_FRAME) throw new Error('frame exceeds limit')
      if (buffered.byteLength < length + 4) break
      const bytes = buffered.subarray(4, length + 4)
      buffered = buffered.subarray(length + 4)
      const message: unknown = JSON.parse(bytes.toString('utf8'))
      if (!record(message)) throw new Error('invalid message')
      dispatch(message)
    }
  } catch {
    process.exit(70)
  }
})
process.stdin.on('end', () => process.exit(buffered.byteLength === 0 ? 0 : 70))

send({ kind: 'hello', nonce: process.env.AGNES_ISOLATION_NONCE ?? '', pid: process.pid })
