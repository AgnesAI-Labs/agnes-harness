import * as P from '../gen/ts/package-admin.js'
import { adminPayloadBudget, checkAdminData as check, contract } from './admin-contract.js'
import type { ValidationResult } from './validate.js'

export { type PackageAdminDataName, validatePackageAdminData } from './package-admin-data.js'
export { validatePackageCatalogSnapshotVersion } from './package-catalog.js'

export const PACKAGE_DOCS_CONTEXT_HEADER = 'X-Agnes-Package-Docs'
export const PACKAGE_DOCS_FEATURE = 'packages.docs.v1'
export const PACKAGE_DOCS_MAX_BYTES = 65_536

/** Browser client-module slots currently backed by a real Web host outlet. */
export const WEB_CLIENT_MODULE_SLOT_NAMES = Object.freeze([
  'tool.card.inline',
  'client.card',
  'workbench.panel',
  'conversation.approval.detail',
  'conversation.chat.assistant-actions',
  'conversation.chat.node',
  'conversation.chat.commandview',
  'conversation.chat.turnTail',
  'conversation.composer.dock',
  'conversation.composer',
  'conversation.composer.bar',
  'conversation.hero.agentPreset',
  'conversation.hero.brand.mark',
  'conversation.hero.workspace',
  'conversation.hero.workspace.directoryFlow',
  'conversation.input.attachments',
  'conversation.input.dock',
  'conversation.input.left',
  'conversation.input.model',
  'conversation.input.model.catalog',
  'conversation.input.overlay',
  'conversation.input.permission',
  'conversation.input.plan',
  'conversation.input.right',
  'conversation.session',
  'conversation.session.header',
  'conversation.session.header.actions',
  'conversation.session.header.corner',
  'conversation.session.header.lineage',
  'conversation.session.header.utilities',
  'conversation.view',
  'conversation.message.images',
  'conversation.trajectory.images',
  'settings.action',
  'settings.close',
  'settings.general.item',
  'settings.header',
  'settings.models.footer',
  'settings.models.provider-card',
  'settings.onboarding',
  'settings.plugin.item',
  'settings.plugins.tab',
  'settings.section',
  'settings.trigger',
  'rightbar',
  'rightbar.session',
  'sidebar.right.pane.tab',
  'sidebar.right.pane.tab.title',
  'sidebar.right.tab.document',
  'sidebar.right.tab.guide',
  'sidebar.right.tab.guide.entry',
  'sidebar.right.tab.menu.item',
  'sidebar',
  'sidebar.brand.mark',
  'sidebar.brand.name',
  'sidebar.footer.action',
  'sidebar.panellist',
  'sidebar.settings',
  'sidebar.workspaces',
  'sidebar.workspaces.directoryFlow',
  'main',
  'main.conversation',
  'shell.overlay',
  'tool.call.toolview',
  'tool.call.images',
  'tool.view.cordis',
] as const)
export type WebClientModuleSlotName = (typeof WEB_CLIENT_MODULE_SLOT_NAMES)[number]

/** Version shared by daemon publication and the browser DSH slot facade. */
export const DSH_WEB_CLIENT_SLOT_CATALOG_VERSION = 'dsh-client-slots/v1' as const
const DSH_RUNTIME_SUPPORTED_SLOT_NAMES = new Set([
  'conversation.approval.detail',
  'conversation.chat.assistant-actions',
  'conversation.chat.node',
  'conversation.chat.commandview',
  'conversation.chat.turnTail',
  'conversation.composer.dock',
  'conversation.composer',
  'conversation.composer.bar',
  'conversation.hero.agentPreset',
  'conversation.hero.brand.mark',
  'conversation.hero.workspace',
  'conversation.hero.workspace.directoryFlow',
  'conversation.input.attachments',
  'conversation.input.dock',
  'conversation.input.left',
  'conversation.input.model',
  'conversation.input.model.catalog',
  'conversation.input.overlay',
  'conversation.input.permission',
  'conversation.input.plan',
  'conversation.input.right',
  'conversation.session',
  'conversation.session.header',
  'conversation.session.header.actions',
  'conversation.session.header.corner',
  'conversation.session.header.lineage',
  'conversation.session.header.utilities',
  'conversation.view',
  'conversation.message.images',
  'conversation.trajectory.images',
  'settings.action',
  'settings.close',
  'settings.general.item',
  'settings.header',
  'settings.models.footer',
  'settings.models.provider-card',
  'settings.onboarding',
  'settings.plugin.item',
  'settings.plugins.tab',
  'settings.section',
  'settings.trigger',
  'rightbar',
  'rightbar.session',
  'sidebar.right.pane.tab',
  'sidebar.right.pane.tab.title',
  'sidebar.right.tab.document',
  'sidebar.right.tab.guide',
  'sidebar.right.tab.guide.entry',
  'sidebar.right.tab.menu.item',
  'sidebar',
  'sidebar.brand.mark',
  'sidebar.brand.name',
  'sidebar.footer.action',
  'sidebar.panellist',
  'sidebar.settings',
  'sidebar.workspaces',
  'sidebar.workspaces.directoryFlow',
  'main',
  'main.conversation',
  'shell.overlay',
  'tool.call.toolview',
  'tool.call.images',
  'tool.view.cordis',
])

