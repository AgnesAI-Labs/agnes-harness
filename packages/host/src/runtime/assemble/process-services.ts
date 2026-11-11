import { dirname } from 'node:path'
import { hasChildControl, recoverCreatingChildAttempts } from '@agnes/core'
import { ownHomes, ownStateRoots, privateStateRoots } from '@agnes/host-common/paths'
import {
  createHostLockedPackageMutationRuntime,
  type HostLockedPackageMutationRuntime,
} from '@agnes/host-computer-use/computer-use/locked-package-mutation-runtime'
import { ProfileActivations } from '@agnes/host-extensions/profile/activation'
import { ProfileManagedResources } from '@agnes/host-extensions/profile/managed'
import { ProfileStreams } from '@agnes/host-extensions/profile/streams'
import { ProfileWakeBindings } from '@agnes/host-extensions/profile/wakes'
import { createPlatform } from '@agnes/host-infrastructure/adapters/platform'
import { createSessionGitWorktreeService } from '@agnes/host-infrastructure/git-worktrees'
import type { WindowsAclExecution } from '@agnes/host-infrastructure/windows-acl/execution'
import { createWindowsAclExecution } from '@agnes/host-infrastructure/windows-acl/host-platform'
import type { SandboxProviderSlot } from '@agnes/host-providers/adapters/sandbox-providers'
import { RELEASE_DEFAULTS } from '@agnes/package-manager'
import { type AdapterBundle, openAdapters } from '../adapters/index.js'
import type { AssemblyContext } from './context.js'
import type { PackageSet } from './packages.js'

/**
 * Process scope: what is opened against the host's own storage, platform and secrets, and is
 * therefore the same for every generation of one deployment (generation compatibility pins the
 * adapter configuration). A generation container still opens its own today, because the sandbox
 * dispatch slot below is filled from that container's plugin tree; see the HOSTX report.
 */
export type ProcessServices = Readonly<{
  profileManaged: ProfileManagedResources
  profileStreams: ProfileStreams
  profileWakes: ProfileWakeBindings
  profileActivations: ProfileActivations
  adapters: AdapterBundle
  /** The sandbox provider registry of the tree that is current, filled in by the runtime-target stage. */
  sandboxProviderSlot: SandboxProviderSlot
  /** Set once the Skill generation exists; the fs fence asks through it on every read. */
  skillReadRoots: { current: (sessionKey?: string) => readonly string[] }
  gitWorktrees: ReturnType<typeof createSessionGitWorktreeService>
  lockedPackageMutations: HostLockedPackageMutationRuntime
  secrets(ref: string): string
  /** The OS this process runs on, which a remote adapter's platform may differ from. */
  nativePlatform: ReturnType<typeof createPlatform>['os']
  /** Trusted Windows write-restriction facade; only a local Windows Host with the Job runner has one. */
  windowsAcl?: WindowsAclExecution
}>

/**
 * The Windows execution authority of a local Windows Host that runs commands under owned Jobs.
 * Without it, a Windows policy that opted into the partial contract is refused, never run raw.
 */
async function openWindowsAcl(
  ctx: AssemblyContext,
  adapters: AdapterBundle,
): Promise<WindowsAclExecution | undefined> {
  const localAppData = ctx.env.LOCALAPPDATA
  if (
    adapters.platform.os !== 'win32' ||
    adapters.transport ||
    !adapters.windowsNodeExecutable ||
    !localAppData
  )
    return undefined
  return createWindowsAclExecution({
    localAppData,
    privateRoots: privateStateRoots({
      home: dirname(dirname(ctx.deps.profileDir)),
      dataDir: ctx.dataDir,
      profileDir: ctx.deps.profileDir,
      ...(ctx.profile.adapters?.secrets.path ? { secretsDir: ctx.profile.adapters.secrets.path } : {}),
    }),
    localProviderId: RELEASE_DEFAULTS.sandboxProvider,
    pid: process.pid,
    nodeExecutable: adapters.windowsNodeExecutable,
  })
}

