import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { defaultProcessIdentity, type ProcessIdentity, type ResolvedDeployment } from '@agnes/host'
import {
  jcs,
  type ManagedServiceDescriptor,
  type ManagedServiceStatus,
  validateManagedServiceDescriptor,
  validateManagedServiceReady,
} from '@agnes/protocol'
import { createSurfaceController } from '../surfaces/controller.js'
import { createLocalNodeRuntime } from '../surfaces/local-runtime.js'
import type {
  ResolvedNodeArtifact,
  SurfaceController,
  SurfaceEndpoint,
  SurfaceRuntimeAdapter,
} from '../surfaces/types.js'
import { managedRequest } from './http.js'
import { acquireManagedLease, type ManagedLease, ManagedServiceError } from './lease.js'
import { allocateManagedListeners } from './listeners.js'
import { spawnManagedPosix } from './posix-runtime.js'

export type ManagedServiceSelector = Readonly<{ profileId: string; owner: string; serviceId: string }>
/** Produced by the package/current-activation authority after review, capability ceiling and artifact checks. */
export type ReviewedManagedService = Readonly<{
  owner: string
  profileId: string
  packageId: string
  revision: string
  activationId: string
  descriptor: ManagedServiceDescriptor
  artifact: ResolvedNodeArtifact
  signal: AbortSignal
  assertCurrent(): void
  installationScopeGranted?: boolean
}>
type Record = {
  binding: ReviewedManagedService
  status: ManagedServiceStatus
  controller?: SurfaceController
  lease: ManagedLease
  incarnation: string
  signal: AbortController
  endpoint?: SurfaceEndpoint
  pid?: number
  probe?: (signal: AbortSignal) => Promise<boolean>
  monitor?: ReturnType<typeof setInterval>
  stopping?: Promise<void>
  releaseBinding(): void
}
export function createManagedServiceSupervisor(options: {
  installationId: string
  directory: string
  resolve(selector: ManagedServiceSelector): Promise<ReviewedManagedService>
  runtime?: (
    binding: ReviewedManagedService,
    initialization: Readonly<{
      incarnation: string
      listeners: Readonly<{ [name: string]: { host: '127.0.0.1'; port: number } }>
    }>,
  ) => SurfaceRuntimeAdapter
  allocateListeners?: typeof allocateManagedListeners
  request?: typeof managedRequest
  healthIntervalMs?: number
  processIdentity?: (pid: number) => Promise<ProcessIdentity>
}) {
  const records = new Map<string, Record>()
  const operations = new Map<string, Promise<ManagedServiceStatus>>()
  const cancellations = new Map<string, AbortController>()
  let closed = false
  const keyOf = (s: ManagedServiceSelector) =>
    JSON.stringify([options.installationId, s.profileId, s.owner, s.serviceId])
  const request = options.request ?? managedRequest
  const processIdentity = async (pid: number): Promise<ProcessIdentity> => {
    try {
      const found = await bounded(
        Promise.resolve().then(() => (options.processIdentity ?? defaultProcessIdentity)(pid)),
        AbortSignal.timeout(3000),
      )
      if (found?.state === 'dead') return found
      if (found?.state === 'alive' && validStartId(found.startId)) return found
      return { state: 'unknown', reason: 'invalid identity' }
    } catch {
      return { state: 'unknown', reason: 'identity unavailable' }
    }
  }
  function snapshot(record: Record): ManagedServiceStatus {
    return structuredClone(record.status)
  }
  async function stopRecord(record: Record, reason: 'disable' | 'upgrade' | 'exit'): Promise<void> {
    if (record.stopping) return record.stopping
    record.stopping = (async () => {
      record.signal.abort(reason)
      record.releaseBinding()
      if (record.monitor) clearInterval(record.monitor)
      record.status = { ...record.status, state: 'draining' }
      let settled = false
      const timeout = AbortSignal.timeout(record.binding.descriptor.shutdownTimeoutMs)
      if (record.endpoint) {
        try {
          const response = await bounded(
            request(record.endpoint, record.incarnation, '/_agnes/managed/shutdown', timeout, { reason }),
            timeout,
          )
          settled =
            !!response &&
            typeof response === 'object' &&
            'incarnation' in response &&
            response.incarnation === record.incarnation &&
            'state' in response &&
            response.state === 'settled'
        } catch {
          /* A missing receipt remains unknown. */
        }
      }
      let reaped = false
      try {
        await record.controller?.stop()
        reaped = true
      } catch {
        /* Keep lease if tree cleanup did not complete. */
      }
      record.status = {
        ...record.status,
        state: reaped ? 'stopped' : 'failed',
        ...(!settled || !reaped ? { reason: 'shutdown-unconfirmed' as const } : {}),
      }
      record.lease.record(reaped ? 'stopped' : 'unknown')
      if (reaped) record.lease.release()
      else throw new ManagedServiceError('SHUTDOWN_UNCONFIRMED')
    })()
    return record.stopping
  }
  async function unhealthy(record: Record): Promise<void> {
    if (record.signal.signal.aborted || record.status.state !== 'ready') return
    record.status.reason = 'health-failed'
    await stopRecord(record, 'exit').catch(() => undefined)
    record.status = {
      ...record.status,
      state: 'failed',
      reason: snapshot(record).reason === 'shutdown-unconfirmed' ? 'shutdown-unconfirmed' : 'health-failed',
    }
  }
  async function start(binding: ReviewedManagedService, key: string): Promise<ManagedServiceStatus> {
    const descriptorCheck = validateManagedServiceDescriptor(binding.descriptor)
    if (
      !descriptorCheck.ok ||
      binding.descriptor.artifact.kind !== 'node' ||
      (binding.descriptor.scope === 'installation' && !binding.installationScopeGranted)
    )
      throw new ManagedServiceError('REFUSED')
    binding.assertCurrent()
    binding.signal.throwIfAborted()
    const descriptor = structuredClone(descriptorCheck.value)
    const leaseKey = JSON.stringify([
      options.installationId,
      descriptor.scope === 'profile' ? binding.profileId : null,
      binding.packageId,
      descriptor.id,
    ])
    const lease = acquireManagedLease(options.directory, leaseKey)
    if (lease.previous === 'active' || lease.previous === 'unknown') {
      const owner = lease.owner()
      const found = owner ? await processIdentity(owner.pid) : undefined
      if (
        !owner?.startId ||
        !validStartId(owner.startId) ||
        !Number.isSafeInteger(owner.pid) ||
        owner.pid <= 0 ||
        !(
          found?.state === 'dead' ||
          (found?.state === 'alive' && found.startId && found.startId !== owner.startId)
        )
      ) {
        lease.release()
        throw new ManagedServiceError('SHUTDOWN_UNCONFIRMED')
      }
      // Reconcile the process only; external-operation journals retain their unknown outcomes.
      lease.record('stopped')
    }
    lease.record('active')
    const signal = new AbortController()
    const incarnation = randomUUID()
    const record: Record = {
      binding,
      lease,
      incarnation,
      signal,
      releaseBinding: () => {},
      status: { id: descriptor.id, instanceId: lease.id, revision: binding.revision, state: 'starting' },
    }
    records.set(key, record)
    const revoked = () => {
      signal.abort('disable')
      if (record.status.state === 'ready') void stopRecord(record, 'disable').catch(() => undefined)
    }
    binding.signal.addEventListener('abort', revoked, { once: true })
    record.releaseBinding = () => binding.signal.removeEventListener('abort', revoked)
    let failure: ManagedServiceStatus['reason'] = 'startup-timeout'
    const deadline = AbortSignal.timeout(descriptor.startupTimeoutMs)
    const startupSignal = AbortSignal.any([deadline, signal.signal, binding.signal])
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        startupSignal.throwIfAborted()
        binding.assertCurrent()
        const listeners = await bounded(
          (options.allocateListeners ?? allocateManagedListeners)(descriptor),
          startupSignal,
        )
        record.status.listeners = listeners
        const initialization = {
          instanceId: lease.id,
          scopeId: leaseKey,
          incarnation,
          apiVersion: descriptor.apiVersion,
          listeners,
          namespace: lease.id,
          storePath: join(options.directory, `${lease.id}-store.db`),
        }
        const probe = async (endpoint: SurfaceEndpoint, probeSignal: AbortSignal) => {
          try {
            const response = await request(endpoint, incarnation, descriptor.healthPath, probeSignal)
            const result = validateManagedServiceReady(response)
            if (
              !result.ok ||
              result.value.incarnation !== incarnation ||
              result.value.apiVersion !== descriptor.apiVersion ||
              JSON.stringify([...result.value.listeners].sort()) !==
                JSON.stringify(Object.keys(listeners).sort())
            )
              return false
            return true
          } catch {
            return false
          }
        }
        const windows = process.platform === 'win32' // guards-allow-platform: select managed Surface process-tree adapter.
        const base =
          options.runtime?.(binding, { incarnation, listeners }) ??
          createLocalNodeRuntime({
            ...(!windows ? { spawn: spawnManagedPosix } : {}),
            environment: () => ({
              AGNES_MANAGED_INIT: JSON.stringify(initialization),
              AGNES_MANAGED_HEALTH_PATH: descriptor.healthPath,
            }),
            healthProbe: probe,
          })
        let portConflict = false
        const runtime: SurfaceRuntimeAdapter = {
          kind: 'managed',
          async start(input) {
            // Every auto-port retry is a new process; never retain the preceding attempt's identity.
            lease.record('active')
            const handle = await base.start(input)
            if (handle.pid === undefined) delete record.pid
            else record.pid = handle.pid
            record.endpoint = handle.endpoint
            record.probe = (s) => probe(handle.endpoint, s)
            void handle.exited.then((exit) => {
              if (exit.code === 98) portConflict = true
              void unhealthy(record).catch(() => undefined)
            })
            // Always verify private proof even for custom adapters; a pid or generic probe is insufficient.
            return { ...handle, probe: (s) => probe(handle.endpoint, s) }
          },
        }
        const controller = createSurfaceController({
          artifacts: { resolveNodeArtifact: () => binding.artifact },
          secrets: {
            resolve: () => {
              throw new ManagedServiceError('REFUSED')
            },
          },
          runtime,
          startupMs: descriptor.startupTimeoutMs,
          healthIntervalMs: 25,
          shutdownGraceMs: 1,
          killWaitMs: 1000,
          cleanupMs: 1000,
        })
        record.controller = controller
        try {
          await controller.start(deployment(binding, lease.id), startupSignal)
          if (record.pid !== undefined) {
            const identity = await processIdentity(record.pid)
            lease.recordOwner(record.pid, identity.state === 'alive' ? identity.startId : null)
          }
          startupSignal.throwIfAborted()
          binding.assertCurrent()
          record.status.state = 'ready'
          let probing = false
          record.monitor = setInterval(() => {
            if (probing || record.status.state !== 'ready') return
            probing = true
            void (async () => {
              try {
                binding.assertCurrent()
                if (
                  binding.signal.aborted ||
                  !record.probe ||
                  !(await bounded(record.probe(AbortSignal.timeout(1000)), AbortSignal.timeout(1000)))
                )
                  throw new Error()
              } catch {
                await unhealthy(record)
              } finally {
                probing = false
              }
            })()
          }, options.healthIntervalMs ?? 1000)
          record.monitor.unref?.()
          return snapshot(record)
        } catch {
          await controller.stop()
          if (!portConflict || descriptor.listeners.some((l) => l.port !== 'auto') || attempt === 2) {
            if (portConflict) failure = 'port-in-use'
            throw new ManagedServiceError(portConflict ? 'PORT_IN_USE' : 'UNAVAILABLE')
          }
          delete record.endpoint
          delete record.probe
        }
      }
      throw new ManagedServiceError('UNAVAILABLE')
    } catch (error) {
      failure = deadline.aborted ? 'startup-timeout' : 'unavailable'
      if (error instanceof ManagedServiceError && error.code === 'PORT_IN_USE') failure = 'port-in-use'
      record.signal.abort('startup-failed')
      record.releaseBinding()
      let reaped = false
      try {
        await record.controller?.stop()
        reaped = true
      } catch {
        failure = 'shutdown-unconfirmed'
      }
      record.status = { ...record.status, state: 'failed', reason: failure }
      lease.record(reaped ? 'stopped' : 'unknown')
      if (reaped) lease.release()
      return snapshot(record)
    }
  }
  return {
    ensure(selector: ManagedServiceSelector, apiMajor?: number): Promise<ManagedServiceStatus> {
      if (closed) return Promise.reject(new ManagedServiceError('REFUSED'))
      const key = keyOf(selector)
      const existing = operations.get(key)
      if (existing)
        return existing.then((status) => {
          if (
            apiMajor !== undefined &&
            Number(records.get(key)?.binding.descriptor.apiVersion.split('.')[0]) !== apiMajor
          )
            throw new ManagedServiceError('REFUSED')
          return status
        })
      const cancellation = new AbortController()
      cancellations.set(key, cancellation)
      const work = (async () => {
        const resolved = await bounded(
          options.resolve(selector),
          AbortSignal.any([cancellation.signal, AbortSignal.timeout(30000)]),
        )
        cancellation.signal.throwIfAborted()
        const binding = {
          ...resolved,
          descriptor: structuredClone(resolved.descriptor),
          artifact: { ...resolved.artifact },
          signal: AbortSignal.any([resolved.signal, cancellation.signal]),
        }
        if (
          closed ||
          binding.owner !== selector.owner ||
          binding.profileId !== selector.profileId ||
          binding.descriptor.id !== selector.serviceId
        )
          throw new ManagedServiceError('REFUSED')
        binding.assertCurrent()
        binding.signal.throwIfAborted()
        if (apiMajor !== undefined && Number(binding.descriptor.apiVersion.split('.')[0]) !== apiMajor)
          throw new ManagedServiceError('REFUSED')
        const current = records.get(key)
        if (
          current &&
          current.status.state === 'ready' &&
          !current.signal.signal.aborted &&
          current.binding.packageId === binding.packageId &&
          current.binding.revision === binding.revision &&
          current.binding.activationId === binding.activationId &&
          jcs(current.binding.descriptor) === jcs(binding.descriptor)
        )
          return snapshot(current)
        if (current && current.status.state !== 'stopped' && current.status.state !== 'failed')
          await stopRecord(current, 'upgrade')
        if (current?.status.state === 'failed' && current.status.reason === 'shutdown-unconfirmed')
          throw new ManagedServiceError('SHUTDOWN_UNCONFIRMED')
        return start(binding, key)
      })().catch((error: unknown) => {
        if (error instanceof ManagedServiceError) throw error
        throw new ManagedServiceError('REFUSED')
      })
      operations.set(key, work)
      void work
        .finally(() => {
          if (operations.get(key) === work) {
            operations.delete(key)
            cancellations.delete(key)
          }
        })
        .catch(() => undefined)
      return work
    },
    async stop(selector: ManagedServiceSelector, reason: 'disable' | 'upgrade' | 'exit' = 'disable') {
      const key = keyOf(selector)
      // Abort startup before waiting for its result; never let disable queue behind readiness.
      cancellations.get(key)?.abort(reason)
      records.get(key)?.signal.abort(reason)
      await operations.get(key)?.catch(() => undefined)
      const record = records.get(key)
      if (record && !['stopped', 'failed'].includes(record.status.state)) await stopRecord(record, reason)
    },
    /** Daemon-only connection capability for an already ready instance. Never serialize this to a client.
     * It authenticates the managed process, not a user action; service/stream admission remains required. */
    async withInstance<T>(
      selector: ManagedServiceSelector,
      apiMajor: number,
      connect: (
        connection: Readonly<{
          instanceId: string
          incarnation: string
          endpoint: SurfaceEndpoint
          listeners: NonNullable<ManagedServiceStatus['listeners']>
          signal: AbortSignal
        }>,
      ) => T | Promise<T>,
    ): Promise<T> {
      const record = records.get(keyOf(selector))
      if (
        closed ||
        !record ||
        record.status.state !== 'ready' ||
        !record.endpoint ||
        record.signal.signal.aborted
      )
        throw new ManagedServiceError('UNAVAILABLE')
      try {
        record.binding.assertCurrent()
        record.binding.signal.throwIfAborted()
      } catch {
        throw new ManagedServiceError('REFUSED')
      }
      if (Number(record.binding.descriptor.apiVersion.split('.')[0]) !== apiMajor)
        throw new ManagedServiceError('REFUSED')
      return connect(
        Object.freeze({
          instanceId: record.status.instanceId,
          incarnation: record.incarnation,
          endpoint: Object.freeze({ ...record.endpoint }),
          listeners: structuredClone(record.status.listeners ?? {}),
          signal: record.signal.signal,
        }),
      )
    },
    status(selector: ManagedServiceSelector) {
      const r = records.get(keyOf(selector))
      return r ? snapshot(r) : undefined
    },
    signal(selector: ManagedServiceSelector): AbortSignal {
      const record = records.get(keyOf(selector))
      if (record?.status.state !== 'ready') return AbortSignal.abort('unavailable')
      return record.signal.signal
    },
    async close() {
      closed = true
      for (const cancel of cancellations.values()) cancel.abort('exit')
      for (const record of records.values()) record.signal.abort('exit')
      await Promise.allSettled([...operations.values()])
      const results = await Promise.allSettled(
        [...records.values()]
          .filter((r) => !['stopped', 'failed'].includes(r.status.state))
          .map((r) => stopRecord(r, 'exit')),
      )
      // Closing the controller releases kernel handles; an unknown durable marker still refuses restart.
      for (const record of records.values()) record.lease.release()
      if (
        results.some((r) => r.status === 'rejected') ||
        [...records.values()].some(
          (r) => r.status.state === 'failed' && r.status.reason === 'shutdown-unconfirmed',
        )
      )
        throw new ManagedServiceError('SHUTDOWN_UNCONFIRMED')
    },
  }
}
function validStartId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    ![...value].some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127)
  )
}
function deployment(binding: ReviewedManagedService, sourceId: string): ResolvedDeployment {
  if (binding.descriptor.artifact.kind === 'in-process') throw new ManagedServiceError('REFUSED')
  return {
    id: 'managed',
    version: binding.descriptor.apiVersion,
    inventoryHash: binding.revision,
    deploymentHash: binding.revision,
    policyHash: binding.revision,
    hash: binding.revision,
    surfaces: [
      {
        package: binding.packageId,
        version: binding.descriptor.apiVersion,
        integrity: binding.revision,
        descriptor: {
          id: binding.descriptor.id,
          apiRange: '*',
          artifact: binding.descriptor.artifact,
          healthPath: binding.descriptor.healthPath,
          requires: { services: binding.descriptor.requires },
        },
        instance: {
          package: binding.packageId,
          surfaceId: binding.descriptor.id,
          mount: `/managed-${sourceId}`,
          sourceId,
          config: {},
          secrets: {},
          grants: binding.descriptor.requires,
        },
        services: [],
      },
    ],
  }
}
async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let abort!: () => void
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        abort = () => reject(new ManagedServiceError('UNAVAILABLE'))
        signal.addEventListener('abort', abort, { once: true })
      }),
    ])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