const WEB_HOST_REGION_SLOT_NAMES = new Set([
  'ui:empty-state',
  'ui:sidebar',
  'ui:transcript',
  'ui:conversation',
  'ui:topbar',
  'ui:approval',
  'ui:composer',
  'ui:trace',
  'ui:settings-pane',
  'ui:settings-pane.model',
  'ui:settings-pane.plugin',
  'ui:settings-pane.resources',
  'ui:settings-pane.archived',
  'ui:settings-pane.computer-use',
  'ui:settings-pane.appearance',
  'conversation.message.actions',
  'conversation.attachments',
  'conversation.tool-card',
  'conversation.feedback',
])

export function isWebClientModuleSlotName(value: string): boolean {
  return (
    (WEB_CLIENT_MODULE_SLOT_NAMES as readonly string[]).includes(value) ||
    WEB_HOST_REGION_SLOT_NAMES.has(value)
  )
}

export function isDshWebClientModuleSlotName(value: string): boolean {
  return DSH_RUNTIME_SUPPORTED_SLOT_NAMES.has(value)
}

function copyUiComponents(items: readonly P.UiComponentDeclaration[]): P.UiComponentDeclaration[] {
  return items.map((item) => ({
    kind: item.kind,
    propsSchema: structuredClone(item.propsSchema),
    maxPropsBytes: item.maxPropsBytes,
    fallback: item.fallback,
    accessibility: { label: item.accessibility.label, keyboard: item.accessibility.keyboard },
  }))
}

/**
 * Build the browser-safe row projection from the compatibility roster fields.
 *
 * `ClientModuleListResult.modules` and `.statuses` are retained for older callers, but neither
 * field is a browser authorization surface. This helper deliberately copies an allow-list of
 * identifiers, lifecycle state, and immutable asset routes; it never spreads a package row or
 * runtime artifact, so config/credential references cannot cross the SDK/daemon boundary.
 */
