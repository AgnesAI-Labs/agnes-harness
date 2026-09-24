import { createHash } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Duplex } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { domainFailureFromUnknown } from '@agnes/error-sanitization'
import { createSkillCordisService } from '@agnes/resource-control-runtime'
import {
  bootstrapWorkerResources,
  createWorkerMcpServerOpener,
  deploymentMcpPolicy,
  syncManagedMcpExecutableAllowlist,
  type WorkerResourceBootstrapInput,
} from '@agnes/resource-control-worker'
import { connectSupervisor } from './supervisor-connection.js'

export { scanSkills } from '@agnes/resource-control-worker'

import {
  agnesHome,
  composeProductionRequestMedia,
  composeSecrets,
  createCredentialStore,
  createExtensionActivationBarrier,
  createHost,
  createJitiPackageLoader,
  createLoader,
  createSecretsEnv,
  createSecretsFile,
  DEFAULT_COMPUTER_USE,
  type ExtensionIsolationOptions,
  type Host,
  type HostOptions,
  isServicePreDispatchFailure,
  type PackageLoader,
  type Prompter,
  packageDirs,
  REQUEST_MEDIA_ARTIFACT_RECLAIMED,
  type ResolvedProfile,
  readLock,
} from '@agnes/host'
import { createPackageManager } from '@agnes/package-manager'
import { LocalGate, type RuntimeConvergenceReport } from '@agnes/plugin-runtime/host'
import {
  workerGeneration as parseWorkerGeneration,
  type RpcError,
  rpcError,
  type SkillDescriptor,
  validateResourceControlData,
} from '@agnes/protocol'
import {
  admitWorkerCommand,
  applyMcpRowChange,
  handleServiceCommand,
  removeWorkspaceSkill,
  scanWorkspaceSkills,
  type WorkerResourceSlot,
} from './commands.js'
import type {
  SessionCommandFrame,
  SessionOpenFrame,
  SessionReplyFrame,
  SupervisorToWorker,
  WorkerCommandFrame,
  WorkerHello,
  WorkerReplyFrame,
} from './frames.js'
import { encodeFrame, JsonlDecoder } from './framing.js'
import {
  HostedSessions,
  SESSION_SCOPED_WORKER_METHODS,
  sessionIdleCloseMs,
  sessionScopedKey,
} from './hosted-sessions.js'
import { createMcpRowRuntime } from './mcp-row-runtime.js'
import { createRuntimeTargetSlot, type RuntimeTargetApplyPort } from './runtime-target-slot.js'
import { createWorkerServiceAuthority } from './service-authority.js'
import { SharedSessionChannel } from './shared-session-channel.js'
import { createMcpStatusFrameBuffer } from './status-frame-buffer.js'

/** Runtime capabilities already bootstrapped for this worker; reuse them without reconnecting. */
export type WorkerHostSkillResources = Readonly<{
  mcpManage?: NonNullable<HostOptions['mcpManage']>
  pluginManage?: NonNullable<HostOptions['pluginManage']>
  skillInstall?: NonNullable<HostOptions['skillInstall']>
  /** The same bounded, session-scoped artifact reader used by the executable-owned Host path. */
  requestMedia: NonNullable<HostOptions['requestMedia']>
  skillResources?: NonNullable<HostOptions['skillResources']>
  skillContribution?: NonNullable<HostOptions['skillContribution']>
  runtimePluginSnapshots?: NonNullable<HostOptions['runtimePluginSnapshots']>
  runtimePluginCatalogue?: NonNullable<HostOptions['runtimePluginCatalogue']>
  runtimePluginSources?: NonNullable<HostOptions['runtimePluginSources']>
  managedExtensionPackageIds?: NonNullable<HostOptions['managedExtensionPackageIds']>
  /** Trusted daemon-to-worker authority for narrowly scoped surface service calls. */
  serviceAuthority?: NonNullable<HostOptions['serviceAuthority']>
}>

/** Session workers assemble a Host that owns applyRuntimeTarget. */
export type WorkerHostLike = Host

/** Host assembly uses the verified filesystem loader by default; tests may inject a loader. */
export type WorkerHostDeps = {
  loader?: PackageLoader
  extensionLoader?: { import(file: string): Promise<Record<string, unknown>> }
  hostRoot?: string
  log?: Record<'debug' | 'info' | 'warn' | 'error', (msg: string) => void>
  /** Alternate executable composition; callers must retain verified package assembly. */
  buildHost?: (
    profile: ResolvedProfile,
    prompter: Prompter,
    resources: WorkerHostSkillResources,
  ) => Promise<WorkerHostLike>
  /** Embedder-only runtime switch; absent means every extension stays in-process. */
  extensionIsolation?: ExtensionIsolationOptions
}

