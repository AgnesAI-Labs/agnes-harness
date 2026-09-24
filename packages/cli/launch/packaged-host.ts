import { dirname, join } from 'node:path'
import {
  createHost,
  createJitiPackageLoader,
  createLoader,
  HostError,
  type HostOptions,
  type PackageLoader,
  type PackageModule,
  type Prompter,
  packageDir,
  type ResolvedProfile,
  readLock,
  readNamedExports,
  verifyLockIntegrity,
} from '@agnes/host'
import type { AgnesPluginManifestEntry } from '@agnes/package-manager'

declare const AGNES_BASE_EXTENSION_MANIFESTS: NonNullable<PackageModule['embeddedExtensions']> | undefined
declare const AGNES_CODE_EXTENSION_MANIFESTS: NonNullable<PackageModule['embeddedExtensions']> | undefined

/**
 * SEA workers cannot read workspace package.json files at runtime. Keep the normalized form of
 * @agnes/base's package.json#agnes.plugins declaration beside the packaged importer instead.
 */
export const AGNES_BASE_PLUGIN_DECLARATIONS = Object.freeze(
  (
    [
      { export: 'approvalPlugin', id: 'seam:approval', runtime: 'in-process', default: true },
      { export: 'principalsPlugin', id: 'seam:principals', runtime: 'in-process', default: true },
      { export: 'artifactsPlugin', id: 'seam:artifacts', runtime: 'in-process', default: true },
      { export: 'checkpointPlugin', id: 'seam:checkpoint', runtime: 'in-process', default: true },
      { export: 'ledgerPlugin', id: 'seam:ledger', runtime: 'in-process', default: true },
      { export: 'verifierPlugin', id: 'seam:verifier', runtime: 'in-process', default: true },
      { export: 'repairPlugin', id: 'seam:repair', runtime: 'in-process', default: true },
      { export: 'harnessPlugin', id: 'seam:harness', runtime: 'in-process', default: true },
    ] satisfies readonly Readonly<AgnesPluginManifestEntry>[]
  ).map((entry) => Object.freeze(entry)),
)

export function readPackagedBuiltinExports(
  id: string,
  entryFile: string,
  module: Record<string, unknown>,
): PackageModule {
  return readNamedExports(
    id,
    entryFile,
    module,
    id === '@agnes/base' ? AGNES_BASE_PLUGIN_DECLARATIONS : undefined,
  )
}

/** Builtin modules are compiled into the executable; external packages retain lock/integrity checks. */
export function packagedPackages(profile: ResolvedProfile, home: string, entryFile: string) {
  const profileDir = join(home, 'profiles', profile.name)
  const hostRoot = dirname(entryFile)
  const lock = readLock(profileDir, { profile: profile.name, agnesVersion: '0.0.0' })
  verifyLockIntegrity(lock, { dataDir: profile.dataDir, profile: profile.name })
  const jiti = createLoader({ cacheDir: profile.cacheDir, hostRoot, agnesVersion: '0.0.0' })
  const external = createJitiPackageLoader(jiti)
  const builtin = async (id: string): Promise<Record<string, unknown>> => {
    if (id === '@agnes/ai') return import('@agnes/ai')
    if (id === '@agnes/base') return import('@agnes/base')
    if (id === '@agnes/code') return import('@agnes/code')
    throw new HostError('E_DEP_MISSING', 'unknown builtin package')
  }
  const isBuiltin = (id: string) => ['@agnes/ai', '@agnes/base', '@agnes/code'].includes(id)
  const loader: PackageLoader = {
    async importPackage(id, dir) {
      if (!isBuiltin(id)) return external.importPackage(id, dir)
      const { extensionEntry: _fileEntry, ...module } = readPackagedBuiltinExports(
        id,
        entryFile,
        await builtin(id),
      )
      const manifests =
        id === '@agnes/base'
          ? typeof AGNES_BASE_EXTENSION_MANIFESTS === 'undefined'
            ? undefined
            : AGNES_BASE_EXTENSION_MANIFESTS
          : id === '@agnes/code'
            ? typeof AGNES_CODE_EXTENSION_MANIFESTS === 'undefined'
              ? undefined
              : AGNES_CODE_EXTENSION_MANIFESTS
            : undefined
      if (id !== '@agnes/ai' && !manifests)
        throw new HostError(
          'E_DEP_MISSING',
          'packaged extension manifests are missing; rebuild the local distribution',
        )
      return manifests ? { ...module, embeddedExtensions: manifests } : module
    },
  }
  return {
    loader,
    extensionLoader: jiti,
    packageDirs: new Map<string, string>(
      profile.packages
        .filter((pkg) => pkg.enabled)
        .map((pkg) => [
          pkg.id,
          isBuiltin(pkg.id) ? hostRoot : packageDir(profile.dataDir, profile.name, pkg.id),
        ]),
    ),
  }
}

export function createPackagedHost(
  profile: ResolvedProfile,
  prompter: Prompter,
  options: {
    home: string
    cwd: string
    entryFile: string
  } & Pick<
    HostOptions,
    | 'skillResources'
    | 'skillInstall'
    | 'runtimePluginSnapshots'
    | 'runtimePluginSources'
    | 'managedExtensionPackageIds'
    | 'serviceAuthority'
  >,
) {
  const { home, cwd, entryFile, ...resources } = options
  return createHost(profile, {
    dataDir: profile.dataDir,
    profileDir: join(home, 'profiles', profile.name),
    workspaceRoot: cwd,
    hostRoot: dirname(entryFile),
    agnesVersion: '0.0.0',
    prompter,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    ...packagedPackages(profile, home, entryFile),
    ...resources,
  })
}
