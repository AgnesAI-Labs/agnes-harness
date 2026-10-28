import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { decisionSubjectDigest } from '@agnes/core'
import type {
  BoundWakes,
  OwnedStore,
  PreparedServiceEffect,
  ProfileManagedDefinition,
  ProfileManagedInit,
  ServiceContext,
} from '@agnes/extension-api'
import type { JsonValue, ManagedServiceDescriptor } from '@agnes/protocol'
import { rpcError } from '@agnes/protocol'
import { compileExtensionSchema } from '../ext-host/json-schema.js'
import {
  confirmManagedShutdown,
  handoverManagedMarker,
  hasManagedShutdownConfirmation,
  type ManagedPredecessor,
  managedMarkerBinding,
  markShutdown,
} from './managed-marker.js'
import {
  managedProcessGone,
  managedProcessOwner,
  managedProcessState,
  type ProcessQuery,
} from './managed-owner.js'
import { managedStore } from './managed-store.js'

type Reason = 'disable' | 'upgrade' | 'exit'
type Resource = ManagedPredecessor & {
  incarnation: string
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
    private readonly current?: (owner: string, integrity: string, revision: string) => boolean | string,
    private readonly processIdentity?: ProcessQuery,
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
          (r) =>
            r.owner === input.owner &&
            r.revision === input.revision &&
            r.integrity === input.integrity &&
            r.id === input.definition.id,
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
      reconcile: async (context: ServiceContext) => {
        const prepared = context.admission?.prepared
        if (!prepared) throw rpcError('CAPABILITY_DENIED')
        const r = resource()
        const latest = await this.reconciliation(input.owner, `${r.id}.reconcile`)?.prepare()
        context.signal.throwIfAborted()
        if (
          resource() !== r ||
          !latest ||
          latest.resourceRevision !== prepared.resourceRevision ||
          managedRevision(input.store, r, input.revision, input.integrity) !== prepared.resourceRevision ||
          (!context.admission?.approval && !automaticReconciliation(latest))
        )
          throw rpcError('CAPABILITY_DENIED')
        // No await between the final fence, reservation and durable marker update.
        markShutdown(input.store, r.id, false)
        r.status = { state: 'starting' }
        const next = await this.start(input, r)
        const profile = profiles.get(this.key)
        if (!profile || profile.manager !== this) {
          await next.stop('disable')
          throw rpcError('CAPABILITY_DENIED')
        }
        profile.resources.splice(profile.resources.indexOf(r), 1, next)
        await next.value
        return null
      },
      retry: async () => {
        const r = resource()
        if (
          r.status.state !== 'failed' ||
          (r.status.code === 'shutdown-unconfirmed' &&
            input.store.get(`managed-shutdown:${r.id}`) !== false &&
            !hasManagedShutdownConfirmation(r.shutdownConfirmation, input.store))
        )
          throw rpcError('CAPABILITY_DENIED')
        // Reserve the failed slot before yielding so two approved retries cannot start twins.
        r.status = { state: 'starting' }
        const next = await this.start(input, r)
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
  private async start(input: (typeof this.definitions)[number], predecessor?: Resource): Promise<Resource> {
    const epoch = this.current?.(input.owner, input.integrity, input.revision)
    input.assert()
    if (this.current && !epoch) throw rpcError('CAPABILITY_DENIED')
    const activation = typeof epoch === 'string' ? epoch : input.revision
    const confirmation = handoverManagedMarker(
      input.store,
      input.definition.id,
      { ...input, activation },
      predecessor,
    )
    const lifetime = new AbortController()
    let shutdown: Parameters<ProfileManagedInit['onShutdown']>[0] | undefined
    let ready = false
    let started = false
    let startupComplete = false
    let ended = false
    let stopping: Promise<void> | undefined
    let shutdownResult: Promise<{ state: 'settled' | 'unknown' } | undefined> | undefined
    const shut = (reason: Reason) => {
      if (!shutdownResult) {
        const ownConfirmation = startupComplete ? r.shutdownConfirmation : undefined
        const work = Promise.resolve()
          .then(() => shutdown?.(reason))
          .then((result) => {
            if (result?.state === 'settled' && ownConfirmation) confirmManagedShutdown(ownConfirmation)
            return result
          })
        shutdownResult = deadline(work, input.descriptor.shutdownTimeoutMs).catch(() => undefined)
      }
      return shutdownResult
    }
    const r: Resource = {
      incarnation: randomUUID(),
      owner: input.owner,
      packageId: input.packageId,
      integrity: input.integrity,
      activation,
      store: input.store,
      ...(confirmation ? { shutdownConfirmation: confirmation } : {}),
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
          // A blocked definition never acquired a live instance. Retiring its registration must
          // not poison the next publication: leave the durable unknown marker for native recovery.
          if (!started) {
            r.status =
              input.store.get(`managed-shutdown:${r.id}`) === true
                ? { state: 'failed', code: 'shutdown-unconfirmed' }
                : { state: 'stopped' }
            ended = true
            return
          }
          const result = await shut(reason)
          const settled =
            result?.state === 'settled' || hasManagedShutdownConfirmation(r.shutdownConfirmation, input.store)
          r.status = settled ? { state: 'stopped' } : { state: 'failed', code: 'shutdown-unconfirmed' }
          ended = true
          markShutdown(input.store, r.id, !settled)
          if (!settled) throw rpcError('CAPABILITY_DENIED')
        })()),
    }
    const run = async () => {
      const shutdownKey = `managed-shutdown:${r.id}`
      const ownerKey = `managed-process:${r.id}`
      if (input.store.get(shutdownKey) === true) {
        if (
          input.descriptor.artifact.kind !== 'in-process' ||
          !(await managedProcessGone(input.store.get(ownerKey), this.processIdentity))
        )
          throw new Error('shutdown-unconfirmed')
        // Only resource liveness is reconciled here. Operation receipts remain unknown.
        markShutdown(input.store, r.id, false)
      }
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
      const owner = await managedProcessOwner(process.pid, this.processIdentity)
      lifetime.signal.throwIfAborted()
      input.store.transaction(() => {
        input.store.set(ownerKey, owner)
        input.store.set(`managed-incarnation:${r.id}`, r.incarnation)
        markShutdown(input.store, r.id, true)
      })
      r.shutdownConfirmation = {
        id: r.id,
        incarnation: r.incarnation,
        identity: owner,
        confirmed: false,
        origin: input.store,
        current: input.store,
      }
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
      startupComplete = true
      return value
    }
    r.value = deadline(run(), input.descriptor.startupTimeoutMs).catch(async (error) => {
      let code =
        error?.code === 'EADDRINUSE'
          ? 'port-in-use'
          : error?.message === 'shutdown-unconfirmed' ||
              (!started && input.store.get(`managed-shutdown:${r.id}`) === true)
            ? 'shutdown-unconfirmed'
            : 'unavailable'
      lifetime.abort('failed')
      if (started) {
        const result = await shut('exit')
        markShutdown(input.store, r.id, result?.state !== 'settled')
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
      .map((d) => `${d.owner}/${d.revision}/${d.integrity}/${d.definition.id}`)
      .sort()
      .join('\0')
    if (previous?.manager === this && previous.stamp === stamp && !force) return previous.draining
    const retained =
      previous?.manager === this && !force
        ? previous.resources.filter((r) =>
            definitions.some(
              (d) =>
                d.owner === r.owner &&
                d.revision === r.revision &&
                d.integrity === r.integrity &&
                d.definition.id === r.id,
            ),
          )
        : []
    let retiring = (previous?.resources ?? []).filter((r) => !retained.includes(r))
    for (const r of retiring) r.lifetime.abort(reason)
    const next = {
      manager: this,
      stamp,
      resources: [...(previous?.resources ?? [])],
      draining: Promise.resolve(),
    }
    profiles.set(this.key, next)
    next.draining = (async () => {
      await previous?.draining.catch(() => undefined)
      // A predecessor may have entered start() before this publication but installed its slot
      // while we joined its drain. Include that late slot before starting any replacement.
      retiring = (previous?.resources ?? []).filter((r) => !retained.includes(r))
      for (const r of retiring) r.lifetime.abort(reason)
      const stopped = await Promise.allSettled(retiring.map((r) => r.stop(reason)))
      // An unconfirmed predecessor can be replaced only by a fenced registration of the same
      // package/service. Removed resources still report their shutdown failure to the caller.
      for (const [index, result] of stopped.entries())
        if (
          result.status === 'rejected' &&
          !definitions.some(
            (d) => d.packageId === retiring[index]?.packageId && d.definition.id === retiring[index]?.id,
          )
        )
          throw result.reason
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
          next.resources.push(
            await this.start(
              definition,
              retiring.find((r) => r.packageId === definition.packageId && r.id === definition.definition.id),
            ),
          )
    })()
    void next.draining.catch(() => undefined)
    return next.draining
  }
  /** Host-owned preparation; plugin presentation can never waive native admission. */
  reconciliation(owner: string, service: string) {
    const input = this.definitions.find(
      (d) => d.owner === owner && service === `${d.definition.id}.reconcile`,
    )
    if (!input) return undefined
    return {
      prepare: async (): Promise<PreparedServiceEffect> => {
        // Preparation runs before the service handler, which normally waits for publication.
        await this.settle()
        input.assert()
        if (this.closed || (this.current && !this.current(input.owner, input.integrity, input.revision)))
          throw rpcError('CAPABILITY_DENIED', { reason: 'MANAGED_ACTIVATION_CHANGED' })
        const profile = profiles.get(this.key)
        const r = profile?.resources.find(
          (r) =>
            r.owner === owner &&
            r.id === input.definition.id &&
            r.revision === input.revision &&
            r.integrity === input.integrity,
        )
        await r?.value.catch(() => undefined)
        input.assert()
        if (
          this.closed ||
          profiles.get(this.key) !== profile ||
          profile?.manager !== this ||
          !r ||
          r.status.state !== 'failed' ||
          r.status.code !== 'shutdown-unconfirmed' ||
          (input.store.get(`managed-shutdown:${r.id}`) !== true &&
            input.store.get(`managed-shutdown:${r.id}`) !== false)
        )
          throw rpcError('CAPABILITY_DENIED', { reason: 'MANAGED_RESOURCE_NOT_RECOVERABLE' })
        const identity = input.store.get(`managed-process:${r.id}`) ?? null
        const resourceRevision = managedRevision(input.store, r, input.revision, input.integrity)
        const cleanupConfirmed =
          input.store.get(`managed-shutdown:${r.id}`) === false ||
          hasManagedShutdownConfirmation(r.shutdownConfirmation, input.store)
        const identityState = await managedProcessState(identity, this.processIdentity)
        input.assert()
        if (
          this.closed ||
          profiles.get(this.key) !== profile ||
          r.status.state !== 'failed' ||
          resourceRevision !== managedRevision(input.store, r, input.revision, input.integrity)
        )
          throw rpcError('CAPABILITY_DENIED')
        if (identityState === 'alive' && !cleanupConfirmed)
          throw rpcError('CAPABILITY_DENIED', { reason: 'MANAGED_PROCESS_ALIVE' })
        return {
          input: {},
          resourceRevision,
          presentation: {
            resource: r.id,
            ownerPackage: input.packageId,
            generation: input.revision,
            lastKnownIdentity: identity,
            ...managedMarkerBinding(input.store, r.id),
            identityState,
            ...(cleanupConfirmed ? { cleanupConfirmed: true } : {}),
            confirmation: cleanupConfirmed
              ? 'Resource cleanup confirmed / 已确认资源清理完成。 Unknown operation outcomes remain unknown; no device motion is replayed.'
              : 'Confirm and recover / 确认并恢复: I confirm the old process is no longer running / 我确认旧进程已不再运行。 Unknown operation outcomes remain unknown; no device motion is replayed.',
          },
        }
      },
      automatic: automaticReconciliation,
    }
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
      const results = await Promise.allSettled(current.resources.map((r) => r.stop('exit')))
      const errors = results.filter((r) => r.status === 'rejected').map((r) => r.reason)
      if (errors.length) throw new AggregateError(errors, 'managed shutdown unconfirmed')
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

function automaticReconciliation(prepared: PreparedServiceEffect) {
  const value = prepared.presentation
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value.identityState === 'dead' || value.cleanupConfirmed === true)
  )
}

function managedRevision(
  store: OwnedStore,
  resource: Pick<Resource, 'id' | 'incarnation'>,
  generation: string,
  integrity: string,
) {
  return decisionSubjectDigest({
    incarnation: resource.incarnation,
    generation,
    integrity,
    shutdown: store.get(`managed-shutdown:${resource.id}`) ?? null,
    marker: store.get(`managed-marker-revision:${resource.id}`) ?? null,
    identity: store.get(`managed-process:${resource.id}`) ?? null,
    instance: store.get(`managed-incarnation:${resource.id}`) ?? null,
    ...managedMarkerBinding(store, resource.id),
  })
}
