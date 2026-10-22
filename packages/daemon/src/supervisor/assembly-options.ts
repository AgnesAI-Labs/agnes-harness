import type {
  PackageAdminAuthorityResolver,
  PackageAdminService,
  PackageOperationStore,
  PackageProfileDirectory,
  PackageReferenceFactReader,
  RuntimePinsAdapter,
} from '@agnes/daemon-admin/packages/index'
import type { ResourceAuthorityResolver, ResourceControlService } from '@agnes/daemon-admin/resources/index'
import type { ReclaimStore } from '@agnes/daemon-foundation/lease/reclaim'
import type {
  ClaimStore,
  CommandJournal,
  DirectoryPort,
  JobsPort,
  SessionLister,
} from '@agnes/daemon-foundation/local/ports'
import type { SourceAuthCredential } from '@agnes/daemon-foundation/storage/source-auth-rotation'
import type { TableHandle, Tables } from '@agnes/daemon-foundation/storage/table'
import type { AuthConfig } from '@agnes/daemon-rpc/local/auth'
import type { LockedPackageMutationStatusSource } from '@agnes/daemon-rpc/local/computer-use-control'
import type { AgnesContext } from '@agnes/daemon-rpc/local/methods/agnes'
import type { ArtifactReadRpcOptions } from '@agnes/daemon-rpc/local/methods/artifacts'
import type {
  ConfigurationService,
  ExtensionActivationBarrier,
  ProcessIdentity,
  ResolvedProfile,
  resolveComposition,
  ScanRead,
} from '@agnes/host'
import type { LocalExamplesCatalog, PackageManager } from '@agnes/package-manager'
import type {
  ProductionArtifactAuthorityProjection,
  ProductionArtifactReadAuthority,
} from './artifact-read.js'
import type { assemblyPort } from './assembly-lifetime.js'
import type { BootVerification } from './boot-verification.js'
import type { DaemonConfig } from './config.js'
import type { embeddedPackageAdmin } from './embedded-package-admin.js'
import type { JwksResolver, JwksTransport } from './jwks-cache.js'
import type { acquireOwnerLock } from './owner-lock.js'
import type { SessionViewRead } from './session-reads.js'

export type StartSupervisorOptions = {
  config: DaemonConfig
  profile: ResolvedProfile
  /** `join(home, 'profiles', profile.name)`. Not derivable from `profile.dataDir`: a profile's
   * home and its dataDir are configured independently and are not the same directory in general. */
  profileDir: string
  /** Existing ledger adapter's read port; reads never acquire a worker or writer claim. */
  sessionFactRead?: (sessionId: string) => ScanRead<import('@agnes/protocol').EventEnvelope>
  /** Recorded views from the ledger; without it session.view waits for a worker. */
  sessionViewRead?: SessionViewRead
  profileFile: string
  /** One daemon scope owns one canonical workspace skill root. Session cwd may vary, but profile
   * resource control never silently scans the daemon process cwd. */
  workspaceRoot?: string
  /** Optional local configuration authority; activation updates only future worker defaults. */
  configuration?: ConfigurationService
  reloadProfile?: (adminBundles?: readonly string[]) => Promise<ResolvedProfile>
  inspectProfile?: (adminBundles?: readonly string[]) => Promise<ResolvedProfile>
  clock?: () => number
  workerExecPath?: string
  workerExecArgv?: string[]
  workerEntry?: string
  processIdentity?: (pid: number) => Promise<ProcessIdentity>
  /** Narrow production access to expired core claims and the op.state cell used for recovery. */
  reclaim?: ReclaimStore
  /** Package-owned tables. Production supplies Host's isolated `@agnes/daemon` table store here. */
  jobTables?: Pick<Tables, 'table'>
  /** Dedicated-schema capability for the fail-closed artifact authority index. */
  artifactAuthorityTable?: TableHandle
  /** Resolved remote credentials. Secret references are resolved only by the executable composition
   * root and never stored in the profile snapshot written for workers. */
  remoteAuth?: Omit<AuthConfig, 'transport'> & {
    /** Stable non-secret ids (normally unresolved SecretRefs) paired with runtime-resolved values. */
    sourceAuthCredentials?: SourceAuthCredential[]
  }
  jwksResolver?: JwksResolver
  jwksTransport?: JwksTransport
  ports?: Partial<{
    journal: CommandJournal
    claims: ClaimStore
    jobs: JobsPort
    lister: SessionLister
    directory: DirectoryPort
    resolveActor: NonNullable<AgnesContext['resolveActor']>
    verifyApprovalSource?: AgnesContext['verifyApprovalSource']
    /** Server-owned authenticated scope resolver plus bounded content-addressed artifact reader. */
    artifactRead: ArtifactReadRpcOptions
  }>
  /**
   * Trusted production authorities used to fit the local content-addressed store. An explicit
   * `ports.artifactRead` remains the higher-priority test/custom composition. Production storage
   * supplies the durable default when every explicit form is omitted.
   */
  artifactReadAuthority?: ProductionArtifactReadAuthority
  /** Complete durable writer/owner/read composition. Mutually exclusive with legacy/custom ports. */
  artifactAuthorityProjection?: ProductionArtifactAuthorityProjection
  /** Read-only Host mutation readiness; omission is the production fail-closed default. */
  lockedPackageMutations?: LockedPackageMutationStatusSource
  observability?: import('@agnes/observability').ObservabilityProvider
  audit?: (rec: unknown) => void
  /** Test/composition injection; production creates one global supervisor gate. */
  activationBarrier?: ExtensionActivationBarrier
  /** runAgnesd's boot read boundary; startup closes it before the client socket listens. */
  bootVerification?: BootVerification
  /** PackageAdmin is composed once and registered on every matching transport endpoint. */
  packageAdmin?: {
    service: PackageAdminService
    /** Explicit managed policy hook for remote WSS. Its absence is a hard deny. */
    webAuthority?: PackageAdminAuthorityResolver
    /** Defaults to the authenticated Unix owner authority. */
    unixAuthority?: PackageAdminAuthorityResolver
  }
  /** Durable Resource control composition. Missing Host adapters fail effects safely. */
  resources?: {
    service: ResourceControlService
    webAuthority?: ResourceAuthorityResolver
    unixAuthority?: ResourceAuthorityResolver
  }
  /** Default production package runtime. Tests may continue injecting a complete PackageAdmin. */
  packageRuntime?: {
    manager: PackageManager
    profileDirectory: PackageProfileDirectory
    operations: PackageOperationStore
    stateDirectory: string
    clientModulesDirectory?: string
    catalog?: LocalExamplesCatalog
    /** Embedded catalog-only starters can install their private pin adapter explicitly. */
    bindRuntimePins?(adapter: RuntimePinsAdapter): void
    embeddedAdmin?: Pick<ReturnType<typeof embeddedPackageAdmin>, 'initialize' | 'close'>
    references?: ReturnType<typeof assemblyPort<PackageReferenceFactReader>>
  }
}

export type AssemblyBase = {
  o: StartSupervisorOptions
  workerEntry: string
  composition: ReturnType<typeof resolveComposition>['selection'] | undefined
  clock: () => number
  ownerHome: string
  storageLocked: boolean
  lock: Awaited<ReturnType<typeof acquireOwnerLock>>
}
