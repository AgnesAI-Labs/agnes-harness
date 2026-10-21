import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { initializeDefaultHelpers } from '@agnes/daemon-admin/packages/default-helpers'
import {
  createPackageReferences,
  FilePackageOperationStore,
  type PackageReferenceFactReader,
  scopedPackageProfileDirectory,
} from '@agnes/daemon-admin/packages/index'
import { discoverLocalExamples } from '@agnes/daemon-admin/packages/local-examples'
import { pluginProposalSourceAdapter } from '@agnes/daemon-admin/packages/plugin-source'
import type { createPlatform, ResolvedProfile } from '@agnes/host'
import { createPackageManager, localPluginRoots, PackageError, snapshotPolicy } from '@agnes/package-manager'
import { hasPrivateDaclSync } from '@agnes/system-node'
import { assemblyPort } from './assembly-lifetime.js'
import type { BootVerification } from './boot-verification.js'
import { embeddedPackageAdmin } from './embedded-package-admin.js'
import type { RunAgnesdDeps } from './runtime.js'
import type { resolveDaemonScope } from './scope.js'
import { PACKAGE_MANAGER_VERSION } from './workspace-deployments.js'

type Scope = Awaited<ReturnType<typeof resolveDaemonScope>>
type Platform = ReturnType<ReturnType<typeof createPlatform>['snapshot']>
export async function preparePackageRuntime(
  scope: Scope,
  profile: ResolvedProfile,
  platform: Platform,
  bootVerification: BootVerification,
  deps: RunAgnesdDeps,
) {
  // PackageManager is the only lockfile writer. Establish the scoped directory first, then stamp
  // the already-resolved Host profile through its public bootstrap API. A damaged existing lock is
  // deliberately left in place: PackageAdmin reads expose its safe failure and the BFF enters
  // recovery/read-only mode instead of daemon startup replacing forensic state with a new lock.
  const packageProfileDirectory = scopedPackageProfileDirectory({
    profile: scope.profile,
    profileDir: scope.profileDir,
    profilesRoot: join(scope.home, 'profiles'),
  })
  const checkedProfileDir = await packageProfileDirectory(scope.profile)
  if (platform.os === 'win32') {
    for (const directory of [scope.home, scope.dataDir, join(scope.home, 'profiles'), checkedProfileDir])
      if (!hasPrivateDaclSync(directory))
        throw Object.assign(new Error('E_HOME_UNSAFE'), { code: 'E_HOME_UNSAFE' })
  } else await mkdir(checkedProfileDir, { recursive: true, mode: 0o700 })
  const profileDir = await packageProfileDirectory(scope.profile)
  const references = assemblyPort<PackageReferenceFactReader>()
  const packageManager = createPackageManager({
    dataDir: scope.dataDir,
    agnesVersion: PACKAGE_MANAGER_VERSION,
    cwd: scope.workspace,
    localPlugins: localPluginRoots(scope.home, scope.workspace),
    sourceAdapters: [pluginProposalSourceAdapter(join(scope.dataDir, 'resource-control'))],
    references: createPackageReferences((input) => {
      return references.read()(input)
    }),
  })
  try {
    const initializePolicy = () => snapshotPolicy(profileDir, profile, '0.0.0')
    const bootDefaultHelpers = bootVerification.bind(initializeDefaultHelpers)
    if (deps.packageAdmin) await initializePolicy()
    else await bootDefaultHelpers({ profileDir, manager: packageManager, initializePolicy })
  } catch (error) {
    // Helper inventory can encounter the same damaged lock before policy initialization.
    // Keep the recovery-only admin surface available; never replace or trust the damaged state.
    if (!(error instanceof PackageError) || error.legacyCode !== 'E_LOCK_MISMATCH') throw error
  }
  const packageOperations = new FilePackageOperationStore(join(scope.daemonDir, 'package-operations'))
  const localExamplesCatalog = await discoverLocalExamples(scope.workspace)
  // An explicitly injected resource service owns its own durable recovery; the default store
  // is recovered only after its service-worker adapters are installed in startSupervisor.
  const resourceService = deps.resources?.service
  if (resourceService) await resourceService.recover()

  const embedded =
    deps.startProduction && !deps.packageAdmin
      ? embeddedPackageAdmin({
          manager: packageManager,
          profileDirectory: packageProfileDirectory,
          operations: packageOperations,
          authoringHome: scope.home,
          ...(localExamplesCatalog ? { catalog: localExamplesCatalog } : {}),
        })
      : undefined
  return {
    packageAdmin: deps.packageAdmin ?? (embedded ? { service: embedded.service } : undefined),
    packageRuntime: {
      manager: packageManager,
      profileDirectory: packageProfileDirectory,
      operations: packageOperations,
      stateDirectory: join(scope.daemonDir, 'package-activation'),
      clientModulesDirectory: join(scope.daemonDir, 'client-modules'),
      ...(localExamplesCatalog ? { catalog: localExamplesCatalog } : {}),
      references,
      ...(embedded ? { bindRuntimePins: embedded.bindRuntimePins, embeddedAdmin: embedded } : {}),
    },
  }
}
