import type {
  PackageBlocker,
  PackageInstalledDescriptor,
  PackageOperation,
  PackagePreview,
} from '@agnes/protocol'
import { ADMIN_LOCALE_NAMESPACE, adminLocaleCatalog } from './locales/admin.js'
import { createCatalogTranslator, type LocaleTranslator } from './ui-locale.js'

/**
 * 浏览器 UI 运行状态的展示视图。结构与 web 包的 PluginRuntimeState 保持结构化等价
 * （phase/packageId/revision/error.message），组件层不 import web 包。
 */
export type RuntimeStateView = Readonly<{
  packageId: string
  revision: string | undefined
  phase: 'idle' | 'loading' | 'active' | 'stopping' | 'failed'
  error?: Readonly<{ message: string }>
}>

export type { LocaleTranslator as AdminTranslator }
export { ADMIN_LOCALE_NAMESPACE }

const englishText = createCatalogTranslator(adminLocaleCatalog, 'en')

export function hasPermission(permissions: readonly string[], permission: string): boolean {
  return permissions.includes(permission)
}

export function sourceLabel(
  source: { type: string; ref: string },
  t: LocaleTranslator = englishText,
): string {
  const sourceTypeKey = `source.${source.type}`
  const translatedType = t(sourceTypeKey)
  const type = translatedType === sourceTypeKey ? source.type : translatedType
  return `${type} · ${source.ref}`
}

export function contributionText(
  item: { contributions: readonly { kind: string; id: string }[] },
  t: LocaleTranslator = englishText,
): string {
  if (!item.contributions.length) return t('contribution.none')
  const labels = item.contributions.slice(0, 3).map((contribution) => {
    const kindKey = `contribution.${contribution.kind}`
    const translatedKind = t(kindKey)
    const kind = translatedKind === kindKey ? contribution.kind : translatedKind
    return `${kind} · ${contribution.id}`
  })
  const more = item.contributions.length - labels.length
  return more
    ? `${labels.join(t('list.separator'))}${t('list.separator')}${t('contribution.more', { count: more })}`
    : labels.join(t('list.separator'))
}

export function integrityLabel(integrity: string): string {
  return integrity.length > 27 ? `${integrity.slice(0, 14)}…${integrity.slice(-12)}` : integrity
}

export function installedState(
  item: PackageInstalledDescriptor,
  effectiveActual: PackageInstalledDescriptor['actual'] = item.actual,
  t: LocaleTranslator = englishText,
): string {
  const desired = t(item.desired === 'enabled' ? 'desired.enabled' : 'desired.disabled')
  const actual = t(`actual.${effectiveActual}`)
  const cleanup = item.cleanupPending ? t('actual.cleanup-pending') : ''
  return t('state.separator', { desired, actual, cleanup: cleanup ? ` · ${cleanup}` : '' })
}

export function actualIdentity(item: PackageInstalledDescriptor, t: LocaleTranslator = englishText): string {
  if (item.actualVersion && item.actualIntegrity)
    return `${item.actualVersion} · ${integrityLabel(item.actualIntegrity)}`
  if (item.actual === 'not-running') return t('actual.not-running')
  return t('actual.unknown-version')
}

export function runtimeStateLabel(
  state: RuntimeStateView | undefined,
  t: LocaleTranslator = englishText,
): string {
  if (!state) return t('runtime.unconfirmed')
  return t(`runtime.${state.phase}`)
}

export function runtimeStateMessage(
  state: RuntimeStateView | undefined,
  t: LocaleTranslator = englishText,
): string {
  if (!state) return t('runtime.waiting')
  if (state.phase === 'failed') return t('runtime.retry')
  return runtimeStateLabel(state, t)
}

export function operationLabel(operation: PackageOperation, t: LocaleTranslator = englishText): string {
  return t('operation.label', {
    operation: operationName(operation.operation, t),
    state: t(`operation-state.${operation.state}`),
  })
}

export function operationName(
  operation: PackageOperation['operation'],
  t: LocaleTranslator = englishText,
): string {
  return t(`operation.${operation}`)
}

export function terminal(operation: PackageOperation): boolean {
  return ['completed', 'failed', 'cancelled', 'rolled-back'].includes(operation.state)
}

export function blockerText(blocker: PackageBlocker, t: LocaleTranslator = englishText): string {
  const name = t(`blocker.${blocker.code}`)
  const references = blocker.references.length
    ? t('blocker.references', { references: blocker.references.join(t('list.separator')) })
    : ''
  return t('blocker.message', { name, references })
}

export function capabilitySummary(preview: PackagePreview, t: LocaleTranslator = englishText): string {
  const diff = preview.capabilityDiff
  const changes = [
    ...diff.added.map((item) => t('capability.added', { item })),
    ...diff.removed.map((item) => t('capability.removed', { item })),
    ...diff.runtimeSupportRemoved.map((item) => t('capability.runtime-removed', { item })),
    ...diff.dependenciesAdded.map((item) => t('capability.dependency-added', { item })),
    ...diff.serviceGrantsAdded.map((item) =>
      t('capability.service-added', { extension: item.extension, name: item.name, range: item.range }),
    ),
  ]
  return changes.length ? changes.join(t('list.separator')) : t('capability.none')
}
