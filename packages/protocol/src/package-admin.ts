import type { TSchema } from '@sinclair/typebox'
import * as P from '../gen/ts/package-admin.js'
import { inspectJsonData } from './json-data.js'
import { type ValidationResult, validateAgainst } from './validate.js'

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
      if (source.packageId !== undefined) row.packageId = source.packageId
      if (source.revision !== undefined) row.revision = source.revision
      if (source.entryUrl !== undefined) row.entryUrl = source.entryUrl
      if (source.styleUrls !== undefined) row.styleUrls = [...source.styleUrls]
      if (source.slots !== undefined) row.slots = [...source.slots]
      if (source.slotCatalogVersion !== undefined) row.slotCatalogVersion = source.slotCatalogVersion
      if (source.contentDigest !== undefined) row.contentDigest = source.contentDigest
      if (source.extIds !== undefined) row.extIds = [...source.extIds]
      if (source.services !== undefined) row.services = [...source.services]
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
] as const)
export type PackageAdminAccessPolicy = Readonly<{
  execution: 'read' | 'effect' | 'unblock'
  permission: P.PackageAdminPermission
  identity: 'none' | 'principal-client-command'
}>
const contract = (
  params: TSchema,
  result: TSchema,
  execution: PackageAdminAccessPolicy['execution'],
  permission: P.PackageAdminPermission,
) =>
  Object.freeze({
    kind: 'request' as const,
    direction: 'c2s' as const,
    params,
    result,
    administration: Object.freeze({
      execution,
      permission,
      identity: execution === 'read' ? ('none' as const) : ('principal-client-command' as const),
    }),
  })
