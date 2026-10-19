import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { type ConfigurationService, createConfigurationService } from '@agnes/host'
import {
  type InstalledPackage,
  lockPath,
  type PackageManager,
  readApplicationAssets,
  withLock,
} from '@agnes/package-manager'
import type { ApplicationRoleTarget, PackageAdminMethodName, PresentationRole } from '@agnes/protocol'
import {
  type ApplicationConfigSnapshot,
  type ApplicationPreview,
  type ApplicationState,
  jcs,
  rpcError,
  validatePackageAdminData,
} from '@agnes/protocol'
import { applicationDependencies } from './application-dependencies.js'
import type { PackageActivationAdapter } from './handler.js'
import type { PackageAdminAuthority } from './permissions.js'
import type { PackageProfileDirectory } from './project.js'
import { previewRole, roleDigest, roleStates } from './role-selection.js'

const digest = (value: unknown) => createHash('sha256').update(jcs(value)).digest('hex')
const fail = (reason: string): never => {
  throw rpcError('SEMANTIC_REJECTED', { reason })
}
const bindingDigest = (preview: ApplicationPreview) => {
  const { consentDigest: _consent, dependencyDiff: _diff, ...identity } = preview
  return digest(identity)
}
const eligible = (p: InstalledPackage) => p.enabled && p.trusted && !p.blockers.length && !!p.directory
const packageBoundary = (directory: string) =>
  readFile(lockPath(directory), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })

/** Presentation has a separate configuration lane; no profile resolver, tree publication or pins. */
export class Applications {
  constructor(
    private readonly options: {
      manager: Pick<PackageManager, 'inventory'>
      profileDirectory: PackageProfileDirectory
      home?: string
      configuration?(profile: string, directory: string): ConfigurationService
      active?(profile: string, packageId: string, integrity: string): Promise<boolean>
    },
  ) {}

  private async context(profile: string) {
    const directory = await this.options.profileDirectory(profile)
    const config =
      this.options.configuration?.(profile, directory) ??
      createConfigurationService({
        home: this.options.home ?? dirname(dirname(directory)),
        profile,
        profileDir: directory,
      })
    if (!config.application || !config.saveApplication) return fail('APPLICATION_CONFIG_UNAVAILABLE')
    return {
      directory,
      config: config as ConfigurationService &
        Required<Pick<ConfigurationService, 'application' | 'saveApplication'>>,
    }
  }

