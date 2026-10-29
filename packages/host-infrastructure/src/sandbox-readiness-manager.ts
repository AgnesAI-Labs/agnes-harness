export type SandboxReadinessKey = Readonly<{
  backendId: string
  canonicalRoot: string
  staticConfigHash: string
  /** Used only to derive the canonical root identity; it is not a fourth cache-key field. */
  caseSensitive: boolean
}>

export type SandboxConfineRequest = Readonly<{
  argv: readonly string[]
  cwd: string
}>

/** The only sandbox backend surface a session capability can reveal. */
export type SandboxWorkspaceBackend = Readonly<{
  confine(request: SandboxConfineRequest): Promise<readonly string[]> | readonly string[]
}>

/** Host-private result of the one raw probe capability transferred into this manager. */
export type ProbedSandboxWorkspaceBackend = SandboxWorkspaceBackend &
  Readonly<{
    /** Host-private posture; never copied onto the public backend wrapper. */
    name?: 'none' | 'bwrap' | 'seatbelt' | 'remote'
    execBackend?: 'none' | 'l1' | 'remote'
    enforcement?: Readonly<{
      level: 'full' | 'partial' | 'none'
      scope: readonly ('file' | 'network' | 'process')[]
    }>
    close?(): Promise<void> | void
  }>

export type SandboxWorkspaceProbe = (
  input: Readonly<{
    backendId: string
    canonicalRoot: string
    staticConfigHash: string
    signal: AbortSignal
  }>,
) => Promise<ProbedSandboxWorkspaceBackend>

export type SandboxReadinessCapability = Readonly<{
  /** Root, backend, config hash, argv and callback are already bound by Host. */
  ready(signal?: AbortSignal): Promise<SandboxWorkspaceBackend>
}>

export type BoundSandboxReadiness = Readonly<{
  capability: SandboxReadinessCapability
  revoke(): void
}>

type CachedBackend = Readonly<{
  raw: ProbedSandboxWorkspaceBackend
}>

const fault = (
  code: 'E_SANDBOX_WORKSPACE' | 'E_WORKSPACE_CLOSED',
  reason: string,
): Error & { code: string } => Object.assign(new Error(`${code}: ${reason}`), { code })

function checkedToken(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0'))
    throw fault('E_SANDBOX_WORKSPACE', `invalid ${field}`)
  return value
}

function checkedHash(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw fault('E_SANDBOX_WORKSPACE', 'invalid static config hash')
  return value
}

function cacheIdentity(key: SandboxReadinessKey): {
  cacheKey: string
  probeKey: Omit<SandboxReadinessKey, 'caseSensitive'>
} {
  const backendId = checkedToken(key.backendId, 'backend id')
  const root = checkedToken(key.canonicalRoot, 'canonical root')
  const staticConfigHash = checkedHash(key.staticConfigHash)
  if (typeof key.caseSensitive !== 'boolean') throw fault('E_SANDBOX_WORKSPACE', 'invalid case semantics')
  const canonicalRoot = key.caseSensitive ? root : root.toLocaleLowerCase('en-US')
  return {
    cacheKey: JSON.stringify([backendId, canonicalRoot, staticConfigHash]),
    probeKey: { backendId, canonicalRoot, staticConfigHash },
  }
}

function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted)
    return Promise.reject(signal.reason ?? fault('E_WORKSPACE_CLOSED', 'readiness cancelled'))
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? fault('E_WORKSPACE_CLOSED', 'readiness cancelled'))
    signal.addEventListener('abort', aborted, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', aborted)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', aborted)
        reject(error)
      },
    )
  })
}

/**
 * Owns the raw sandbox probe for the Host lifetime. Cache identity is exactly the backend id,
 * canonical root identity and normalized static-config hash. Only successful probes are cached.
 */
export class SandboxReadinessManager {
  private readonly cached = new Map<string, CachedBackend>()
  private readonly pending = new Map<string, Promise<CachedBackend>>()
  private readonly lifetime = new AbortController()
  private revoked = false

  constructor(private readonly probe: SandboxWorkspaceProbe) {}

  bind(
    key: SandboxReadinessKey,
    activate?: (raw: ProbedSandboxWorkspaceBackend) => void,
  ): BoundSandboxReadiness {
    const identity = cacheIdentity(key)
    let boundRevoked = false
    let boundBackend: SandboxWorkspaceBackend | undefined
    const assertOpen = (): void => {
      if (this.revoked || boundRevoked) throw fault('E_WORKSPACE_CLOSED', 'sandbox readiness revoked')
    }
    const capability: SandboxReadinessCapability = Object.freeze({
      ready: async (signal?: AbortSignal): Promise<SandboxWorkspaceBackend> => {
        assertOpen()
        const cached = await waitWithSignal(this.ensure(identity.cacheKey, identity.probeKey), signal)
        assertOpen()
        activate?.(cached.raw)
        boundBackend ??= Object.freeze({
          confine: (request: SandboxConfineRequest) => {
            assertOpen()
            return cached.raw.confine(request)
          },
        })
        return boundBackend
      },
    })
    return Object.freeze({
      capability,
      revoke: () => {
        boundRevoked = true
      },
    })
  }

  private ensure(
    cacheKey: string,
    key: Readonly<{ backendId: string; canonicalRoot: string; staticConfigHash: string }>,
  ): Promise<CachedBackend> {
    if (this.revoked) return Promise.reject(fault('E_WORKSPACE_CLOSED', 'sandbox readiness revoked'))
    const cached = this.cached.get(cacheKey)
    if (cached) return Promise.resolve(cached)
    const current = this.pending.get(cacheKey)
    if (current) return current
    const pending = this.probe({ ...key, signal: this.lifetime.signal })
      .then((raw): CachedBackend => {
        if (this.revoked) {
          void Promise.resolve(raw.close?.()).catch(() => undefined)
          throw fault('E_WORKSPACE_CLOSED', 'sandbox readiness revoked')
        }
        if (!raw || typeof raw.confine !== 'function')
          throw fault('E_SANDBOX_WORKSPACE', 'sandbox probe returned no confinement capability')
        const result = Object.freeze({ raw })
        this.cached.set(cacheKey, result)
        return result
      })
      .catch((error: unknown) => {
        if ((error as { code?: unknown })?.code === 'E_WORKSPACE_CLOSED') throw error
        throw fault(
          'E_SANDBOX_WORKSPACE',
          error instanceof Error ? error.message : 'sandbox workspace probe failed',
        )
      })
      .finally(() => {
        if (this.pending.get(cacheKey) === pending) this.pending.delete(cacheKey)
      })
    this.pending.set(cacheKey, pending)
    return pending
  }

  async revoke(): Promise<void> {
    if (this.revoked) return
    this.revoked = true
    this.lifetime.abort(fault('E_WORKSPACE_CLOSED', 'sandbox readiness manager closed'))
    const pending = [...this.pending.values()]
    const cached = [...this.cached.values()]
    this.pending.clear()
    this.cached.clear()
    await Promise.allSettled(pending)
    const failures = await Promise.allSettled(cached.map(({ raw }) => Promise.resolve(raw.close?.())))
    const failure = failures.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure) throw failure.reason
  }
}
