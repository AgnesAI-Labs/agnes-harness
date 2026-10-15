import { createServer } from 'node:net'
import type {
  BoundWakes,
  OwnedStore,
  ProfileManagedDefinition,
  ProfileManagedInit,
} from '@agnes/extension-api'
import type { JsonValue, ManagedServiceDescriptor } from '@agnes/protocol'
import { rpcError } from '@agnes/protocol'
import { compileExtensionSchema } from '../ext-host/json-schema.js'
import { managedStore } from './managed-store.js'

type Reason = 'disable' | 'upgrade' | 'exit'
type Resource = {
  owner: string
  packageId: string
  revision: string
  id: string
  lifetime: AbortController
  value: Promise<unknown>
  stop(reason: Reason): Promise<void>
  status: {
    state: 'starting' | 'ready' | 'stopping' | 'failed' | 'stopped'
    code?: string
    endpoints?: Record<string, { host: '127.0.0.1'; port: number }>
  }
}
const profiles = new Map<
  string,
  { manager: ProfileManagedResources; stamp: string; resources: Resource[]; draining: Promise<void> }
>()
/** Only the current profile publication may run resources. Staged/pinned trees only register factories. */
export class ProfileManagedResources {
  private readonly definitions: {
    owner: string
    packageId: string
    integrity: string
    revision: string
    definition: ProfileManagedDefinition<unknown>
    descriptor: ManagedServiceDescriptor
    store: OwnedStore
    wakesAllowed?: boolean
    assert(): void
  }[] = []
  private closed = false
  constructor(
    private readonly key: string,
    private readonly wakes: (owner: string, integrity: string) => BoundWakes,
    private readonly current?: (owner: string, integrity: string, revision: string) => boolean,
  ) {}
  register<T>(input: {
    owner: string
    packageId: string
    integrity: string
    revision: string
    descriptor: ManagedServiceDescriptor
    definition: ProfileManagedDefinition<T>
    store: OwnedStore
    wakesAllowed?: boolean
    assert(): void
  }) {
    if (
      this.closed ||
      this.definitions.some((d) => d.owner === input.owner && d.definition.id === input.definition.id)
    )
      throw rpcError('CAPABILITY_DENIED')
    input = {
      ...input,
      descriptor: structuredClone(input.descriptor),
      definition: {
        ...input.definition,
        configSchema: structuredClone(input.definition.configSchema),
        defaultConfig: structuredClone(input.definition.defaultConfig),
      },
    }
    const validate = compileExtensionSchema(input.definition.configSchema, 'E_SERVICE_DEF')
    if (!validate(input.definition.defaultConfig)) throw rpcError('INVALID_PARAMS')
    this.definitions.push(input as (typeof this.definitions)[number])
    const configKey = `managed-config:${input.definition.id}`
    const resource = () => {
      input.assert()
      if (this.current && !this.current(input.owner, input.integrity, input.revision))
        throw rpcError('CAPABILITY_DENIED')
      const current = profiles
        .get(this.key)
        ?.resources.find(
          (r) => r.owner === input.owner && r.revision === input.revision && r.id === input.definition.id,
        )
      if (!current) throw rpcError('CAPABILITY_DENIED')
      return current
    }
    return {
      release: () => {
        const index = this.definitions.indexOf(input as (typeof this.definitions)[number])
        if (index >= 0) this.definitions.splice(index, 1)
      },
      get: async (): Promise<T> => {
        await this.settle()
        const r = resource(),
          value = await r.value
        if (resource() !== r || r.status.state !== 'ready' || r.lifetime.signal.aborted)
          throw rpcError('CAPABILITY_DENIED')
        return value as T
      },
      configuration: () => structuredClone(input.store.get(configKey) ?? input.definition.defaultConfig),
      status: () => structuredClone(resource().status) as unknown as JsonValue,
      retry: async () => {
        const r = resource()
        if (r.status.state !== 'failed' || r.status.code === 'shutdown-unconfirmed')
          throw rpcError('CAPABILITY_DENIED')
        // Reserve the failed slot before yielding so two approved retries cannot start twins.
        r.status = { state: 'starting' }
        const next = await this.start(input)
        const profile = profiles.get(this.key)
        if (!profile || profile.manager !== this) {
          await next.stop('disable')
          throw rpcError('CAPABILITY_DENIED')
        }
        profile.resources.splice(profile.resources.indexOf(r), 1, next)
        await next.value
        return null
      },
      configure: async (config: JsonValue) => {
        resource()
        if (!validate(config)) throw rpcError('INVALID_PARAMS')
        input.store.set(configKey, config)
        await this.publish('upgrade', true)
        return null
      },
      check: async (value: JsonValue, signal: AbortSignal) => {
        const r = resource(),
          instance = await r.value
        signal.throwIfAborted()
        return input.definition.check
          ? input.definition.check(instance as T, value, signal)
          : [{ name: 'runtime', state: r.status.state === 'ready' ? 'passed' : 'failed' }]
      },
    }
  }
  private async start(input: (typeof this.definitions)[number]): Promise<Resource> {
    const lifetime = new AbortController()
    let shutdown: Parameters<ProfileManagedInit['onShutdown']>[0] | undefined
    let ready = false
    let started = false
    let ended = false
    let stopping: Promise<void> | undefined
    let shutdownResult: Promise<{ state: 'settled' | 'unknown' } | undefined> | undefined
    const shut = (reason: Reason) =>
      (shutdownResult ??= deadline(
        Promise.resolve().then(() => shutdown?.(reason)),
        input.descriptor.shutdownTimeoutMs,
      ).catch(() => undefined))
    const r: Resource = {
      owner: input.owner,
      packageId: input.packageId,
      revision: input.revision,
      id: input.definition.id,
      lifetime,
      status: { state: 'starting' },
      value: Promise.resolve(undefined),
      stop: (reason) =>
        (stopping ??= (async () => {
          if (r.status.state === 'stopped') return
          r.status.state = 'stopping'
          lifetime.abort(reason)
          await r.value.catch(() => undefined)
          const result = await shut(reason)
          const settled =
            result?.state === 'settled' || (!started && r.status.code !== 'shutdown-unconfirmed')
          r.status = settled ? { state: 'stopped' } : { state: 'failed', code: 'shutdown-unconfirmed' }
          ended = true
          input.store.set(`managed-shutdown:${r.id}`, !settled)
          if (!settled) throw rpcError('CAPABILITY_DENIED')
        })()),
    }
    const run = async () => {
      if (input.store.get(`managed-shutdown:${r.id}`) === true) throw new Error('shutdown-unconfirmed')
      const config = input.store.get(`managed-config:${r.id}`) ?? input.definition.defaultConfig
      const overrides =
        config &&
        typeof config === 'object' &&
        !Array.isArray(config) &&
        config.listenerPorts &&
        typeof config.listenerPorts === 'object' &&
        !Array.isArray(config.listenerPorts)
          ? config.listenerPorts
          : {}
      const listeners: Record<string, { host: '127.0.0.1'; port: number }> = {}
      for (const listener of input.descriptor.listeners) {
        const port = overrides[listener.name] ?? listener.port
        if (
          (port !== 'auto' &&
            (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) ||
          (listener.port !== 'auto' && port !== listener.port)
        )
          throw new Error('invalid-listener-config')
        listeners[listener.name] = { host: listener.host, port: port === 'auto' ? await freePort() : port }
      }
      lifetime.signal.throwIfAborted()
      input.store.set(`managed-shutdown:${r.id}`, true)
      started = true
      const value = await input.definition.start({
        signal: lifetime.signal,
        listeners,
        config,
        store: managedStore(input.store, () => {
          if (ended) throw rpcError('CAPABILITY_DENIED')
        }),
        wakes: input.wakesAllowed
          ? this.wakes(input.owner, input.integrity)
          : {
              async enqueue() {
                throw rpcError('CAPABILITY_DENIED')
              },
              async read() {
                throw rpcError('CAPABILITY_DENIED')
              },
            },
        assertCurrent: () => {
          lifetime.signal.throwIfAborted()
          input.assert()
        },
        onShutdown: (handler) => {
          if (shutdown) throw new Error('shutdown already registered')
          shutdown = handler
        },
        ready: () => {
          if (!shutdown) throw new Error('shutdown required')
          lifetime.signal.throwIfAborted()
          ready = true
        },
      })
      lifetime.signal.throwIfAborted()
      if (!ready) throw new Error('readiness-required')
      r.status = { state: 'ready', endpoints: listeners }
      return value
    }
    r.value = deadline(run(), input.descriptor.startupTimeoutMs).catch(async (error) => {
      let code =
        error?.code === 'EADDRINUSE'
          ? 'port-in-use'
          : error?.message === 'shutdown-unconfirmed'
            ? 'shutdown-unconfirmed'
            : 'unavailable'
      lifetime.abort('failed')
      if (started) {
        const result = await shut('exit')
        input.store.set(`managed-shutdown:${r.id}`, result?.state !== 'settled')
        if (result?.state !== 'settled') code = 'shutdown-unconfirmed'
      }
      ended = true
      r.status = { state: 'failed', code }
      throw rpcError('CAPABILITY_DENIED')
    })
    void r.value.catch(() => undefined)
    return r
  }
  publish(reason: Reason = 'upgrade', force = false): Promise<void> {
    if (this.closed) return Promise.reject(rpcError('CAPABILITY_DENIED'))
    const previous = profiles.get(this.key)
    const definitions = this.definitions.filter(
      (d) => !this.current || this.current(d.owner, d.integrity, d.revision),
    )
    const stamp = definitions
      .map((d) => `${d.owner}/${d.revision}/${d.definition.id}`)
      .sort()
      .join('\0')
    if (previous?.manager === this && previous.stamp === stamp && !force) return previous.draining
    const retained =
      previous?.manager === this && !force
        ? previous.resources.filter((r) =>
            definitions.some(
              (d) => d.owner === r.owner && d.revision === r.revision && d.definition.id === r.id,
            ),
          )
        : []
    const retiring = (previous?.resources ?? []).filter((r) => !retained.includes(r))
    for (const r of retiring) r.lifetime.abort(reason)
    const next = {
      manager: this,
      stamp,
      resources: [...(previous?.resources ?? [])],
      draining: Promise.resolve(),
    }
    profiles.set(this.key, next)
    next.draining = (async () => {
      await previous?.draining
      await Promise.all(retiring.map((r) => r.stop(reason)))
      if (profiles.get(this.key) !== next || this.closed) return
      next.resources = retained
      for (const definition of definitions)
        if (
          !retained.some(
            (r) =>
              r.owner === definition.owner &&
              r.revision === definition.revision &&
              r.id === definition.definition.id,
          )
        )
          next.resources.push(await this.start(definition))
    })()
    void next.draining.catch(() => undefined)
    return next.draining
  }
  statuses(packageId: string) {
    return (profiles.get(this.key)?.resources ?? [])
      .filter((r) => r.packageId === packageId)
      .map((r) => ({ id: r.id, ...structuredClone(r.status) }))
  }
  async settle() {
    await profiles.get(this.key)?.draining
  }
  async close() {
    this.closed = true
    const current = profiles.get(this.key)
    if (current?.manager !== this) {
      await current?.draining.catch(() => undefined)
      return
    }
    for (const r of current.resources) r.lifetime.abort('exit')
    await current.draining.catch(() => undefined)
    try {
      await Promise.all(current.resources.map((r) => r.stop('exit')))
    } finally {
      if (profiles.get(this.key) === current) profiles.delete(this.key)
    }
  }
}
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (!address || typeof address === 'string') throw new Error('listener-unavailable')
  return address.port
}

async function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('managed-timeout')), ms)
        timer.unref()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