/** @internal Exported for byte-level contract tests; callers should use the composed request-media port. */
export function decodeArtifactMediaResponse(
  value: unknown,
  expectedSha256: string,
  maxBytes: number,
): Uint8Array | typeof REQUEST_MEDIA_ARTIFACT_RECLAIMED | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    if (
      keys.length === 2 &&
      descriptors.sha256?.value === expectedSha256 &&
      descriptors.reclaimed?.value === true
    )
      return REQUEST_MEDIA_ARTIFACT_RECLAIMED
    if (
      keys.length !== 4 ||
      keys.some(
        (key) =>
          typeof key !== 'string' ||
          !['sha256', 'size', 'mime', 'data'].includes(key) ||
          descriptors[key]?.enumerable !== true ||
          !Object.hasOwn(descriptors[key] ?? {}, 'value'),
      )
    )
      return undefined
    const response = Object.fromEntries(
      (keys as string[]).map((key) => [key, descriptors[key]?.value]),
    ) as Record<string, unknown>
    if (
      response.sha256 !== expectedSha256 ||
      !Number.isSafeInteger(response.size) ||
      (response.size as number) < 1 ||
      (response.size as number) > maxBytes ||
      (response.mime !== 'image/png' && response.mime !== 'image/jpeg') ||
      typeof response.data !== 'string' ||
      response.data.length > Math.ceil(maxBytes / 3) * 4
    )
      return undefined
    const bytes = Uint8Array.from(Buffer.from(response.data, 'base64'))
    if (
      bytes.byteLength !== response.size ||
      Buffer.from(bytes).toString('base64') !== response.data ||
      createHash('sha256').update(bytes).digest('hex') !== expectedSha256
    )
      return undefined
    return bytes
  } catch {
    return undefined
  }
}

/** This package's own install root, the same role `hostRootFrom()` plays in cli's boot path. */
function hostRootFrom(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..')
}

/**
 * The worker process entry point: connect back to the supervisor, announce the shared business
 * worker (or a Host-free resource helper) with `hello`, wait for the start gate, then multiplex
 * session lifecycle and command frames until `close` or the link drops.
 *
 * `hello.workerGeneration` is supervisor-assigned. This prevents a delayed command for a replaced
 * worker from mutating its successor without conflating the process epoch with the client-facing
 * session cursor generation.
 */
