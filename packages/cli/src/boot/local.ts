import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createLocalEndpoint,
  createPrompterBridge,
  createSessionAdmissionPort,
  LOCAL_IDENTITY,
  SessionPrincipalOwnershipIndex,
  SessionWorkspaceIndex,
  WorkspaceBindingIndex,
  WorkspaceCatalog,
  WorkspaceIndex,
} from '@agnes/daemon/local'
import {
  type ConfigurationService,
  composeProductionRequestMedia,
  createConfigurationService,
  createHost,
  createJitiPackageLoader,
  createLoader,
  createLocalArtifactReadStore,
  createPlatform,
  createSqliteStorage,
  DEFAULT_COMPUTER_USE,
  type ExtensionIsolationOptions,
  type Host,
  HostError,
  type HostOptions,
  type LockState,
  type PackageLoader,
  type Prompter,
  packageDirs,
  type ResolvedProfile,
  readLock,
  resolveProfile,
  resolveWorkspaceDirectory,
  type SqliteStorage,
  verifyLockIntegrity,
} from '@agnes/host'
import { createClient, memoryJournal } from '@agnes/sdk'
import { packagedPackages } from '../../launch/packaged-host.js'
import { resolveLaunchResources } from '../../launch/resources.js'
import { BootError } from '../errors.js'
import type { BootDeps, Booted, ParsedArgs } from '../types.js'
import { profileNameFrom, readProfileInputs } from './inputs.js'
import { readScreenshotBytes } from './screenshot-read.js'

/** Defined by the normal packaged local build; absent in source and SEA development runs. */
declare const AGNES_PACKAGED_BUILTINS: boolean | undefined

function packagedRuntime(): boolean {
  return typeof AGNES_PACKAGED_BUILTINS !== 'undefined' && AGNES_PACKAGED_BUILTINS === true
}