export const PACKAGE_ADMIN_METHODS = Object.freeze({
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
  '_agnes/v1/packages.list': contract(P.PackageListParams, P.PackageListResult, 'read', 'packages.read'),
  // Skins are derived from the installed-package inventory: the request reuses PackageListParams and
  // the read permission rather than adding a permission that would ripple into the authorization surface.
  '_agnes/v1/skins.list': contract(P.PackageListParams, P.SkinListResult, 'read', 'packages.read'),
  // One skin file's bytes. The path is a same-origin URL path, never a filesystem path, and the
  // daemon answers only for ids its enabled+trusted roster claims (design §22).
  '_agnes/v1/skins.read': contract(P.SkinReadParams, P.SkinReadResult, 'read', 'packages.read'),
  // Web client modules (design WC2/WC3): the roster is derived from inventory + activation state,
  // so the request reuses PackageListParams and the read permission, same as skins.
  '_agnes/v1/clientModules.list': contract(
    P.PackageListParams,
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
  '_agnes/v1/plugins.tree.get': contract(P.PackageListParams, P.PluginTreeView, 'read', 'packages.read'),
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

// Written out explicitly, rather than derived as `keyof typeof DATA_SCHEMAS`, for the same reason
// MethodName is in methods.ts: once the object literal grows past a certain size, tsc's declaration
// emit hits TS7056 ("inferred type ... exceeds the maximum length the compiler will serialize")
// trying to print the whole literal type. An explicit annotation on the table sidesteps that by
// giving tsc a short type reference (`Record<PackageAdminDataName, TSchema>`) to print instead.
export type PackageAdminDataName =
  | 'PackageAdminPermission'
  | 'PackageSource'
  | 'PackageContributionSummary'
  | 'PackageCapabilityDiff'
  | 'PackageBlocker'
  | 'PackageWarning'
  | 'PackageProvenance'
  | 'PackagePreview'
  | 'PackageTrustDecision'
  | 'PackageActivationTrust'
  | 'PackageActivationRequest'
  | 'PackageRollbackTarget'
  | 'PackageAdminContext'
  | 'PackageInstalledDescriptor'
  | 'PackageCatalogDescriptor'
  | 'PackageAdminError'
  | 'PackageOperationReceipt'
  | 'PackageOperation'
  | 'PackageCatalogPage'
  | 'PackageListResult'
  | 'PackageCatalogListParams'
  | 'PackageCatalogGetParams'
  | 'PackageListParams'
  | 'PackageInspectParams'
  | 'PackageInstallParams'
  | 'PackageTrustParams'
  | 'PackageUntrustParams'
  | 'PackageEnableParams'
  | 'PackageDisableParams'
  | 'PackageRollbackParams'
  | 'PackageRemoveParams'
  | 'PackageUpdateParams'
  | 'PackageOperationGetParams'
  | 'PackageOperationCancelParams'
  | 'RuntimePinDescriptor'
  | 'RuntimePinReleaseResult'
  | 'PackagePinsInspectParams'
  | 'PackagePinsInspectResult'
  | 'PackagePinsReleaseParams'
  | 'PackagePinsReleaseResult'
  | 'PackageTrustWorkspaceParams'
  | 'PackageTrustWorkspaceResult'
  | 'PluginTreeArtifact'
  | 'PluginTreeApplyParams'
  | 'PluginTreeRollbackParams'
  | 'PluginTreeView'
  | 'PluginTreeApplyResult'
  | 'PluginTreeRollbackResult'
  | 'ClientModuleRosterRow'
  | 'ClientModuleEffectCallParams'
const DATA_SCHEMAS: Record<PackageAdminDataName, TSchema> = {
  PackageAdminPermission: P.PackageAdminPermission,
  PackageSource: P.PackageSource,
  PackageContributionSummary: P.PackageContributionSummary,
  PackageCapabilityDiff: P.PackageCapabilityDiff,
  PackageBlocker: P.PackageBlocker,
  PackageWarning: P.PackageWarning,
  PackageProvenance: P.PackageProvenance,
  PackagePreview: P.PackagePreview,
  PackageTrustDecision: P.PackageTrustDecision,
  PackageActivationTrust: P.PackageActivationTrust,
  PackageActivationRequest: P.PackageActivationRequest,
  PackageRollbackTarget: P.PackageRollbackTarget,
  PackageAdminContext: P.PackageAdminContext,
  PackageInstalledDescriptor: P.PackageInstalledDescriptor,
  PackageCatalogDescriptor: P.PackageCatalogDescriptor,
  PackageAdminError: P.PackageAdminError,
  PackageOperationReceipt: P.PackageOperationReceipt,
  PackageOperation: P.PackageOperation,
  PackageCatalogPage: P.PackageCatalogPage,
  PackageListResult: P.PackageListResult,
  PackageCatalogListParams: P.PackageCatalogListParams,
  PackageCatalogGetParams: P.PackageCatalogGetParams,
  PackageListParams: P.PackageListParams,
  PackageInspectParams: P.PackageInspectParams,
  PackageInstallParams: P.PackageInstallParams,
  PackageTrustParams: P.PackageTrustParams,
  PackageUntrustParams: P.PackageUntrustParams,
  PackageEnableParams: P.PackageEnableParams,
  PackageDisableParams: P.PackageDisableParams,
  PackageRollbackParams: P.PackageRollbackParams,
  PackageRemoveParams: P.PackageRemoveParams,
  PackageUpdateParams: P.PackageUpdateParams,
  PackageOperationGetParams: P.PackageOperationGetParams,
  PackageOperationCancelParams: P.PackageOperationCancelParams,
  RuntimePinDescriptor: P.RuntimePinDescriptor,
  RuntimePinReleaseResult: P.RuntimePinReleaseResult,
  PackagePinsInspectParams: P.PackagePinsInspectParams,
  PackagePinsInspectResult: P.PackagePinsInspectResult,
  PackagePinsReleaseParams: P.PackagePinsReleaseParams,
  PackagePinsReleaseResult: P.PackagePinsReleaseResult,
  PackageTrustWorkspaceParams: P.PackageTrustWorkspaceParams,
  PackageTrustWorkspaceResult: P.PackageTrustWorkspaceResult,
  PluginTreeArtifact: P.PluginTreeArtifact,
  PluginTreeApplyParams: P.PluginTreeApplyParams,
  PluginTreeRollbackParams: P.PluginTreeRollbackParams,
  PluginTreeView: P.PluginTreeView,
  PluginTreeApplyResult: P.PluginTreeApplyResult,
  PluginTreeRollbackResult: P.PluginTreeRollbackResult,
  ClientModuleRosterRow: P.ClientModuleRosterRow,
  ClientModuleEffectCallParams: P.ClientModuleEffectCallParams,
}
function check(schema: TSchema, value: unknown): ValidationResult<unknown> {
  const inspected = inspectJsonData(value, 1048576)
  if (!inspected.ok)
    return { ok: false, errors: [{ path: '', code: 'TYPE', message: 'expected bounded strict JSON data' }] }
  return validateAgainst(schema, inspected.value)
}
export function validatePackageAdminData(
  name: PackageAdminDataName,
  value: unknown,
): ValidationResult<unknown> {
  return check(DATA_SCHEMAS[name], value)
}
export function validatePackageAdminCall(
  name: PackageAdminMethodName,
  side: 'params' | 'result',
  value: unknown,
): ValidationResult<unknown> {
  return check(PACKAGE_ADMIN_METHODS[name][side], value)
}