export function projectClientModuleRows(result: P.ClientModuleListResult): P.ClientModuleListResult {
  const modules: P.ClientModuleListResult['modules'] = result.modules.map((source) => ({
    ...(source.rowId === undefined ? {} : { rowId: source.rowId }),
    packageId: source.packageId,
    revision: source.revision,
    entryUrl: source.entryUrl,
    styleUrls: [...source.styleUrls],
    slots: [...source.slots],
    ...(source.slotCatalogVersion === undefined ? {} : { slotCatalogVersion: source.slotCatalogVersion }),
    ...(source.contentDigest === undefined ? {} : { contentDigest: source.contentDigest }),
    extIds: [...source.extIds],
    ...(source.intelligentComponents === undefined
      ? {}
      : { intelligentComponents: copyUiComponents(source.intelligentComponents) }),
    ...(source.publicConfig === undefined ? {} : { publicConfig: { ...source.publicConfig } }),
  }))
  const statuses: P.ClientModuleListResult['statuses'] = result.statuses.map((source) => ({
    packageId: source.packageId,
    installedRevision: source.installedRevision,
    backendRevision: source.backendRevision,
    state: source.state,
    ...(source.reason === undefined ? {} : { reason: source.reason }),
    ...(source.retained === undefined
      ? {}
      : {
          retained: source.retained.map((entry) => ({
            revision: entry.revision,
            expiresAt: entry.expiresAt,
          })),
        }),
  }))

  const safeResult = (rows: P.ClientModuleRosterRow[]): P.ClientModuleListResult => ({
    revision: result.revision,
    serverTime: result.serverTime,
    rows,
    ...(result.rowAliases === undefined
      ? {}
      : {
          rowAliases: Object.fromEntries(
            Object.entries(result.rowAliases).sort(([left], [right]) => left.localeCompare(right)),
          ),
        }),
    modules,
    statuses,
  })

  // Prefer a row projection supplied by a newer daemon. Keep the allow-list copy here as the
  // trust boundary too: an internal producer must not accidentally turn this helper into a raw
  // artifact/config pass-through when the protocol grows additional fields.
  if (result.rows !== undefined) {
    const rows = result.rows.map((source) => {
      const row: P.ClientModuleRosterRow = {
        rowId: source.rowId,
        moduleName: source.moduleName,
        enabled: source.enabled,
        phase: source.phase,
      }
      if (source.clientId !== undefined) row.clientId = source.clientId
      if (source.presentationRoleBindings !== undefined)
        row.presentationRoleBindings = { ...source.presentationRoleBindings }
      if (source.presentationRoles !== undefined) row.presentationRoles = [...source.presentationRoles]
      if (source.exampleOf !== undefined) row.exampleOf = source.exampleOf
      if (source.pageEntry !== undefined) row.pageEntry = source.pageEntry
      if (source.homeEntries !== undefined)
        row.homeEntries = source.homeEntries.map(({ id, placement }) => ({ id, placement }))
      if (source.examplePages !== undefined) row.examplePages = [...source.examplePages]
      if (source.binding !== undefined) {
        const { lifetime, owner, packageId, integrity, profileId, activationId, availability } =
          source.binding
        row.binding = { lifetime, owner, packageId, integrity, profileId, activationId, availability }
      }
      if (source.packageId !== undefined) row.packageId = source.packageId
      if (source.revision !== undefined) row.revision = source.revision
      const admission = source.documentAdmission
      if (admission && /^[a-f0-9]{64}$/.test(admission.bindingDigest)) {
        if (admission.kind === 'release' && !('presentationRevision' in admission))
          row.documentAdmission = { kind: admission.kind, bindingDigest: admission.bindingDigest }
        if (
          admission.kind === 'approved-presentation' &&
          Number.isSafeInteger(admission.presentationRevision) &&
          admission.presentationRevision >= 0
        ) {
          row.documentAdmission = {
            kind: admission.kind,
            bindingDigest: admission.bindingDigest,
            presentationRevision: admission.presentationRevision,
          }
        }
      }
      if (source.rendererDataUrl !== undefined) row.rendererDataUrl = source.rendererDataUrl
      if (source.entryUrl !== undefined) row.entryUrl = source.entryUrl
      if (source.styleUrls !== undefined) row.styleUrls = [...source.styleUrls]
      if (source.slots !== undefined) row.slots = [...source.slots]
      if (source.slotCatalogVersion !== undefined) row.slotCatalogVersion = source.slotCatalogVersion
      if (source.contentDigest !== undefined) row.contentDigest = source.contentDigest
      if (source.extIds !== undefined) row.extIds = [...source.extIds]
      if (source.services !== undefined) row.services = [...source.services]
      if (source.streams !== undefined) row.streams = [...source.streams]
      if (source.intelligentComponents !== undefined)
        row.intelligentComponents = copyUiComponents(source.intelligentComponents)
      if (source.publicConfig !== undefined) row.publicConfig = { ...source.publicConfig }
      return row
    })
    return safeResult(rows)
  }

  const modulesByRow = new Map(
    result.modules.map((module) => [module.rowId ?? `web:${module.packageId}`, module]),
  )
  const statusesByPackage = new Map(result.statuses.map((status) => [status.packageId, status]))
  const modulePackages = new Set(result.modules.map((module) => module.packageId))
  const rowIds = [
    ...new Set([
      ...modulesByRow.keys(),
      ...[...statusesByPackage.keys()]
        .filter((packageId) => !modulePackages.has(packageId))
        .map((packageId) => `web:${packageId}`),
    ]),
  ].sort((a, b) => a.localeCompare(b))
  const rows: P.ClientModuleRosterRow[] = []
  for (const rowId of rowIds) {
    const module = modulesByRow.get(rowId)
    const packageId = module?.packageId ?? rowId.slice('web:'.length)
    const status = statusesByPackage.get(packageId)
    const phase = status?.state ?? (module === undefined ? 'blocked' : 'ready')
    const row: P.ClientModuleRosterRow = {
      rowId,
      moduleName: packageId,
      enabled: status === undefined ? module !== undefined : status.state !== 'blocked',
      phase,
    }
    if (module !== undefined) row.packageId = module.packageId
    // Asset routes are only useful for a ready module and are copied field-by-field. In
    // particular, no status.reason, retained metadata, config, or credential-shaped value is
    // admitted to this projection.
    if (module !== undefined && phase === 'ready') {
      row.revision = module.revision
      row.entryUrl = module.entryUrl
      row.styleUrls = [...module.styleUrls]
      row.slots = [...module.slots]
      if (module.contentDigest !== undefined) row.contentDigest = module.contentDigest
      row.extIds = [...module.extIds]
      if (module.intelligentComponents !== undefined)
        row.intelligentComponents = copyUiComponents(module.intelligentComponents)
      if (module.publicConfig !== undefined) row.publicConfig = { ...module.publicConfig }
    }
    rows.push(row)
  }
  return safeResult(rows)
}