  private async reviewed(
    profile: string,
    packageId: string,
    packages: readonly InstalledPackage[],
    previous: ApplicationConfigSnapshot['selection'],
  ) {
    const row = packages.find((p) => p.id === packageId)
    if (!row?.entry.application || !eligible(row) || !row.directory) return fail('APPLICATION_UNAVAILABLE')
    const declaration = structuredClone(row.entry.application)
    const assets = await readApplicationAssets(row.directory, declaration)
    const requiredPackage = (id: string) => {
      const pkg = packages.find((p) => p.id === id)
      if (!pkg) return fail('APPLICATION_DEPENDENCY_MISSING')
      return pkg
    }
    const required = new Set<string>([row.id])
    const visit = async (id: string): Promise<void> => {
      const p = packages.find((p) => p.id === id)
      if (!p) return fail('APPLICATION_DEPENDENCY_MISSING')
      for (const id of await applicationDependencies(p, packages))
        if (!required.has(id)) {
          required.add(id)
          await visit(id)
        }
    }
    await visit(row.id)
    for (const id of required) {
      const p = requiredPackage(id)
      if (!eligible(p)) return fail('APPLICATION_DEPENDENCY_UNAVAILABLE')
    }
    const owner = (ref: string) => {
      const id = ref.slice(0, ref.indexOf('#'))
      const p = packages.find((p) => p.id === id)
      if (!p || !required.has(id)) return fail('APPLICATION_REFERENCE_UNKNOWN')
      return p
    }
    for (const ref of [
      ...(declaration.agents ?? []),
      ...(declaration.defaultAgent ? [declaration.defaultAgent] : []),
    ])
      if (!owner(ref).entry.agents?.some((a) => a.ref === ref)) return fail('APPLICATION_AGENT_UNKNOWN')
    for (const ref of [
      ...(declaration.presentation?.navigation?.entries ?? []),
      ...(declaration.presentation?.home ? [declaration.presentation.home] : []),
    ]) {
      const page = ref.slice(ref.indexOf('#') + 1)
      if (
        !owner(ref).contributions.some(
          (c) =>
            'client' in c &&
            c.client?.lifetime === 'profile' &&
            (c.client.examplePages?.includes(page) || c.client.homeEntries?.some((p) => p.id === page)),
        )
      )
        return fail('APPLICATION_PAGE_UNKNOWN')
    }
    if (
      declaration.presentation?.skin &&
      !row.contributions.some(
        (c) => 'skins' in c && c.skins?.some((s) => s.id === declaration.presentation?.skin),
      )
    )
      return fail('APPLICATION_SKIN_UNKNOWN')
    const replacedRoles = await Promise.all(
      Object.entries(declaration.presentation?.roles ?? {}).map(async ([role, target]) => {
        const p = packages.find((p) => p.id === target.packageId)
        const c = p?.contributions.find(
          (c) =>
            'client' in c &&
            c.client?.lifetime === 'profile' &&
            (c.client.id ?? c.id) === target.clientId &&
            c.client.presentationRoles?.some((r) => r === role),
        )
        if (!p || !required.has(p.id) || !c || !('client' in c) || !c.client)
          return fail('APPLICATION_ROLE_UNDECLARED')
        if (!this.options.active || !(await this.options.active(profile, p.id, p.entry.integrity)))
          return fail('APPLICATION_ROLE_UNAVAILABLE')
        return {
          role,
          ...target,
          integrity: p.entry.integrity,
          source: p.entry.source,
          entry: c.client.entry,
        }
      }),
    )
    const dependencies = [...required].sort().map((id) => {
      const p = requiredPackage(id)
      return {
        packageId: id,
        version: p.entry.version,
        integrity: p.entry.integrity,
        capabilityHash: p.capabilityHash,
        capabilities: p.entry.declaredCapabilities ?? [],
        source: p.entry.source,
      }
    })
    const snapshot = previous?.consentSnapshot
    const { consentDigest: _previousDigest, ...previousBody } = snapshot ?? {}
    const restored =
      snapshot &&
      snapshot.packageId === previous?.packageId &&
      snapshot.integrity === previous.integrity &&
      snapshot.declarationDigest === previous.declarationDigest &&
      snapshot.consentDigest === previous.consentDigest &&
      digest(previousBody) === previous.consentDigest
    const ids = (rows: ApplicationPreview['dependencies'], owner: string) =>
      rows.flatMap((value) =>
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        typeof value.packageId === 'string' &&
        value.packageId !== owner
          ? [value.packageId]
          : [],
      )
    const before = restored ? ids(snapshot.dependencies, snapshot.packageId) : []
    const after = ids(dependencies, row.id)
    const dependencyDiff =
      previous && !restored
        ? { status: 'unknown', reason: 'previous-consent-unavailable' }
        : {
            status: 'known',
            added: after.filter((id) => !before.includes(id)),
            removed: before.filter((id) => !after.includes(id)),
          }
    const checkedSource = validatePackageAdminData('PackageSource', row.entry.source)
    if (!checkedSource.ok) return fail('APPLICATION_SOURCE_INVALID')
    const source = checkedSource.value as ApplicationPreview['source']
    const previewed = {
      packageId: row.id,
      version: row.entry.version,
      integrity: row.entry.integrity,
      source,
      assets,
      signature: row.entry.provenance?.verification ?? 'unverified',
      declaration,
      declarationDigest: digest(declaration),
      dependencies,
      replacedRoles,
      dependencyDiff,
      scope: 'presentation-defaults-and-agent-catalogue',
      recovery: '/?admin; agh app clear',
      warning: 'trusted-javascript-is-not-a-sandbox',
    }
    return {
      preview: { ...previewed, consentDigest: digest(previewed) } satisfies ApplicationPreview,
      assets,
    }
  }

