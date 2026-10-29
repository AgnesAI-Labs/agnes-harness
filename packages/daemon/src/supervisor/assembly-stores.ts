import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { collectPackageSkillFiles } from '@agnes/base'
import { createResourceControlService, createResourceControlStore } from '@agnes/daemon-admin/resources/index'
import type { ConnectionState, LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { NoticeSink } from '@agnes/daemon-foundation/local/notice'
import { MemoryClaims, MemoryJournal } from '@agnes/daemon-foundation/local/ports'
import { NonceTable, TableClaims } from '@agnes/daemon-foundation/storage/claims-table'
import { PersistentCommandJournal } from '@agnes/daemon-foundation/storage/command-journal'
import type { SessionWorkspacePort } from '@agnes/daemon-foundation/storage/lister'
import {
  MemorySessionWorkspaces,
  SessionWorkspaceIndex,
  TicketIndex,
} from '@agnes/daemon-foundation/storage/lister'
import {
  MemorySessionPrincipalOwnership,
  SessionPrincipalOwnershipIndex,
} from '@agnes/daemon-foundation/storage/session-ownership'
import { SourceAuthRotation } from '@agnes/daemon-foundation/storage/source-auth-rotation'
import { workspaceIdFor } from '@agnes/daemon-foundation/storage/workspaces'
import { PersistentArtifactReadAuthorityIndex } from '@agnes/daemon-rpc/local/artifact-read-authority'
import { createExtensionActivationBarrier, createPlatform } from '@agnes/host'
import { writePackageSkillInventory } from '@agnes/resource-control-daemon'
import { windowsEnsurePrivateDirectorySync } from '@agnes/system-node'
import {
  composeDefaultProductionProjectedArtifactRead,
  composeProductionArtifactRead,
  composeProductionProjectedArtifactRead,
} from './artifact-read.js'
import type { AssemblyLifetime } from './assembly-lifetime.js'
import type { AssemblyBase, StartSupervisorOptions } from './assembly-options.js'
import { startJwksCache } from './jwks-cache.js'
import { acquireDaemonMutationLock } from './mutation-lock.js'
import { canonicalPath } from './scope.js'
import { persistResolvedProfile } from './storage-adapters.js'
import { openWorkspaceCatalog } from './workspace-catalog.js'

export type Conn = { ep: LocalEndpoint; conn: ConnectionState }

export async function openStores(state: AssemblyBase, lifetime: AssemblyLifetime) {
  const { o, clock, ownerHome } = state
  // Retain storage exclusivity and refuse a live pre-home-layout daemon during migration.
  if (!state.storageLocked && (await canonicalPath(o.config.dataDir)) !== ownerHome) {
    const guard = acquireDaemonMutationLock(o.config.dataDir)
    lifetime.own({ dispose: () => guard.release() })
  }
  // The profile is worker input, not a startup marker. Persist it only after the owner lock is
  // held so a competing launch cannot overwrite the profile currently used by another daemon.
  await persistResolvedProfile(o.profileFile, o.profile)
  if (
    o.artifactAuthorityProjection !== undefined &&
    (o.ports?.artifactRead !== undefined || o.artifactReadAuthority !== undefined)
  )
    throw new Error('artifact authority projection conflicts with another artifact read composition')
  const conns = new Set<Conn>()
  const jobTables = o.jobTables
  const tickets = jobTables ? new TicketIndex(jobTables.table('approval_tickets')) : undefined
  const workspaces: SessionWorkspacePort = jobTables
    ? new SessionWorkspaceIndex(jobTables.table('session_workspaces'))
    : new MemorySessionWorkspaces()
  const sessionOwnership = jobTables
    ? new SessionPrincipalOwnershipIndex(jobTables.table('session_principal_ownership'))
    : new MemorySessionPrincipalOwnership()
  const workspaceCatalog = await openWorkspaceCatalog({
    dataDir: o.config.dataDir,
    tables: jobTables,
    sessions: workspaces,
    clock,
    workspaceRoot: o.workspaceRoot,
  })
  const resourceControlDirectory = join(o.config.dataDir, 'resource-control')
  // Global MCP/user/package resource workers use a server-owned data root when this daemon was
  // not launched for one workspace. Caller-selected workspace ids still resolve only through the
  // registered WorkspaceCatalog below.
  const resourceWorkerRoot = o.workspaceRoot ?? resourceControlDirectory
  const resourceWorkerWorkspaceId = workspaceIdFor(resourceWorkerRoot)
  const bindResourceWorkspace = async (workspaceId?: string) => {
    if (!o.workspaceRoot && !workspaceId) return resourceWorkerWorkspaceId
    return (await workspaceCatalog.bind(workspaceId, resourceWorkerRoot)).workspaceId
  }
  const localResourceStore = o.resources
    ? undefined
    : createResourceControlStore({
        directory: resourceControlDirectory,
        scope: { allowedProfiles: [o.profile.name] },
        resolveWorkspaceId: bindResourceWorkspace,
      })
  const resourceControl: NonNullable<StartSupervisorOptions['resources']> =
    o.resources ??
    (() => {
      if (!localResourceStore) throw new Error('default resource store was not created')
      return { service: createResourceControlService(localResourceStore) }
    })()
  // Recovery is deliberately after the default store receives its service-worker adapters below.
  // Recovering an adapterless store advances rows to running without any possible execution.
  await localResourceStore?.writeWorkerSnapshot(o.profile.name)
  const packageSkillSnapshotPath = join(
    resourceControlDirectory,
    'worker-snapshots',
    `${o.profile.name}.package-skills.json`,
  )
  const resourceSkillLkgDirectory = join(resourceControlDirectory, 'skill-lkg', o.profile.name)
  if (createPlatform().snapshot().os === 'win32') windowsEnsurePrivateDirectorySync(resourceSkillLkgDirectory)
  else await mkdir(resourceSkillLkgDirectory, { recursive: true, mode: 0o700 })
  // Inventory verifies the lock and installed tree before any contribution reaches a worker.
  // A package-bearing profile therefore fails closed at startup rather than silently scanning a
  // user-controlled package directory.
  await writePackageSkillInventory(
    o.profile,
    o.profileDir,
    packageSkillSnapshotPath,
    collectPackageSkillFiles,
  )
  const activationBarrier = o.activationBarrier ?? createExtensionActivationBarrier()
  const notices = new NoticeSink({
    endpoints: () => [...conns],
    ...(o.audit ? { audit: o.audit } : {}),
    clock,
  })

  // Per session key, the connection whose `session/prompt` call currently holds `entry.inflight` -
  // set/cleared by the `onPromptStart`/`onPromptEnd` hooks each connection's own context installs
  // below (acp.ts calls them exactly around the window it holds `inflight`, so this can never observe
  // two connections "owning" the same session key at once; a concurrent second prompt is rejected
  // with SESSION_BUSY before either hook fires). This is what `PrompterRouter.originOf` needs and
  // `AgnesContext` has no field for: the in-process `createLocalEndpoint` form gets away with reading
  // `registry.get(key)?.inflight` directly because it only ever has one connection to attribute that
  // to - a supervisor with several concurrently-connected clients does not have that luxury.
  const inflightConn = new Map<string, ConnectionState>()

  const journal =
    o.ports?.journal ??
    (jobTables
      ? new PersistentCommandJournal(jobTables.table('command_journal'), clock)
      : new MemoryJournal(clock))
  await journal.gc(clock())
  const claims =
    o.ports?.claims ?? (jobTables ? new TableClaims(jobTables.table('auth_claims')) : new MemoryClaims())
  const nonces = jobTables ? new NonceTable(jobTables.table('auth_nonces')) : { consume: () => true }
  const persistentClaims = claims instanceof TableClaims ? claims : undefined
  const configuredSourceCredentials = o.remoteAuth?.sourceAuthCredentials
  const configuredSourceSecrets = o.remoteAuth?.sourceAuthSecrets
  const sourceRotation =
    configuredSourceCredentials?.length && jobTables
      ? new SourceAuthRotation(jobTables.table('source_auth_rotation'))
      : undefined
  sourceRotation?.configure(configuredSourceCredentials ?? [], clock())
  const ephemeralSourceKeyId = randomBytes(16).toString('hex')
  const runtimeSourceCredentials =
    configuredSourceCredentials ??
    configuredSourceSecrets?.map((secret, index) => ({ credentialId: `ephemeral:${index}`, secret }))
  const effectiveRemoteAuth = o.remoteAuth
    ? {
        ...o.remoteAuth,
        ...(runtimeSourceCredentials?.length
          ? {
              sourceAuthKeys: () =>
                sourceRotation
                  ? sourceRotation.accepted(
                      configuredSourceCredentials ?? [],
                      clock(),
                      o.remoteAuth?.rotationGraceMs ?? 86_400_000,
                    )
                  : runtimeSourceCredentials.map((credential, index) => ({
                      secret: credential.secret,
                      keyId: `${ephemeralSourceKeyId}:${index}`,
                    })),
            }
          : {}),
      }
    : undefined
  if (effectiveRemoteAuth?.jwt?.jwksUrl && effectiveRemoteAuth.jwt) {
    const stopJwksCache = await startJwksCache({
      url: effectiveRemoteAuth.jwt.jwksUrl,
      target: effectiveRemoteAuth.jwt,
      ...(o.jwksResolver ? { resolver: o.jwksResolver } : {}),
      ...(o.jwksTransport ? { transport: o.jwksTransport } : {}),
    })
    lifetime.own({ stop: stopJwksCache, dispose: () => undefined })
  }
  const projectedArtifactRead =
    o.artifactAuthorityProjection !== undefined
      ? composeProductionProjectedArtifactRead(o.config.dataDir, o.artifactAuthorityProjection)
      : o.artifactAuthorityTable &&
          jobTables &&
          sessionOwnership instanceof SessionPrincipalOwnershipIndex &&
          o.ports?.artifactRead === undefined &&
          o.artifactReadAuthority === undefined
        ? composeDefaultProductionProjectedArtifactRead(o.config.dataDir, {
            artifactAuthority: new PersistentArtifactReadAuthorityIndex(o.artifactAuthorityTable),
            sessionOwnership,
            limits: {
              maxArtifactBytes: Math.max(
                100 * 1024 * 1024,
                o.profile.computerUse?.capture.maxBytesPerImage ?? 0,
              ),
              maxResponseBytes: Math.max(
                1024 * 1024,
                o.profile.computerUse?.capture.maxBytesPerImage ?? 4 * 1024 * 1024,
              ),
            },
            operationTimeoutMs: 10_000,
            scopeTimeoutMs: 5_000,
            readTimeoutMs: 15_000,
          })
        : undefined
  const artifactRead =
    projectedArtifactRead?.rpc ??
    (o.ports?.artifactRead !== undefined
      ? o.ports.artifactRead
      : o.artifactReadAuthority
        ? composeProductionArtifactRead(o.config.dataDir, o.artifactReadAuthority)
        : undefined)
  const reclaimStore = o.reclaim
  tickets?.gc(clock())

  return {
    conns,
    jobTables,
    tickets,
    workspaces,
    sessionOwnership,
    workspaceCatalog,
    resourceControlDirectory,
    resourceWorkerRoot,
    resourceWorkerWorkspaceId,
    bindResourceWorkspace,
    localResourceStore,
    resourceControl,
    packageSkillSnapshotPath,
    resourceSkillLkgDirectory,
    activationBarrier,
    notices,
    inflightConn,
    journal,
    claims,
    nonces,
    persistentClaims,
    configuredSourceCredentials,
    configuredSourceSecrets,
    sourceRotation,
    ephemeralSourceKeyId,
    runtimeSourceCredentials,
    effectiveRemoteAuth,
    projectedArtifactRead,
    artifactRead,
    reclaimStore,
  }
}

export type StoresState = Awaited<ReturnType<typeof openStores>>
