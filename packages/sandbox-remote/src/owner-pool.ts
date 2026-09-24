import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type { RemoteTransport } from '@agnes/core'

export type RemoteWorkspaceOwnerState = 'active' | 'cleanup-pending' | 'cleaned' | 'abandoned'

export type RemoteWorkspaceLease = Readonly<{
  ownerKey: string
  root: string
  close(): Promise<void>
}>

export type RemoteWorkspaceOwnerStatus = Readonly<{
  ownerKey: string
  root: string
  state: RemoteWorkspaceOwnerState | 'opening'
  refs: number
  cleanupAttempts: number
  providerTtlExpiresAt?: number
}>

type OwnerRecord = {
  ownerKey: string
  root: string
  state: RemoteWorkspaceOwnerStatus['state']
  refs: number
  claims: number
  cleanupAttempts: number
  opening?: Promise<void>
  cleanup?: Promise<void>
  providerTtlExpiresAt?: number
}

export type RemoteWorkspacePoolOptions = Readonly<{
  transport: RemoteTransport
  rootTemplate: string
  keepOnClose: boolean
  /** Provider-side orphan lifetime. The pool records it and only rechecks lazily; it starts no sweeper. */
  providerTtlMs: number
  cleanupAttempts?: number
  cleanupBackoffMs?: number
  now?: () => number
  wait?: (ms: number) => Promise<void>
  closeTransport?: boolean
}>

const fault = (
  reason: string,
  detail: Record<string, unknown> = {},
): Error & {
  code: 'E_REMOTE_WORKSPACE'
  detail: Record<string, unknown>
} =>
  Object.assign(new Error(`E_REMOTE_WORKSPACE: ${reason}`), {
    code: 'E_REMOTE_WORKSPACE' as const,
    detail,
  })

function validateTemplate(template: string): void {
  if (
    typeof template !== 'string' ||
    !posix.isAbsolute(template) ||
    template.includes('\0') ||
    template.includes('\\') ||
    template.split('{session}').length !== 2 ||
    template.split('/').some((part) => part === '.' || part === '..')
  )
    throw fault('invalid remote root template')
}

function validateOwnerKey(ownerKey: string): void {
  if (typeof ownerKey !== 'string' || ownerKey.length === 0 || ownerKey.includes('\0'))
    throw fault('invalid remote workspace owner')
}

/** Full SHA-256 avoids collisions and keeps the original session identifier out of the remote path. */
export function remoteWorkspaceOwnerToken(ownerKey: string): string {
  validateOwnerKey(ownerKey)
  return createHash('sha256').update(ownerKey).digest('hex')
}

export function remoteWorkspaceRoot(rootTemplate: string, ownerKey: string): string {
  validateTemplate(rootTemplate)
  return rootTemplate.replace('{session}', remoteWorkspaceOwnerToken(ownerKey))
}