/** The installed root of this package, which is what host resolves builtin package entries against. */
export function hostRootFrom(): string {
  if (process.getBuiltinModule('node:sea').isSea()) return dirname(process.execPath)
  if (packagedRuntime()) return dirname(fileURLToPath(import.meta.url))
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

export type LocalBootDeps = BootDeps & {
  /** Optional interactive onboarding gate. It runs before profile/Host assembly. */
  onboarding?: (input: { profile: string; home: string; cwd: string; signal?: AbortSignal }) => Promise<void>
  /**
   * Replaces the default package wiring (host's jiti loader over the directories `packageDirs`
   * resolves from the profile's lockfile). A test seam, like `createHostImpl`: a caller that
   * supplies its own loader owns where packages come from, and the lockfile read and directory
   * resolution are skipped along with the default loader.
   */
  loader?: PackageLoader
  /** Overrides the lock layer readProfileInputs would read off disk; a test seam, like `loader`. */
  lock?: LockState
  createHostImpl?: (profile: ResolvedProfile, prompter: Prompter) => Promise<Host>
  /** Embedder-only runtime switch; absent means every extension stays in-process. */
  extensionIsolation?: ExtensionIsolationOptions
  /** Host-owned shared configuration service, primarily a test/embedder seam. */
  configuration?: ConfigurationService
  /** Internal ledger/ownership-bound media port composed by bootLocal. */
  requestMedia?: NonNullable<HostOptions['requestMedia']>
}

/**
 * The default package wiring: host's jiti loader plus the directory map `packageDirs` resolves out
 * of the profile's lockfile (absent file means an empty lock, which is exactly the builtin-only
 * case the default exists for). The lockfile read happens here rather than inside createHost
 * because the boot layer owns the profileDir and hostRoot it is resolved against.
 */
async function defaultPackages(
  deps: LocalBootDeps,
  profile: ResolvedProfile,
  profileDir: string,
  hostRoot: string,
): Promise<{
  loader: PackageLoader
  packageDirs: Map<string, string>
  extensionLoader?: { import(file: string): Promise<Record<string, unknown>> }
}> {
  const lock = readLock(profileDir, { profile: profile.name, agnesVersion: deps.agnesVersion })
  verifyLockIntegrity(lock, { dataDir: profile.dataDir, profile: profile.name })
  if (process.getBuiltinModule('node:sea').isSea() || packagedRuntime())
    return packagedPackages(
      profile,
      deps.home,
      process.getBuiltinModule('node:sea').isSea() ? process.execPath : fileURLToPath(import.meta.url),
    )
  return {
    loader: createJitiPackageLoader(
      createLoader({ cacheDir: profile.cacheDir, hostRoot, agnesVersion: deps.agnesVersion }),
    ),
    packageDirs: packageDirs(profile, { dataDir: profile.dataDir, profileDir, lock, hostRoot }),
  }
}

/**
 * Builds the Host behind both a normal local boot and read-only diagnostics. Keeping the package
 * loader, lock-derived directories and logger here prevents `doctor` from assembling a subtly
 * different product than the one a prompt would use.
 */
export async function assembleLocalHost(
  profile: ResolvedProfile,
  profileName: string,
  cwd: string,
  deps: LocalBootDeps,
  prompter: Prompter,
): Promise<Host> {
  const profileDir = join(deps.home, 'profiles', profileName)
  const hostRoot = hostRootFrom()
  const windowsNodeExecutable =
    !deps.createHostImpl && process.getBuiltinModule('node:sea').isSea()
      ? resolveLaunchResources().runtimeNode
      : undefined
  return deps.createHostImpl
    ? deps.createHostImpl(profile, prompter)
    : createHost(profile, {
        dataDir: profile.dataDir,
        profileDir,
        workspaceRoot: cwd,
        hostRoot,
        log: hostLogger(deps.log),
        prompter,
        ...(deps.requestMedia ? { requestMedia: deps.requestMedia } : {}),
        agnesVersion: deps.agnesVersion,
        ...(windowsNodeExecutable !== undefined ? { windowsNodeExecutable } : {}),
        ...(deps.extensionIsolation ? { extensionIsolation: deps.extensionIsolation } : {}),
        ...(deps.loader
          ? { loader: deps.loader }
          : await defaultPackages(deps, profile, profileDir, hostRoot)),
        ...(deps.signal ? { signal: deps.signal } : {}),
      })
}

/**
 * The one-shot form: resolve a profile, build a host, wrap it in the in-process daemon endpoint and
 * hand back an sdk client speaking to it. Nothing above this knows which of the three transports it
 * got, which is what lets `--connect` be a boot-time choice rather than a mode-time one.
 *
 * Every failure on the way is a BootError, so a caller has one exit code to map rather than the
 * union of host's, daemon's and sdk's error surfaces.
 */
/** Swallows a failure that is not the caller's to hear about, without pretending it returned one. */
const noop = (): undefined => undefined

/** Adapts Host's owner-scoped SQL handle to daemon's parameterized TableHandle contract. */
function daemonTable(storage: SqliteStorage, name: string) {
  const table = storage.tables('@agnes/daemon').table(name)
  return Object.freeze({
    exec(sql: string, params: unknown[] = []) {
      if (params.length) table.run(sql, params)
      else table.exec(sql)
    },
    get: <T>(sql: string, params: unknown[] = []) => table.get<T>(sql, params),
    all: <T>(sql: string, params: unknown[] = []) => table.all<T>(sql, params),
    transaction: <T>(fn: () => T) => table.transaction(fn),
  })
}

/**
 * host's four log channels, forwarded to the one line sink boot was given. Discarding them -- which
 * is what four noops did -- threw away every warning and every error host emits while assembling,
 * which is exactly the material an operator needs when a real profile will not come up.
 *
 * The message goes through and the structured fields do not. host masks credential-shaped text in
 * the messages it raises (errors.ts) and nothing masks a `detail` object, so serialising one here
 * would route unmasked values to a terminal. A field an operator needs belongs in the message.
 */
function hostLogger(
  sink: (line: string) => void,
): Record<'debug' | 'info' | 'warn' | 'error', (msg: string) => void> {
  const at = (level: string) => (msg: string) => sink(`host ${level}: ${msg}`)
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }
}

