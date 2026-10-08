import type { ResolvedDeployment } from '@agnes/host'

export type ResolvedSurface = ResolvedDeployment['surfaces'][number]

export type ResolvedNodeArtifact = Readonly<{
  /** Trusted, absolute path to the installed prebuilt server entry. */
  entry: string
  /** Trusted package directory containing the entry. */
  cwd: string
}>

export type SurfaceArtifactResolver = Readonly<{
  resolveNodeArtifact(
    deployment: ResolvedDeployment,
    surface: ResolvedSurface,
    signal: AbortSignal,
  ): ResolvedNodeArtifact | Promise<ResolvedNodeArtifact>
}>

export type SurfaceSecretLease = Readonly<{
  value: string
  /** Revokes or clears resolver-owned material after spawn has copied the environment. */
  dispose?(): void | Promise<void>
}>

export type SurfaceSecretResolver = Readonly<{
  resolve(
    ref: string,
    signal: AbortSignal,
  ): string | SurfaceSecretLease | Promise<string | SurfaceSecretLease>
}>

export type SurfaceLog = Readonly<{
  info(message: string, meta?: Readonly<Record<string, unknown>>): void
  warn(message: string, meta?: Readonly<Record<string, unknown>>): void
  error(message: string, meta?: Readonly<Record<string, unknown>>): void
}>

export type SurfaceExit = Readonly<{
  code: number | null
  signal: NodeJS.Signals | null
}>

export type SurfaceEndpoint = Readonly<{
  host: '127.0.0.1'
  port: number
  healthPath: string
}>

export type SurfaceRuntimeStart = Readonly<{
  deployment: ResolvedDeployment
  surface: ResolvedSurface
  artifact: ResolvedNodeArtifact
  secrets: Readonly<Record<string, string>>
  signal: AbortSignal
}>

export type SurfaceRuntimeHandle = Readonly<{
  sourceId: string
  endpoint: SurfaceEndpoint
  pid?: number
  exited: Promise<SurfaceExit>
  probe(signal: AbortSignal): Promise<boolean>
  terminate(): void
  kill(): void
  cleanup(): void | Promise<void>
}>

export type SurfaceRuntimeAdapter = Readonly<{
  kind: string
  start(input: SurfaceRuntimeStart): SurfaceRuntimeHandle | Promise<SurfaceRuntimeHandle>
}>

/**
 * Docker, Kubernetes and customer process managers implement this contract outside PackageManager.
 * The complete immutable deployment is passed through so production does not invent a second plan.
 */
export type ProductionSurfaceAdapter = Readonly<{
  deploy(
    deployment: ResolvedDeployment,
    context: Readonly<{
      signal: AbortSignal
      secrets: SurfaceSecretResolver
      log: SurfaceLog
    }>,
  ): Promise<Readonly<{ stop(signal?: AbortSignal): Promise<void> }>>
}>

export type SurfaceInstanceState = 'starting' | 'healthy' | 'crashed' | 'stopping'

export type SurfaceInstanceStatus = Readonly<{
  sourceId: string
  package: string
  surfaceId: string
  mount: string
  state: SurfaceInstanceState
  /** Desired package snapshot this instance was started from. */
  revision?: string
  endpoint?: SurfaceEndpoint
  exit?: SurfaceExit
}>

export type SurfaceControllerSnapshot = Readonly<{
  phase: 'idle' | 'starting' | 'running' | 'degraded' | 'stopping'
  deploymentHash?: string
  instances: readonly SurfaceInstanceStatus[]
}>

export type SurfaceController = Readonly<{
  start(deployment: ResolvedDeployment, signal?: AbortSignal): Promise<SurfaceControllerSnapshot>
  stop(signal?: AbortSignal): Promise<void>
  snapshot(): SurfaceControllerSnapshot
  /**
   * Cold update: stop the currently running instance for this `sourceId` (if any), then start the
   * new one. A start failure marks the Surface failed and does not restore the previous instance;
   * the Surface is briefly unreachable while the old instance is down and the new one starts.
   */
  update(
    deployment: ResolvedDeployment,
    surface: ResolvedSurface,
    options?: Readonly<{ artifacts?: SurfaceArtifactResolver; signal?: AbortSignal }>,
  ): Promise<SurfaceInstanceStatus>
}>

/** I3 (final review, Important): shared mount-lookup predicate -- an exact path match or a
 * `mount/...` sub-path. Lives in this leaf module (only `@agnes/host`'s `ResolvedDeployment` as a
 * dependency) rather than in `mount-proxy.ts` or `routes.ts` because those two already depend on
 * each other (`mount-proxy.ts` imports `FORGED_IDENTITY_KEYS`/`normalizeKey` from `routes.ts`), and
 * this predicate is used by both: `mount-proxy.ts`'s `matchMount` (browser -> Surface proxying, a
 * `{mount, host, port}[]` table) and `routes.ts`'s `routeTarget` (Surface -> Agnes SDK relay routing,
 * a `ResolvedSurface[]` table with `mount` nested under `.instance.mount`) -- the two tables have
 * different shapes, so only the boolean predicate itself is shared, not a single table-matching
 * function. Before this, the same three-way comparison (`pathname === mount ||
 * pathname.startsWith(mount + '/')`) was hand-duplicated in `supervisor.ts` (since-retired
 * `surfaceMountProxy`), `packages/cli/launch/surface-mounts.ts`, and `routes.ts`. */
export function mountMatches(mount: string, pathname: string): boolean {
  return pathname === mount || pathname.startsWith(`${mount}/`)
}

/** I3 (final review, Important): shared healthy-instance filter -- an instance only counts as
 * routable once it is `healthy` AND has been assigned a live loopback `endpoint` (a `starting`,
 * `crashed`, or `stopping` instance, or a healthy instance whose endpoint has not landed in the
 * snapshot yet, must never receive traffic). This exact filter was hand-duplicated between
 * `supervisor.ts`'s since-retired `surfaceMountProxy` closure and
 * `packages/daemon/src/local/methods/surfaces.ts`'s `registerSurfaces` handler; the latter is now
 * this predicate's sole call site. */
export function isRoutableSurfaceInstance(
  instance: SurfaceInstanceStatus,
): instance is SurfaceInstanceStatus & { endpoint: SurfaceEndpoint } {
  return instance.state === 'healthy' && instance.endpoint !== undefined
}