function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason ?? fault('remote workspace open cancelled'))
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? fault('remote workspace open cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

/** One process-wide transport, one deterministic owner directory per top-level session. */
export class RemoteWorkspacePool {
  private readonly records = new Map<string, OwnerRecord>()
  private readonly now: () => number
  private readonly wait: (ms: number) => Promise<void>
  private readonly maxCleanupAttempts: number
  private readonly cleanupBackoffMs: number
  private closed = false

  constructor(private readonly options: RemoteWorkspacePoolOptions) {
    validateTemplate(options.rootTemplate)
    if (!Number.isSafeInteger(options.providerTtlMs) || options.providerTtlMs < 0)
      throw fault('invalid provider TTL')
    this.maxCleanupAttempts = options.cleanupAttempts ?? 3
    this.cleanupBackoffMs = options.cleanupBackoffMs ?? 25
    if (!Number.isSafeInteger(this.maxCleanupAttempts) || this.maxCleanupAttempts < 1)
      throw fault('invalid cleanup attempt count')
    if (!Number.isSafeInteger(this.cleanupBackoffMs) || this.cleanupBackoffMs < 0)
      throw fault('invalid cleanup backoff')
    this.now = options.now ?? Date.now
    this.wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  async acquire(ownerKey: string, signal?: AbortSignal): Promise<RemoteWorkspaceLease> {
    validateOwnerKey(ownerKey)
    signal?.throwIfAborted()
    for (;;) {
      if (this.closed) throw fault('remote workspace pool is closed')
      const existing = this.records.get(ownerKey)
      if (!existing || existing.state === 'cleaned') {
        if (existing) this.records.delete(ownerKey)
        const opened = this.startOpen(ownerKey)
        return this.claim(opened, signal)
      }
      if (existing.state === 'abandoned') {
        if ((existing.providerTtlExpiresAt ?? Number.POSITIVE_INFINITY) > this.now())
          throw fault('remote workspace cleanup was abandoned', {
            ownerKey,
            providerTtlExpiresAt: existing.providerTtlExpiresAt,
          })
        this.records.delete(ownerKey)
        continue
      }
      if (existing.state === 'cleanup-pending') {
        try {
          await waitWithSignal(existing.cleanup ?? Promise.resolve(), signal)
        } catch (error) {
          if (signal?.aborted) throw error
        }
        continue
      }
      if (existing.state === 'opening') return this.claim(existing, signal)
      existing.refs++
      return this.lease(existing)
    }
  }

  status(ownerKey: string): RemoteWorkspaceOwnerStatus | undefined {
    const record = this.records.get(ownerKey)
    if (!record) return undefined
    return Object.freeze({
      ownerKey,
      root: record.root,
      state: record.state,
      refs: record.refs,
      cleanupAttempts: record.cleanupAttempts,
      ...(record.providerTtlExpiresAt === undefined
        ? {}
        : { providerTtlExpiresAt: record.providerTtlExpiresAt }),
    })
  }

  /** Operations may call this after provider-side/manual cleanup, without waiting for TTL. */
  acknowledgeProviderCleanup(ownerKey: string): boolean {
    const record = this.records.get(ownerKey)
    if (record?.state !== 'abandoned') return false
    record.state = 'cleaned'
    delete record.providerTtlExpiresAt
    return true
  }

  private startOpen(ownerKey: string): OwnerRecord {
    const record: OwnerRecord = {
      ownerKey,
      root: remoteWorkspaceRoot(this.options.rootTemplate, ownerKey),
      state: 'opening',
      refs: 0,
      claims: 0,
      cleanupAttempts: 0,
    }
    const opening = this.options.transport
      .exec(['mkdir', '-p', record.root], { cwd: '/' })
      .then((result) => {
        if (result.code !== 0) throw fault('could not create remote workspace', { ownerKey })
        if (this.closed) throw fault('remote workspace pool closed while opening', { ownerKey })
        record.state = 'active'
        if (record.claims === 0 && record.refs === 0) void this.startCleanup(record).catch(() => undefined)
      })
      .catch(async (error: unknown) => {
        // mkdir may have succeeded before cancellation/transport settlement became visible. Keep
        // this exact record published until its cleanup reaches cleaned/abandoned, so a concurrent
        // acquire cannot recreate the same deterministic directory under an old rm.
        record.state = 'active'
        await this.startCleanup(record).catch(() => undefined)
        throw (error as { code?: unknown })?.code === 'E_REMOTE_WORKSPACE'
          ? error
          : fault(error instanceof Error ? error.message : 'remote workspace open failed', { ownerKey })
      })
    record.opening = opening
    this.records.set(ownerKey, record)
    return record
  }

  private async claim(record: OwnerRecord, signal?: AbortSignal): Promise<RemoteWorkspaceLease> {
    record.claims++
    try {
      await waitWithSignal(record.opening ?? Promise.resolve(), signal)
      signal?.throwIfAborted()
      if (this.closed || record.state !== 'active') throw fault('remote workspace is unavailable')
      record.refs++
      return this.lease(record)
    } finally {
      record.claims--
      if (record.state === 'active' && record.claims === 0 && record.refs === 0)
        void this.startCleanup(record).catch(() => undefined)
    }
  }

  private lease(record: OwnerRecord): RemoteWorkspaceLease {
    let released = false
    return Object.freeze({
      ownerKey: record.ownerKey,
      root: record.root,
      close: async () => {
        if (released) return
        released = true
        // Consume the ref before cleanup. A failed deletion never revives an old lease.
        record.refs--
        if (record.refs < 0) throw fault('remote workspace reference count underflow')
        if (record.refs === 0) await this.startCleanup(record)
      },
    })
  }

  private startCleanup(record: OwnerRecord): Promise<void> {
    if (record.state === 'cleanup-pending') return record.cleanup ?? Promise.resolve()
    if (record.state === 'cleaned') return Promise.resolve()
    if (record.state === 'abandoned') return Promise.reject(fault('remote workspace cleanup was abandoned'))
    if (record.state === 'opening')
      return (record.opening ?? Promise.resolve()).then(() => this.startCleanup(record))
    record.state = 'cleanup-pending'
    const cleanup = (async () => {
      if (this.options.keepOnClose) {
        record.state = 'cleaned'
        return
      }
      let lastError: unknown
      for (let attempt = 1; attempt <= this.maxCleanupAttempts; attempt++) {
        record.cleanupAttempts = attempt
        try {
          await this.removeRoot(record)
          record.state = 'cleaned'
          return
        } catch (error) {
          lastError = error
          if (attempt < this.maxCleanupAttempts) await this.wait(this.cleanupBackoffMs * 2 ** (attempt - 1))
        }
      }
      record.state = 'abandoned'
      record.providerTtlExpiresAt = this.now() + this.options.providerTtlMs
      throw fault(lastError instanceof Error ? lastError.message : 'remote workspace cleanup failed', {
        ownerKey: record.ownerKey,
        attempts: record.cleanupAttempts,
        providerTtlExpiresAt: record.providerTtlExpiresAt,
      })
    })()
    record.cleanup = cleanup
    return cleanup
  }

  private async removeRoot(record: OwnerRecord): Promise<void> {
    if (this.options.keepOnClose) return
    const result = await this.options.transport.exec(['rm', '-rf', record.root], { cwd: '/' })
    if (result.code !== 0) throw new Error('could not remove remote workspace')
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const records = [...this.records.values()]
    await Promise.allSettled(records.map((record) => record.opening))
    const cleaned = await Promise.allSettled(
      records.map((record) => {
        if (record.state === 'active' && record.refs > 0)
          return Promise.reject(
            fault('remote workspace pool closed with active leases', {
              ownerKey: record.ownerKey,
              refs: record.refs,
            }),
          )
        if (record.state === 'abandoned' || record.state === 'cleaned') return Promise.resolve()
        return this.startCleanup(record)
      }),
    )
    let transportError: unknown
    if (this.options.closeTransport !== false)
      await this.options.transport.close().catch((error: unknown) => {
        transportError = error
      })
    const failed = cleaned.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed || transportError !== undefined)
      throw new AggregateError(
        [...(failed ? [failed.reason] : []), ...(transportError === undefined ? [] : [transportError])],
        'remote workspace pool close failed',
      )
  }
}