  async call(
    method: PackageAdminMethodName,
    data: Record<string, unknown>,
    authority: PackageAdminAuthority,
  ) {
    try {
      const profile = data.profile as string
      if (method === '_agnes/v1/applications.get') return await this.get(profile)
      if (method === '_agnes/v1/applications.preview') {
        if (data.role !== undefined || data.targetClientId !== undefined) {
          if (!data.role || !data.targetClientId) return fail('APPLICATION_ROLE_UNDECLARED')
          return await this.previewRole(profile, data.role as PresentationRole, {
            packageId: data.packageId as string,
            clientId: data.targetClientId as string,
          })
        }
        return await this.preview(profile, data.packageId as string)
      }
      if (data.clientId !== authority.clientId) throw rpcError('CAPABILITY_DENIED')
      if (method === '_agnes/v1/applications.clear')
        return await this.clear(
          profile,
          data.expectedRevision as number,
          data.role as PresentationRole | undefined,
        )
      if (data.role !== undefined || data.targetClientId !== undefined) {
        if (!data.role || !data.targetClientId) return fail('APPLICATION_ROLE_UNDECLARED')
        return await this.selectRole(
          profile,
          data.role as PresentationRole,
          { packageId: data.packageId as string, clientId: data.targetClientId as string },
          data.expectedRevision as number,
          data.consentDigest as string,
        )
      }
      return await this.adopt(
        profile,
        data.packageId as string,
        data.expectedRevision as number,
        data.consentDigest as string,
      )
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error) {
        if (typeof error.code === 'number') throw error
        if (
          [
            'CONFIG_REVISION_CONFLICT',
            'CONFIG_INVALID_INPUT',
            'CONFIG_INVALID_STATE',
            'CONFIG_PERSIST_FAILED',
          ].includes(String(error.code))
        )
          return fail(String(error.code))
      }
      return fail('APPLICATION_UNAVAILABLE')
    }
  }

  async get(profile: string): Promise<ApplicationState> {
    const { directory, config } = await this.context(profile)
    const saved = await config.application()
    // Clearing remains possible even when inventory cannot be read.
    let unavailable = false
    const packages = await this.options.manager
      .inventory(directory)
      .then((i) => i.packages)
      .catch(() => {
        unavailable = true
        return []
      })
    const candidates = packages.flatMap((p) =>
      p.entry.application
        ? [
            {
              packageId: p.id,
              applicationId: p.entry.application.id,
              version: p.entry.version,
              available: eligible(p),
            },
          ]
        : [],
    )
    const fallback: ApplicationState = {
      ...saved,
      status: saved.selection ? 'unresolved' : 'host',
      effective: null,
      assets: {},
      candidates,
    }
    const present = async (state: ApplicationState): Promise<ApplicationState> => ({
      ...state,
      roles: await roleStates(
        packages,
        profile,
        saved.roleSelections,
        state.effective,
        this.options.active,
        unavailable,
      ),
    })
    if (!saved.selection) return present(fallback)
    const row = packages.find((p) => p.id === saved.selection?.packageId)
    const reason = unavailable
      ? 'inventory-unavailable'
      : !row
        ? 'removed'
        : !row.trusted
          ? 'untrusted'
          : !row.enabled
            ? 'disabled'
            : row.entry.integrity !== saved.selection.integrity
              ? 'package-changed'
              : !row.entry.application ||
                  row.entry.application.id !== saved.selection.applicationId ||
                  digest(row.entry.application) !== saved.selection.declarationDigest
                ? 'declaration-changed'
                : undefined
    if (reason) return present({ ...fallback, reason })
    try {
      const current = await this.reviewed(profile, saved.selection.packageId, packages, saved.selection)
      if (bindingDigest(current.preview) !== saved.selection.bindingDigest)
        return present({ ...fallback, reason: 'dependencies-changed' })
      return present({
        ...fallback,
        status: 'active',
        effective: current.preview.declaration,
        assets: current.assets,
      })
    } catch {
      return present({ ...fallback, reason: 'assets-or-references-unavailable' })
    }
  }

  async preview(profile: string, packageId: string): Promise<ApplicationPreview> {
    const { directory, config } = await this.context(profile)
    const saved = await config.application()
    const { packages } = await this.options.manager.inventory(directory)
    return (await this.reviewed(profile, packageId, packages, saved.selection)).preview
  }

  async adopt(profile: string, packageId: string, expectedRevision: number, consentDigest: string) {
    const { directory, config } = await this.context(profile)
    // Inventory owns the package lock itself. Verify outside it, then bind that evidence to
    // unchanged package state under the write lock before committing the configuration CAS.
    const boundary = await packageBoundary(directory)
    const { packages } = await this.options.manager.inventory(directory, { fresh: true })
    await withLock(directory, async () => {
      if ((await packageBoundary(directory)) !== boundary) return fail('APPLICATION_PREVIEW_STALE')
      const saved = await config.application()
      if (saved.revision !== expectedRevision) return fail('CONFIG_REVISION_CONFLICT')
      const { preview } = await this.reviewed(profile, packageId, packages, saved.selection)
      if (preview.consentDigest !== consentDigest) return fail('APPLICATION_PREVIEW_STALE')
      await config.saveApplication({
        revision: expectedRevision,
        selection: {
          packageId,
          applicationId: preview.declaration.id,
          integrity: preview.integrity,
          declarationDigest: preview.declarationDigest,
          consentDigest: preview.consentDigest,
          bindingDigest: bindingDigest(preview),
          consentSnapshot: preview,
        },
      })
    })
    return this.get(profile)
  }

  async previewRole(profile: string, role: PresentationRole, target: ApplicationRoleTarget) {
    const { directory } = await this.context(profile)
    const { packages } = await this.options.manager.inventory(directory)
    return previewRole(packages, profile, role, target, this.options.active)
  }

  async selectRole(
    profile: string,
    role: PresentationRole,
    target: ApplicationRoleTarget,
    expectedRevision: number,
    consentDigest: string,
  ) {
    const { directory, config } = await this.context(profile)
    const boundary = await packageBoundary(directory)
    const { packages } = await this.options.manager.inventory(directory, { fresh: true })
    await withLock(directory, async () => {
      if ((await packageBoundary(directory)) !== boundary) return fail('APPLICATION_PREVIEW_STALE')
      const saved = await config.application()
      if (saved.revision !== expectedRevision) return fail('CONFIG_REVISION_CONFLICT')
      const preview = await previewRole(packages, profile, role, target, this.options.active)
      if (preview.consentDigest !== consentDigest) return fail('APPLICATION_PREVIEW_STALE')
      await config.saveApplication({
        ...saved,
        roleSelections: {
          ...saved.roleSelections,
          [role]: {
            ...target,
            integrity: preview.integrity,
            declarationDigest: preview.declarationDigest,
            consentDigest,
            bindingDigest: roleDigest(preview),
            consentSnapshot: preview,
          },
        },
      })
    })
    return this.get(profile)
  }

  async clear(profile: string, expectedRevision: number, role?: PresentationRole) {
    const { config } = await this.context(profile)
    const saved = await config.application()
    const roleSelections = { ...saved.roleSelections }
    if (role) delete roleSelections[role]
    await config.saveApplication({
      revision: expectedRevision,
      selection: role ? saved.selection : null,
      roleSelections: role ? roleSelections : {},
    })
    return this.get(profile)
  }
}

export function createApplications(options: {
  manager: PackageManager
  profileDirectory: PackageProfileDirectory
  authoringHome?: string
  activation?: PackageActivationAdapter
}) {
  const activation = options.activation
  return new Applications({
    manager: options.manager,
    profileDirectory: options.profileDirectory,
    ...(options.authoringHome ? { home: options.authoringHome } : {}),
    ...(activation
      ? {
          active: async (profile: string, id: string, integrity: string) => {
            const actual = await activation.actual(profile, id)
            return (
              typeof actual === 'object' &&
              actual.actual === 'running' &&
              actual.actualIntegrity === integrity
            )
          },
        }
      : {}),
  })
}