export const PACKAGE_ADMIN_PERMISSIONS = Object.freeze([
  'packages.read',
  'packages.install',
  'packages.trust',
  'packages.activate',
  'packages.remove',
  'catalog.configure',
  'extensions.execute',
  'credentials.read',
  'credentials.write',
] as const)
export type PackageAdminAccessPolicy = Readonly<{
  execution: 'read' | 'effect' | 'unblock'
  permission: P.PackageAdminPermission
  identity: 'none' | 'principal-client-command'
}>
export const PACKAGE_ADMIN_METHODS = Object.freeze({
  '_agnes/v1/applications.get': contract(P.PackageListParams, P.ApplicationState, 'read', 'packages.read'),
  '_agnes/v1/applications.preview': contract(
    P.ApplicationPreviewParams,
    P.ApplicationPreview,
    'read',
    'packages.read',
  ),
  '_agnes/v1/applications.adopt': contract(
    P.ApplicationAdoptParams,
    P.ApplicationState,
    'effect',
    'packages.activate',
  ),
  '_agnes/v1/applications.clear': contract(
    P.ApplicationClearParams,
    P.ApplicationState,
    'effect',
    'packages.activate',
  ),
  '_agnes/v1/plugins.candidates.list': contract(
    P.PackageListParams,
    P.AuthoringCandidateList,
    'read',
    'packages.read',
  ),
  '_agnes/v1/plugins.candidates.show': contract(
    P.AuthoringShowParams,
    P.AuthoringCandidate,
    'read',
    'packages.read',
  ),
  '_agnes/v1/plugins.candidates.create': contract(
    P.AuthoringCreateParams,
    P.AuthoringCandidate,
    'effect',
    'packages.install',
  ),
  '_agnes/v1/plugins.candidates.write': contract(
    P.AuthoringWriteParams,
    P.AuthoringCandidate,
    'effect',
    'packages.install',
  ),
  '_agnes/v1/plugins.candidates.test': contract(
    P.AuthoringTestParams,
    P.AuthoringCandidate,
    'effect',
    'extensions.execute',
  ),
  '_agnes/v1/plugins.candidates.submit': contract(
    P.AuthoringSubmitParams,
    P.AuthoringCandidate,
    'effect',
    'packages.install',
  ),
  '_agnes/v1/plugins.candidates.approve': contract(
    P.AuthoringApproveParams,
    P.AuthoringCandidate,
    'effect',
    'packages.trust',
  ),
  '_agnes/v1/plugins.candidates.reject': contract(
    P.AuthoringRejectParams,
    P.AuthoringCandidate,
    'effect',
    'packages.trust',
  ),

  '_agnes/v1/packages.catalog.list': contract(
    P.PackageCatalogListParams,
    P.PackageCatalogPage,
    'read',
    'packages.read',
  ),
  '_agnes/v1/packages.catalog.get': contract(
    P.PackageCatalogGetParams,
    P.PackageCatalogDescriptor,
    'read',
    'packages.read',
  ),
  '_agnes/v1/packages.provenance': contract(
    P.PackageProvenanceParams,
    P.PackageProvenance,
    'read',
    'packages.read',
  ),
  '_agnes/v1/packages.docs.get': contract(
    P.PackageDocsGetParams,
    P.PackageDocsGetResult,
    'read',
    'packages.read',
  ),
  '_agnes/v1/packages.sourcePolicy': contract(
    P.PackageListParams,
    P.PackageSourcePolicy,
    'read',
    'packages.read',
  ),
  '_agnes/v1/packages.list': contract(P.PackageListParams, P.PackageListResult, 'read', 'packages.read'),
  // Candidate discovery does not authorize stylesheet data.
  '_agnes/v1/skins.list': contract(P.PackageListParams, P.SkinListResult, 'read', 'packages.read'),
  '_agnes/v1/skins.select': contract(P.SkinSelectParams, P.SkinConfigSnapshot, 'effect', 'packages.activate'),
  // This launcher-only read serves files of the currently effective exact selection.
  '_agnes/v1/skins.read': contract(P.SkinReadParams, P.SkinReadResult, 'read', 'packages.read'),
  // A session selector resolves the immutable roster pinned with its backend generation.
  '_agnes/v1/clientModules.list': contract(
    P.ClientModuleListParams,
    P.ClientModuleListResult,
    'read',
    'packages.read',
  ),
  // One client-module file's bytes from the daemon-managed immutable snapshot. The path is a
  // same-origin URL path, never a filesystem path; miss and refusal share one negative answer.
  '_agnes/v1/clientModules.read': contract(
    P.ClientModuleReadParams,
    P.ClientModuleReadResult,
    'read',
    'packages.read',
  ),
  '_agnes/v1/clientModules.frontendPublication': contract(
    P.PackageListParams,
    P.FrontendPublicationOwnerResult,
    'read',
    'packages.read',
  ),
  // A private launcher BFF uses this fixed typed route.  It is never granted to the WebSocket
  // page connection and the daemon re-checks the live row/service authority before dispatch.
  '_agnes/v1/clientModules.callService': contract(
    P.ClientModuleServiceCallParams,
    P.ClientModuleServiceCallResult,
    'read',
    'packages.read',
  ),
  // Effects use a separate private BFF/RPC path. The browser first passes the host-owned command
  // authorizer; the daemon then rechecks the live row and applies durable command semantics.
  '_agnes/v1/clientModules.callEffect': contract(
    P.ClientModuleEffectCallParams,
    P.ClientModuleEffectCallResult,
    'effect',
    'extensions.execute',
  ),
  '_agnes/v1/packages.inspect': contract(
    P.PackageInspectParams,
    P.PackageOperationReceipt,
    'effect',
    'packages.install',
  ),
  '_agnes/v1/packages.install': contract(
    P.PackageInstallParams,
    P.PackageOperationReceipt,
    'effect',
    'packages.install',
  ),
  '_agnes/v1/packages.trust': contract(
    P.PackageTrustParams,
    P.PackageOperationReceipt,
    'effect',
    'packages.trust',
  ),
  '_agnes/v1/packages.untrust': contract(
    P.PackageUntrustParams,
    P.PackageOperationReceipt,
    'effect',
    'packages.trust',
  ),
  '_agnes/v1/packages.enable': contract(
    P.PackageEnableParams,
    P.PackageOperationReceipt,
    'effect',
    'packages.activate',
  ),
  '_agnes/v1/packages.disable': contract(
    P.PackageDisableParams,
    P.PackageOperationReceipt,
    'effect',
    'packages.activate',
  ),
  '_agnes/v1/packages.update': contract(
    P.PackageUpdateParams,
    P.PackageOperationReceipt,
    'effect',
    'packages.install',
  ),
  '_agnes/v1/packages.rollback': contract(
    P.PackageRollbackParams,
    P.PackageOperationReceipt,
    'effect',
    'packages.remove',
  ),
  '_agnes/v1/packages.remove': contract(
    P.PackageRemoveParams,
    P.PackageOperationReceipt,
    'effect',
    'packages.remove',
  ),
  '_agnes/v1/packages.operation.get': contract(
    P.PackageOperationGetParams,
    P.PackageOperation,
    'read',
    'packages.read',
  ),
  '_agnes/v1/packages.operation.cancel': contract(
    P.PackageOperationCancelParams,
    P.PackageOperationReceipt,
    'unblock',
    'packages.activate',
  ),
  '_agnes/v1/packages.pins.inspect': contract(
    P.PackagePinsInspectParams,
    P.PackagePinsInspectResult,
    'read',
    'packages.read',
  ),
  '_agnes/v1/packages.pins.release': contract(
    P.PackagePinsReleaseParams,
    P.PackagePinsReleaseResult,
    'effect',
    'packages.remove',
  ),
  '_agnes/v1/packages.trustWorkspace': contract(
    P.PackageTrustWorkspaceParams,
    P.PackageTrustWorkspaceResult,
    'effect',
    'packages.trust',
  ),
  '_agnes/v1/packages.skillImport': contract(
    P.SkillImportParams,
    P.SkillImportResult,
    'effect',
    'packages.install',
  ),
  '_agnes/v1/plugins.tree.get': contract(P.PackageListParams, P.PluginTreeView, 'read', 'packages.read'),
  '_agnes/v1/plugins.publicationStatus': contract(
    P.PackageListParams,
    P.PluginPublicationStatusResult,
    'read',
    'packages.read',
  ),
  '_agnes/v1/sessions.migrate': contract(
    P.SessionGenerationMigrationParams,
    P.SessionGenerationMigrationResult,
    'effect',
    'packages.activate',
  ),
  '_agnes/v1/plugins.generations': contract(
    P.PackageListParams,
    P.PluginGenerationStatus,
    'read',
    'packages.read',
  ),
  '_agnes/v1/plugins.tree.list': contract(P.PackageListParams, P.PluginTreeView, 'read', 'packages.read'),
  '_agnes/v1/plugins.tree.apply': contract(
    P.PluginTreeApplyParams,
    P.PluginTreeApplyResult,
    'effect',
    'packages.activate',
  ),
  '_agnes/v1/plugins.tree.rollback': contract(
    P.PluginTreeRollbackParams,
    P.PluginTreeRollbackResult,
    'effect',
    'packages.activate',
  ),
  '_agnes/v1/plugins.config.get': contract(
    P.PluginConfigGetParams,
    P.PluginConfigSnapshot,
    'read',
    'packages.read',
  ),
  '_agnes/v1/plugins.config.validate': contract(
    P.PluginConfigValidateParams,
    P.PluginConfigValidation,
    'read',
    'packages.read',
  ),
  '_agnes/v1/plugins.config.save': contract(
    P.PluginConfigSaveParams,
    P.PluginConfigSaveResult,
    'effect',
    'packages.activate',
  ),
})
export type PackageAdminMethodName = keyof typeof PACKAGE_ADMIN_METHODS

/** Authority comes from authenticated Host context, never from request params. */
export function canAccessPackageAdmin(
  method: PackageAdminMethodName,
  authority: {
    audience: string
    permissions: readonly string[]
  },
): boolean {
  return (
    authority.audience === 'admin' &&
    Object.hasOwn(PACKAGE_ADMIN_METHODS, method) &&
    authority.permissions.includes(PACKAGE_ADMIN_METHODS[method].administration.permission)
  )
}

export function validatePackageAdminCall(
  name: PackageAdminMethodName,
  side: 'params' | 'result',
  value: unknown,
): ValidationResult<unknown> {
  return check(PACKAGE_ADMIN_METHODS[name][side], value, adminPayloadBudget(name, side))
}