export async function bootLocal(p: ParsedArgs, deps: LocalBootDeps): Promise<Booted> {
  const t0 = performance.now()
  const profileName = profileNameFrom(p, deps.env)
  const cwd = p.cwd ?? deps.cwd
  if (deps.onboarding) {
    try {
      await deps.onboarding({
        profile: profileName,
        home: deps.home,
        cwd,
        ...(deps.signal ? { signal: deps.signal } : {}),
      })
    } catch (e) {
      throw asBootError('onboarding', e)
    }
  }
  // Host owns the service and its persistence. The dependency seam is useful to embedders/tests, but
  // the normal CLI always constructs the same service used by the standalone daemon launcher.
  const configuration =
    deps.configuration ?? createConfigurationService({ home: deps.home, profile: profileName })
  let profile: ResolvedProfile
  try {
    const configurationInput = configuration ? await configuration.profileInput() : undefined
    const inputs = await readProfileInputs({
      home: deps.home,
      cwd,
      flags: {
        profile: profileName,
        park: p.park,
        cwd,
        ...(p.preset ? { preset: p.preset } : {}),
        ...(p.model ? { model: p.model } : {}),
      },
      agnesVersion: deps.agnesVersion,
      ...(deps.lock ? { lock: deps.lock } : {}),
      ...(configurationInput ? { configuration: configurationInput } : {}),
    })
    profile = await resolveProfile(inputs, {
      platform: createPlatform().snapshot(),
      agnesVersion: deps.agnesVersion,
      now: new Date().toISOString(),
      // `--ephemeral` owns this home. Letting resolveProfile fall back to os.homedir() made the
      // supposedly disposable run write its data/audit/cache beneath the real ~/.agh.
      homeDir: deps.home,
    })
  } catch (e) {
    throw asBootError('profile', e)
  }

  const bridge = createPrompterBridge()
  let ownershipStorage: SqliteStorage | undefined
  let sessionOwnership: SessionPrincipalOwnershipIndex
  let workspaces: WorkspaceCatalog
  try {
    mkdirSync(profile.dataDir, { recursive: true })
    ownershipStorage = createSqliteStorage({
      file: join(profile.dataDir, 'sessions.db'),
      tablesDir: join(profile.dataDir, 'tables'),
    })
    sessionOwnership = new SessionPrincipalOwnershipIndex(
      daemonTable(ownershipStorage, 'session_principal_ownership'),
    )
    const sessionWorkspaces = new SessionWorkspaceIndex(daemonTable(ownershipStorage, 'session_workspaces'))
    workspaces = new WorkspaceCatalog(
      new WorkspaceIndex(daemonTable(ownershipStorage, 'workspace_registry')),
      sessionWorkspaces,
      resolveWorkspaceDirectory,
      () => Date.now(),
      new WorkspaceBindingIndex(daemonTable(ownershipStorage, 'workspace_bindings')),
    )
    // Same authority source as the daemon supervisor: the CLI launch cwd is registered once. Ambient
    // session/new still cannot mint a workspace from an unregistered path.
    await workspaces.add(cwd)
  } catch (e) {
    await ownershipStorage?.close().catch(noop)
    throw asBootError('session ownership', e)
  }
  const computerUse = profile.computerUse ?? DEFAULT_COMPUTER_USE
  const dimension = computerUse.capture.maxImageDimension
  const imageBytes = computerUse.capture.maxBytesPerImage
  const artifacts = createLocalArtifactReadStore({
    dataDir: profile.dataDir,
    maxArtifactBytes: imageBytes,
  })
  let mediaHost: Host | undefined
  const requestMedia = composeProductionRequestMedia({
    readArtifact: async ({ sessionKey, lane, nodeSeq, sha256, signal }) => {
      try {
        const before = sessionOwnership.resolve(sessionKey)
        const session = mediaHost?.kernel.get(sessionKey)
        if (!before?.active || !session || signal.aborted) return undefined
        const [event] = await session.scan({ fromSeq: nodeSeq, toSeq: nodeSeq, order: 'asc', limit: 1 })
        if (
          !event ||
          event.seq !== nodeSeq ||
          event.type !== 'tool/result' ||
          event.origin !== 'tool:computer_use' ||
          event.trust !== 'untrusted' ||
          (event.lane ?? 'main') !== lane
        )
          return undefined
        const data = event.data as { content?: unknown; isError?: unknown }
        if (data.isError !== false || !Array.isArray(data.content)) return undefined
        const authorized = data.content.some((value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return false
          const block = value as Record<string, unknown>
          return (
            block.type === 'resource_link' &&
            block.uri === `artifact://${sha256}` &&
            (block.mimeType === 'image/png' || block.mimeType === 'image/jpeg')
          )
        })
        if (!authorized || signal.aborted) return undefined
        return await readScreenshotBytes(artifacts, sha256, signal, () => {
          const after = sessionOwnership.resolve(sessionKey)
          return (
            !!after?.active &&
            after.principalId === before.principalId &&
            mediaHost?.kernel.get(sessionKey) === session &&
            !signal.aborted
          )
        })
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
  let host: Host
  try {
    host = await assembleLocalHost(profile, profileName, cwd, { ...deps, requestMedia }, bridge.prompter)
    mediaHost = host
  } catch (e) {
    await ownershipStorage.close().catch(noop)
    throw asBootError('host', e)
  }
  const endpoint = createLocalEndpoint(host, {
    agnesVersion: deps.agnesVersion,
    sessionOwnership,
    workspaces,
    ...(configuration ? { configuration } : {}),
    ...(deps.prompter ? { prompter: deps.prompter } : {}),
  })
  const sessionAdmission = createSessionAdmissionPort({
    ownership: sessionOwnership,
    workspaces,
    host,
    principalId: LOCAL_IDENTITY.principalId,
  })
  // Bound after the endpoint exists, not before: until this line an ask is answered 'unavailable',
  // which is the verdict meaning nobody was asked.
  bridge.bind(endpoint.prompter)
  const client = createClient({ transport: { kind: 'inproc', endpoint }, journal: memoryJournal() })
  try {
    // ACP is itself the client of this endpoint. Initialising the SDK client here would start a
    // second consumer of notifications and race the stdio pump for session/update frames.
    if (p.mode !== 'acp') await client.initialize()
  } catch (e) {
    await client.close().catch(noop)
    await endpoint.close().catch(noop)
    await ownershipStorage.close().catch(noop)
    await host.close().catch(noop)
    throw asBootError('handshake', e)
  }
  return {
    client,
    ...(p.mode === 'acp' ? { endpoint } : {}),
    host,
    sessionAdmission,
    profileName,
    resolvedProfileHash: profile.hash,
    bootMs: performance.now() - t0,
    form: 'local',
    // In dependency order, and each one guarded: a close that throws halfway leaves the host running
    // with nothing left holding a reference to it, which on the one-shot path is a process that
    // never exits.
    close: async () => {
      await client.close().catch(noop)
      await endpoint.close().catch(noop)
      await ownershipStorage.close().catch(noop)
      await host.close().catch(noop)
    },
  }
}

// A HostError already reads as a startup refusal and its own constructor has put its code in front of
// the message, so it is carried through verbatim; prefixing the code again printed it twice. Anything
// else is named by the phase it came out of. The cause is kept either way so `--verbose` can grow one.
function asBootError(phase: string, e: unknown): BootError {
  // A BootError raised further down already names what it was about -- readProfileInputs says which
  // file is not valid yaml -- so wrapping it again would prefix a phase in front of a sentence that
  // is already complete.
  if (e instanceof BootError) return e
  if (e instanceof HostError) return new BootError(e.message, e)
  return new BootError(`${phase}: ${e instanceof Error ? e.message : String(e)}`, e)
}