export async function runWorker(
  env: NodeJS.ProcessEnv,
  io: { connect(path: string): Promise<Duplex>; gate: NodeJS.ReadableStream | null },
  deps: WorkerHostDeps = {},
): Promise<void> {
  const token = env.AGNES_WORKER_TOKEN
  const socketPath = env.AGNES_SUPERVISOR_SOCKET
  const workerKey = env.AGNES_WORKER_KEY
  const profileFile = env.AGNES_PROFILE_FILE
  const workerKind = env.AGNES_WORKER_KIND ?? 'session'
  const workerGeneration = parseWorkerGeneration(Number(env.AGNES_WORKER_GENERATION))
  if (!token || !socketPath || !workerKey || !profileFile)
    throw new Error('worker missing required AGNES_* env vars')
  if (workerKind !== 'session' && workerKind !== 'service') throw new Error('invalid AGNES_WORKER_KIND')
  if (workerKind === 'session' && workerKey !== '@shared')
    throw new Error('session worker requires AGNES_WORKER_KEY=@shared')
  if (workerKind === 'service' && env.AGNES_RESOURCE_CONTROL !== '1')
    throw new Error('service workers are reserved for resource-control helpers')
  const resourceLifecycleWorker = workerKind === 'service' && env.AGNES_RESOURCE_CONTROL === '1'
  const localGate = new LocalGate()
  const profile = JSON.parse(readFileSync(profileFile, 'utf8')) as ResolvedProfile
  // A shared session worker serves many unrelated roots and therefore has no workspace cwd. Its
  // static assembly root is the profile data directory; every workspace operation enters a
  // session-bound invocation. A single-purpose resource helper must receive its trusted root from
  // the daemon and never falls back to the process launch directory.
  const resourceWorkspaceRoot = resourceLifecycleWorker ? env.AGNES_WORKER_ROOT : undefined
  if (resourceLifecycleWorker && !resourceWorkspaceRoot)
    throw Object.assign(new Error('E_WORKSPACE_REQUIRED: resource worker root is unavailable'), {
      code: 'E_WORKSPACE_REQUIRED',
    })
  const cwd = resourceWorkspaceRoot ?? profile.dataDir

  const link = await io.connect(socketPath)
  const send = (frame: unknown): void => {
    link.write(encodeFrame(frame))
  }

  const sharedChannel = new SharedSessionChannel(send)
  const skillInstall: NonNullable<HostOptions['skillInstall']> = async (input, signal) => {
    if (input.sessionKey !== sharedChannel.currentSessionKey())
      throw new Error('Skill install session mismatch')
    return (await sharedChannel.request('skill-install', input, signal)) as Awaited<
      ReturnType<NonNullable<HostOptions['skillInstall']>>
    >
  }
  const mcpManage: NonNullable<HostOptions['mcpManage']> = async (input, signal) => {
    if (input.sessionKey !== sharedChannel.currentSessionKey())
      throw new Error('MCP management session mismatch')
    return sharedChannel.request('mcp-manage', input, signal)
  }
  const pluginManage: NonNullable<HostOptions['pluginManage']> = async (input, signal) => {
    if (input.sessionKey !== sharedChannel.currentSessionKey())
      throw new Error('plugins management session mismatch')
    return sharedChannel.request('plugin-manage', input, signal)
  }
  const prompter: Prompter = {
    ask(req, opts) {
      return sharedChannel.ask(req, opts)
    },
  }
  const sessionLog: NonNullable<WorkerHostDeps['log']> = Object.fromEntries(
    (['debug', 'info', 'warn', 'error'] as const).map((level) => [
      level,
      (message: string) => {
        try {
          sharedChannel.log(level, message)
        } catch {
          // Host assembly and worker-wide maintenance have no session context.
        }
      },
    ]),
  ) as NonNullable<WorkerHostDeps['log']>

  // Named and kept (not inlined into the bootstrapWorkerResources() call below) so a later stale
  // reload can re-run bootstrapWorkerResources() against the same env/profile/createBarrier/
  // createSecrets wiring — see commands.ts's reloadWorkerResources, which receives this same object
  // as `workerResourcesInput` through dispatch()'s command context.
  const workerResourcesInput: WorkerResourceBootstrapInput = {
    env,
    ...(resourceWorkspaceRoot ? { cwd: resourceWorkspaceRoot } : {}),
    profile,
    // The one call site that can see both @agnes/host and @agnes/resource-control-worker: resolve
    // the real Agnes home here and hand it down already resolved, rather than letting the worker
    // package guess at it from a raw env var it has no dedicated resolver for.
    agnesHomeDir: agnesHome(env),
    createBarrier: () => createExtensionActivationBarrier(),
    createSecrets: (resourceProfile) => {
      const environment = createSecretsEnv()
      if (resourceProfile.adapters.secrets.kind === 'env') return environment
      return composeSecrets(
        createSecretsFile({
          dir: resourceProfile.adapters.secrets.path ?? join(resourceProfile.dataDir, 'secrets'),
        }),
        environment,
      )
    },
    // Mirrors createSecrets above, for secretBinding.kind === 'oauth' (spec §1.6/§3.2/§3.5). Same
    // root `createConfigurationService` uses for its own `createCredentialStore` call
    // (packages/host/src/configuration.ts:565) -- both this worker process and the daemon-owned
    // config service read/write the same `~/.agh`-shaped credential store, by design (the
    // callback route that writes the initial token exchange runs in yet a third process --
    // `agnes serve`'s launcher -- see oauth-http-handler.ts's module header; all three agree on the
    // same on-disk root, not a shared in-memory handle).
    createOAuthCredentialStore: () => createCredentialStore({ root: agnesHome(env) }),
    // The shared session worker supplies MCP as Host rows, one per server, each owning its own
    // connection (stage 2b step 3, D107'); its resource generation connects nothing itself. The
    // resource-control service workers keep the manager path.
    ...(workerKind === 'session' ? { mcpRows: true } : {}),
  }
  // This worker's single source of truth for both its live resource generation and its pending
  // `resource.stale` notices, created once here and passed BY REFERENCE into every handleCommand
  // context below — see WorkerResourceSlot's doc comment (commands.ts) for why a per-command copy
  // synced back after the command finishes is unsound: `run`'s handler is awaited for the whole turn,
  // so it would revert any `resource.stale` (or reload) that a concurrent dispatch() performed in the
  // meantime. Nothing else in this process may hold a second copy of these two facts.
  const resourceSlot: WorkerResourceSlot = {
    generation: await bootstrapWorkerResources(workerResourcesInput),
    staleMarks: 0,
    reloadedMarks: 0,
  }
  let host: WorkerHostLike | undefined
  let hostedSessions: HostedSessions | undefined
  let resourcesClosed = false
  const closeResources = async (): Promise<void> => {
    if (resourcesClosed) return
    resourcesClosed = true

    await hostedSessions?.closeAll().catch(() => undefined)
    sharedChannel.closeAll()

    await host?.close().catch(() => undefined)
    await resourceSlot.generation?.runtime.mcp.close().catch(() => undefined)
    link.destroy()
  }
  const assemble = async <T>(operation: Promise<T>): Promise<T> => {
    try {
      return await operation
    } catch (error) {
      await closeResources()
      throw error
    }
  }
  // Startup-only read of the slot: nothing can mutate it before `link.on('data')` is wired below, so
  // a local const here is the same value the slot holds and keeps the assembly expressions readable.
  const bootResources = resourceSlot.generation
  if (resourceLifecycleWorker && !bootResources)
    throw new Error('resource lifecycle worker lacks a resource snapshot')
  const hostRoot = deps.hostRoot ?? hostRootFrom()
  const profileDir = join(agnesHome(env), 'profiles', profile.name)
  // Re-read trust and immutable active pins for every target. Installed package directories are
  // mutable and must never become executable sources for ordinary rows.
  const installedPackages = createPackageManager({ dataDir: profile.dataDir, agnesVersion: '0.0.0' })
  const runtimePluginSources = () => installedPackages.runtimePluginSnapshots(profileDir)
  const computerUse = profile.computerUse ?? DEFAULT_COMPUTER_USE
  // The shared `session` worker owns the ordinary Host and is where the supervisor dispatches
  // browser surface-service calls. Pass this through both default and packaged/custom Host assembly
  // paths; otherwise a packaged launcher silently drops the authority at its buildHost boundary.
  const workerServiceAuthority = workerKind === 'session' ? createWorkerServiceAuthority() : undefined
  const dimension = computerUse.capture.maxImageDimension
  const imageBytes = computerUse.capture.maxBytesPerImage
  const requestMedia = composeProductionRequestMedia({
    readArtifact: async ({ sessionKey, lane, nodeSeq, sha256, signal }) => {
      try {
        const response = await sharedChannel.run(sessionKey, () =>
          sharedChannel.request('artifact-media-read', { lane, nodeSeq, sha256 }, signal),
        )
        return decodeArtifactMediaResponse(response, sha256, imageBytes)
      } catch {
        return undefined
      }
    },
    surfaceLimits: {
      maxLedgerEvents: 10_000,
      maxSurfaceNodes: 2_048,
      maxContentBlocks: 4_096,
      maxManifestEntries: computerUse.retention.maxRecentPerSession,
      maxCandidateBytes: computerUse.retention.maxRecentPerSession * imageBytes,
      maxCandidatePixels: computerUse.retention.maxRecentPerSession * dimension * dimension,
    },
    mediaLimits: {
      maxManifestEntries: computerUse.retention.maxRecentPerSession,
      maxSelectedImages: computerUse.capture.maxImagesPerModelRequest,
      maxSelectedBlocks: computerUse.capture.maxImagesPerModelRequest * 2,
      maxBytesPerImage: imageBytes,
      maxDimensionPerImage: dimension,
      maxPixelsPerImage: dimension * dimension,
      maxSelectedBytes: computerUse.capture.maxImagesPerModelRequest * imageBytes,
      maxSelectedPixels: computerUse.capture.maxImagesPerModelRequest * dimension * dimension,
    },
  })

  const skillContribution = bootResources ? createSkillCordisService(bootResources.runtime.skills) : undefined
  // Explicit profile packages can supply presets at assembly time. Admit only active immutable
  // pins matching that profile's exact integrity; the Host still rejects any missing snapshot.
  const bootPackages = new Map(
    profile.packages
      .filter((pkg) => pkg.enabled && pkg.trust !== 'builtin')
      .map((pkg) => [pkg.id, pkg.integrity]),
  )
  const bootPackageSnapshots =
    !resourceLifecycleWorker && bootPackages.size
      ? {
          runtimePluginSnapshots: (await assemble(runtimePluginSources())).filter(
            (source) => bootPackages.get(source.snapshot.packageId) === source.snapshot.integrity,
          ),
        }
      : {}
  const hostCandidate: Promise<WorkerHostLike | undefined> = resourceLifecycleWorker
    ? Promise.resolve(undefined)
    : deps.buildHost
      ? deps.buildHost(profile, prompter, {
          skillInstall,
          mcpManage,
          pluginManage,
          requestMedia,
          runtimePluginSources,
          ...bootPackageSnapshots,
          ...(bootResources ? { skillResources: bootResources.skillResources } : {}),
          ...(workerServiceAuthority ? { serviceAuthority: workerServiceAuthority } : {}),
          ...(skillContribution ? { skillContribution } : {}),
        })
      : (() => {
          // Resource-control workers and embedders with a custom buildHost never import extension
          // source, and their intentionally minimal profile fixtures need not provide cacheDir.
          const moduleLoader =
            deps.extensionLoader ??
            (deps.loader
              ? {
                  async import(_file: string): Promise<Record<string, unknown>> {
                    throw new Error('runtime plugin snapshot needs an injected module loader')
                  },
                }
              : createLoader({ cacheDir: profile.cacheDir, hostRoot, agnesVersion: '0.0.0' }))
          return createHost(profile, {
            dataDir: profile.dataDir,
            profileDir,
            workspaceRoot: cwd,
            hostRoot,
            allowUnresolvedProvider: true,
            log: deps.log ?? sessionLog,
            prompter,
            skillInstall,
            mcpManage,
            pluginManage,
            requestMedia,
            // Browser/surface service calls are executed by the shared Host-bearing session worker.
            // The `service` kind is reserved for the resource-control lifecycle worker and does not
            // own the ordinary extension registry, so putting this authority there left every
            // otherwise valid browser query fail-closed at Host.
            ...(workerServiceAuthority ? { serviceAuthority: workerServiceAuthority } : {}),
            ...(deps.extensionIsolation ? { extensionIsolation: deps.extensionIsolation } : {}),
            extensionLoader: moduleLoader,
            ...(bootResources ?? {}),
            ...bootPackageSnapshots,
            ...(skillContribution ? { skillContribution } : {}),
            ...(deps.loader
              ? { loader: deps.loader }
              : {
                  runtimePluginSources,
                  loader: createJitiPackageLoader(moduleLoader),
                  packageDirs: packageDirs(profile, {
                    dataDir: profile.dataDir,
                    profileDir,
                    hostRoot,
                    lock: readLock(profileDir, { profile: profile.name, agnesVersion: '0.0.0' }),
                  }),
                }),
          })
        })()
  host = await assemble(hostCandidate)
  const statusFrames = createMcpStatusFrameBuffer(send)
  // Mount the snapshot's MCP servers as rows before anything can open a session. A failed first apply
  // leaves Host without them and is owed exactly like a missed `resource.stale`: the next turn's
  // reload re-derives the rows and applies them again.
  if (workerKind === 'session' && host && bootResources) {
    const deploymentAllowed = deploymentMcpPolicy(env).allowedExecutables
    const managedAllowed: string[] = []
    const restoreUnsetAllowlist = env.AGNES_MCP_STDIO_ALLOWLIST === undefined
    const mcpRows = createMcpRowRuntime({
      host,
      opener: createWorkerMcpServerOpener(workerResourcesInput, managedAllowed),
      beforeApply: (entries) =>
        syncManagedMcpExecutableAllowlist(
          entries,
          deploymentAllowed,
          managedAllowed,
          env,
          restoreUnsetAllowlist,
        ),
      // Rows are this worker's only MCP connections (design §3.2): their live status is what the
      // daemon's journal and admin page now show, in place of a resident management-plane worker's.
      onStatus: statusFrames.report,
    })
    resourceSlot.mcpRows = mcpRows
    try {
      await mcpRows.apply(bootResources.mcpEntries)
    } catch (error) {
      console.error('agnes worker: MCP rows failed to mount, will retry on the next run:', error)
      resourceSlot.staleMarks++
    }
  }
  const requireHost = (): WorkerHostLike => {
    if (!host) throw new Error('session worker has no Host')
    return host
  }
  const requireRuntimeTargetPort = (): RuntimeTargetApplyPort<RuntimeConvergenceReport> => {
    const candidate = requireHost()
    if (typeof candidate.applyRuntimeTarget !== 'function') {
      throw new Error('E_RUNTIME_TARGET_UNAVAILABLE: Host has no runtime target publisher')
    }
    return Object.freeze({ applyRuntimeTarget: candidate.applyRuntimeTarget.bind(candidate) })
  }
  const bootSource =
    env.AGNES_RUNTIME_BOOT_SOURCE === 'lastGood' || env.AGNES_RUNTIME_BOOT_SOURCE === 'bootstrap'
      ? env.AGNES_RUNTIME_BOOT_SOURCE
      : undefined
  const openHostedSessions = (): HostedSessions =>
    new HostedSessions({
      host: requireHost(),
      channel: sharedChannel,
      send,
      workerGeneration,
      workspaceRoot: cwd,
      workerResourcesInput,
      resources: resourceSlot,
      // Read once: a process-static limit, like every other `worker.` key.
      idleCloseMs: sessionIdleCloseMs(requireHost().profile?.limits),
    })
  if (workerKind === 'session' && !bootSource) hostedSessions = openHostedSessions()

  // One process-wide slot owns runtime-target ordering for the entire lifetime of the shared
  // session worker. It verifies each artifact before calling Host and never owns or retires a Host
  // runtime generation itself. Resource-control helpers do not host session runtime targets.
  const runtimeTargetSlot =
    workerKind === 'session' && typeof requireHost().applyRuntimeTarget === 'function'
      ? createRuntimeTargetSlot(requireRuntimeTargetPort())
      : undefined

  const serviceAborts = new Map<string, AbortController>()
  const dec = new JsonlDecoder()
  let shuttingDown = false
  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    await closeResources()
    process.exit(code)
  }

  // Live MCP health forwarding is per-generation (bootstrapWorkerResources()'s reportMcpStatus closes
  // over the one manager that particular call created), so a stale reload that swaps in a new
  // generation needs this re-armed against the new manager, not just called once at startup.
  const forwardMcpStatus = (generation: WorkerResourceSlot['generation']): void => {
    generation?.reportMcpStatus((status) =>
      send({ kind: 'resourceStatus', serverId: status.serverId, status }),
    )
  }
  // What forwardMcpStatus is currently armed against, so a generation swap is re-armed exactly once
  // no matter how many concurrent dispatch() calls observe it. Compared against the slot's LIVE value
  // rather than any per-command copy - that is the difference between noticing a swap and undoing it.
  let forwardedGeneration = resourceSlot.generation

  async function dispatch(frame: SupervisorToWorker): Promise<void> {
    if ('type' in frame) {
      if (!runtimeTargetSlot) throw new Error('runtime.stale is unavailable in this worker')
      const outcome = await runtimeTargetSlot.offer(frame)
      if (outcome.status === 'applied') {
        if (bootSource && !hostedSessions) {
          send({
            type: 'runtime.boot_ready',
            workerKind: 'session',
            workerKey: '@shared',
            generation: workerGeneration,
            digest: outcome.artifact.digest,
            identity: outcome.artifact.identity,
            source: bootSource,
          })
          hostedSessions = openHostedSessions()
        }
        send({
          type: 'runtime.converged',
          workerKind: 'session',
          workerKey: '@shared',
          generation: workerGeneration,
          digest: outcome.artifact.digest,
          identity: outcome.artifact.identity,
          report: outcome.value,
        })
        return
      }
      if (outcome.status === 'failed') {
        send({
          type: 'runtime.apply_failed',
          workerKind: 'session',
          workerKey: '@shared',
          generation: workerGeneration,
          digest: outcome.artifact.digest,
          identity: outcome.artifact.identity,
          phase: 'apply',
          message: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
        })
      }
      return
    }
    if (frame.kind === 'reply') {
      sharedChannel.settle(frame)
      return
    }
    if (frame.kind === 'close') {
      await shutdown(0)
      return
    }
    try {
      const result = await admitWorkerCommand(localGate, async () => {
        if (frame.kind === 'session.open') {
          if (!hostedSessions) throw new Error('runtime boot is not ready')
          return hostedSessions.open(frame as SessionOpenFrame)
        }
        if (frame.kind === 'session.tail') {
          if (!hostedSessions) throw new Error('session.tail is unavailable in this worker')
          await hostedSessions.tail(frame.sessionKey, frame.fromSeq)
          return {}
        }
        if (frame.kind === 'session.close') {
          if (!hostedSessions) throw new Error('session.close is unavailable in this worker')
          await hostedSessions.close(frame.sessionKey)
          return {}
        }
        if ('sessionKey' in frame) {
          if (!hostedSessions) throw new Error('session command is unavailable in this worker')
          return hostedSessions.dispatch(frame as SessionCommandFrame)
        }
        const resources = resourceSlot.generation
        const command = frame as WorkerCommandFrame
        if (command.method === 'resource.stale') {
          resourceSlot.staleMarks++
          return { ok: true }
        }
        // Session-worker-only (design §3.2/§3.3/§3.5): rows, not a resource-only worker's manager,
        // are this worker's MCP connections, and Skill scans/removals build their own throwaway
        // generation here instead of a dedicated skill-scan worker. A resource-only worker has no
        // `mcpRows` and falls through to handleServiceCommand's existing (soon-retired)
        // manager-backed path unchanged.
        if (resourceSlot.mcpRows) {
          const p = command.params as {
            serverId?: unknown
            expectedRevision?: unknown
            cursor?: unknown
            workspaceRoot?: unknown
            rootKey?: unknown
            snapshotRevision?: unknown
            descriptor?: unknown
            validateOnly?: unknown
          }
          if (command.method === 'resourceMcpApply' || command.method === 'resourceMcpReconnect') {
            if (typeof p.serverId !== 'string') throw new TypeError('invalid MCP apply/reconnect request')
            const status = await applyMcpRowChange(
              { host: requireHost(), resources: resourceSlot, workerResourcesInput },
              p.serverId,
              command.method === 'resourceMcpReconnect',
            )
            if (!status) throw new Error(`MCP server ${p.serverId} is not part of the current snapshot`)
            return status
          }
          if (command.method === 'resourceMcpTools') {
            if (typeof p.serverId !== 'string' || typeof p.expectedRevision !== 'string')
              throw new TypeError('invalid MCP tools request')
            const page = resourceSlot.mcpRows.tools(
              p.serverId,
              p.expectedRevision,
              typeof p.cursor === 'string' ? p.cursor : undefined,
            )
            if (!page) throw new Error('MCP tool catalog is unavailable for this revision')
            return page
          }
          if (command.method === 'resourceSkillScan') {
            if (typeof p.workspaceRoot !== 'string' || typeof p.snapshotRevision !== 'string')
              throw new TypeError('invalid Skill scan request')
            return scanWorkspaceSkills(workerResourcesInput, {
              workspaceRoot: p.workspaceRoot,
              ...(typeof p.rootKey === 'string' ? { rootKey: p.rootKey } : {}),
              snapshotRevision: p.snapshotRevision,
            })
          }
          if (command.method === 'resourceSkillRemove') {
            if (
              typeof p.workspaceRoot !== 'string' ||
              !validateResourceControlData('SkillDescriptor', p.descriptor).ok ||
              (p.validateOnly !== undefined && typeof p.validateOnly !== 'boolean')
            )
              throw new TypeError('invalid Skill deletion request')
            await removeWorkspaceSkill(workerResourcesInput, {
              workspaceRoot: p.workspaceRoot,
              descriptor: p.descriptor as SkillDescriptor,
              validateOnly: p.validateOnly === true,
            })
            return { ok: true }
          }
        }
        const serve = () =>
          handleServiceCommand(
            host,
            command,
            serviceAborts,
            resources ? { mcp: resources.runtime.mcp } : undefined,
            workerGeneration,
          )
        const scopedKey = sessionScopedKey(command.params)
        // A command that names a session needs that session open; a hibernated one is woken first.
        if (
          hostedSessions &&
          SESSION_SCOPED_WORKER_METHODS.includes(command.method) &&
          scopedKey !== undefined
        )
          return hostedSessions.withSession(scopedKey, command.method, serve)
        return serve()
      })
      if (resourceSlot.generation !== forwardedGeneration) {
        forwardedGeneration = resourceSlot.generation
        forwardMcpStatus(forwardedGeneration)
      }
      const reply = {
        kind: 'reply' as const,
        requestId: frame.requestId,
        ...('sessionKey' in frame ? { sessionKey: frame.sessionKey } : {}),
        result,
      }
      send(reply satisfies WorkerReplyFrame | SessionReplyFrame)
    } catch (e) {
      const err = e as { code?: unknown; message?: string }
      const servicePreDispatch =
        frame.kind === 'command' &&
        (frame.method === 'inspectService' || frame.method === 'callService') &&
        isServicePreDispatchFailure(e)
      const error: NonNullable<WorkerReplyFrame['error']> =
        typeof err.code === 'number'
          ? ({
              ...(e as RpcError),
              ...(servicePreDispatch
                ? { data: { ...(e as RpcError).data, _servicePhase: 'pre-dispatch' } }
                : {}),
            } as RpcError)
          : servicePreDispatch
            ? rpcError('INTERNAL_ERROR', {
                code: typeof err.code === 'string' ? err.code : 'INTERNAL_ERROR',
                _servicePhase: 'pre-dispatch',
              })
            : domainFailureFromUnknown(e)
      const reply = {
        kind: 'reply' as const,
        requestId: frame.requestId,
        ...('sessionKey' in frame ? { sessionKey: frame.sessionKey } : {}),
        error,
      }
      send(reply satisfies WorkerReplyFrame | SessionReplyFrame)
    }
  }

  // A `resource.stale` frame ahead of any other frame in the same batch must take effect before the
  // next frame in that batch is dispatched. dec.feed() can return more than one frame from a single
  // chunk (framing.ts; the daemon's own WorkerLink relies on the same multi-frame-per-read possibility
  // - worker-link.ts), and the daemon can legitimately write a `resource.stale` notification and a
  // `run` command for the same worker close enough together in time (an unrelated resource-control
  // mutation racing a client's in-flight turn) that the OS coalesces both writes into one 'data'
  // event - reproduced directly in worker-runtime/test/resource-reload-dispatch.test.ts's "arrive in
  // the SAME decoded chunk" case. Since the mark now lands directly on the shared resource slot, the
  // handler reaches it before its first await and ordering no longer depends on any post-await
  // sync-back; awaiting the notification here keeps that ordering explicit and independent of whether
  // the handler ever grows an await of its own. Every other frame kind keeps the original
  // fire-and-forget dispatch: `abort` in particular must run concurrently with an in-flight `run` in
  // the same batch to actually interrupt it, so this must not become a blanket "await every frame in
  // order" loop.
  const dispatchFrames = async (frames: SupervisorToWorker[]): Promise<void> => {
    for (const raw of frames) {
      if ('type' in raw) void dispatch(raw).catch(() => shutdown(1))
      else if (raw.kind === 'command' && raw.method === 'resource.stale') await dispatch(raw)
      else void dispatch(raw).catch(() => shutdown(1))
    }
  }
  link.on('data', (chunk: Buffer) => {
    let frames: unknown[]
    try {
      frames = dec.feed(chunk)
    } catch {
      // JsonlDecoder never resynchronizes after a throw (framing.ts) - the only sound response to a
      // malformed or oversized frame from the supervisor is the same one connection.ts takes on the
      // client-facing side: stop trusting this link rather than silently drop or misread whatever
      // follows it.
      void shutdown(1)
      return
    }
    void dispatchFrames(frames as SupervisorToWorker[]).catch(() => shutdown(1))
  })
  link.on('close', () => void shutdown(0))
  link.on('error', () => void shutdown(1))

  const hello: WorkerHello = {
    kind: 'hello',
    token,
    workerKey,
    workerGeneration,
    profileHash: profile.hash,
    workerKind,
    ...(bootResources
      ? {
          resources: {
            snapshotRevision: bootResources.revision,
            skills: bootResources.skills,
            mcp: bootResources.mcp,
          },
        }
      : {}),
  }
  try {
    send(hello)
  } catch (error) {
    // Destroying the link emits close; mark shutdown first so that callback cannot close twice or
    // convert the startup failure into a successful process exit.
    shuttingDown = true
    await closeResources()
    throw error
  }
  // Only now can the daemon attribute a resourceStatus frame to this worker's key; anything a row
  // reported while assembling Host, above, waited right here for it.
  statusFrames.open()
  forwardMcpStatus(bootResources)

  // The plugin revision is already active. The gate keeps the worker from accepting requests until
  // the supervisor has authenticated and adopted this exact generation.
  if (io.gate)
    await new Promise<void>((resolve) => {
      io.gate?.once('data', (d: unknown) => {
        if (String(d).startsWith('start')) resolve()
      })
    })
}

/** Start the worker wire loop with executable-owned package composition. */
export function runWorkerExecutable(deps: WorkerHostDeps = {}): Promise<void> {
  const env = { ...process.env }
  const gateFd = Number(process.env.AGNES_GATE_FD ?? 3)
  const gate = Number.isInteger(gateFd) && gateFd >= 0 ? createReadStream('', { fd: gateFd }) : null
  return runWorker(
    env,
    {
      connect: (path) => connectSupervisor(path, env),
      gate,
    },
    deps,
  )
}

declare const AGNES_COMPOSED_WORKER: boolean | undefined

// Bundling merges module URLs, so the executable build also disables this source entry explicitly.
if (
  (typeof AGNES_COMPOSED_WORKER === 'undefined' || !AGNES_COMPOSED_WORKER) &&
  process.env.AGNES_WORKER_TOKEN &&
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  void runWorkerExecutable().catch((error: unknown) => {
    console.error('agnes worker failed to start:', error)
    process.exit(1)
  })
}