/**
 * Step `adapters` - the fs fence opens on the bootstrap policy (workspace allow plus the
 * host-integrity hard denies), which is what trusted seam factories run against. The sandbox
 * seam's full policy replaces it after step 5, in one binding, before anything else is built.
 */
export async function openProcessServices(ctx: AssemblyContext, pkgs: PackageSet): Promise<ProcessServices> {
  const { deps, dataDir, workspaceRoot, rollback, clock, workspaceInvocationFor } = ctx
  const { modules } = pkgs
  const backend = deps.platform ? { platform: deps.platform } : {}
  const sandboxProviderSlot: SandboxProviderSlot = {}
  const skillReadRoots = { current: (_sessionKey?: string): readonly string[] => [] }
  const adapters = await openAdapters(ctx.profile, {
    dataDir,
    skillReadRoots: (sessionKey) => skillReadRoots.current(sessionKey),
    fullAccessReadOnlyRoots: () =>
      ownStateRoots({
        profileDir: deps.profileDir,
        dataDir,
        secretsDir: ctx.profile.adapters.secrets.path,
      }),
    configHomes: () => ownHomes({ profileDir: deps.profileDir, dataDir }),
    modules,
    signal: ctx.abort.signal,
    workspaceRoot,
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.windowsNodeExecutable !== undefined
      ? { windowsNodeExecutable: deps.windowsNodeExecutable }
      : {}),
    sandboxDispatch: sandboxProviderSlot,
    ...backend,
  })
  let windowsAcl: WindowsAclExecution | undefined
  rollback.push('adapters', async () => {
    try {
      await adapters.close()
    } finally {
      // The Windows leases close only once the processes they launched are gone, which closing the
      // adapters ensures; the runtimes released theirs already when the workspace table closed.
      await windowsAcl?.dispose()
    }
  })
  const gitWorktrees = createSessionGitWorktreeService({
    workspaceInvocationFor,
    dataDir,
    remote: adapters.transport !== undefined,
    signal: ctx.abort.signal,
  })
  if (hasChildControl(adapters.storage)) {
    const now = clock()
    await recoverCreatingChildAttempts(adapters.storage, { staleBefore: now, now })
  }
  const lockedPackageMutations = await createHostLockedPackageMutationRuntime(
    adapters.storage,
    deps.lockedPackageMutations,
  )
  rollback.push('computer-use-locked-package-mutations', () => lockedPackageMutations.close())
  const secrets = (ref: string): string => adapters.secrets.resolve(ref)
  const nativePlatform = createPlatform().os
  windowsAcl = await openWindowsAcl(ctx, adapters)
  const profileActivations = new ProfileActivations(
    adapters.storage.metadata.namespace('@agnes/host', `activation:${ctx.profile.name}`),
  )
  const profileManaged = new ProfileManagedResources(
    `${dataDir}/profile:${ctx.profile.name}`,
    deps.boundWakes ??
      (() => ({
        async enqueue() {
          throw new Error('Bound wakes unavailable')
        },
        async read() {
          throw new Error('Bound wakes unavailable')
        },
      })),
    (owner, integrity, revision) => {
      try {
        return profileActivations.require(owner, integrity, undefined, revision)
      } catch {
        return false
      }
    },
    undefined,
    deps.managedSessions,
  )
  rollback.push('profile-managed', () => profileManaged.close())
  return {
    profileManaged,
    profileStreams: new ProfileStreams(ctx.profile.name, profileActivations),
    profileActivations,
    profileWakes: new ProfileWakeBindings(
      adapters.storage.metadata.namespace('@agnes/host', `wake:${ctx.profile.name}`),
      profileActivations,
    ),
    adapters,
    sandboxProviderSlot,
    skillReadRoots,
    gitWorktrees,
    lockedPackageMutations,
    secrets,
    nativePlatform,
    ...(windowsAcl ? { windowsAcl } : {}),
  }
}
