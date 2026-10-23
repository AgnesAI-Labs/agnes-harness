import type { PackageCatalogDescriptor, PackageInstalledDescriptor, PackagePreview } from '@agnes/protocol'
import {
  type DetailActionSpec,
  isBuiltinPlugin,
  PreviewConfirmationFacts,
  RollbackActivationFacts,
  SettingsTechnicalDetails,
  TrustConfirmationFacts,
  UntrustConfirmationFacts,
  UpdateActivationFacts,
  UpdateDiff,
} from '@agnes/web-ui'
import type { ReactNode } from 'react'
import { CapabilityReview, ProvenanceReview } from '../capability-review.js'
import { ADMIN_FEATURES, hasFeature } from '../types.js'
import { manageExample } from './example-parent.js'
import type { PluginAdminPage } from './page.js'

type Text = (key: string, vars?: Readonly<Record<string, string | number>>) => string

/** Hashes, signatures and fact tables: there for whoever investigates, closed for everyone else. */
function Technical({ open = false, children }: { open?: boolean; children: ReactNode }) {
  return (
    <SettingsTechnicalDetails data-testid="plugin-confirm-technical" defaultOpen={open}>
      {children}
    </SettingsTechnicalDetails>
  )
}

/**
 * An install shows what the package gets, in plain words. An update shows only what changes against
 * the installed version. The full record of either sits under technical details.
 */
export function PreviewFacts({
  preview,
  current,
  combined,
  t,
}: {
  preview: PackagePreview
  /** The installed version this preview updates; absent for a first install. */
  current: PackageInstalledDescriptor | undefined
  /** The update also activates: the technical facts then bind both current summaries. */
  combined: boolean
  t: Text
}) {
  return (
    <>
      {current ? (
        <UpdateDiff preview={preview} fromVersion={current.version} current={current} />
      ) : (
        <CapabilityReview value={preview.declaredCapabilities} preflight={preview.preflight} t={t} />
      )}
      <ProvenanceReview value={preview.provenance} t={t} />
      {/* A blocker or warning is why the user is reading this: show it without a click. */}
      <Technical open={preview.blockers.length > 0 || preview.warnings.length > 0}>
        {current && (
          <CapabilityReview value={preview.declaredCapabilities} preflight={preview.preflight} t={t} />
        )}
        {current && combined ? (
          <UpdateActivationFacts installed={current} preview={preview} />
        ) : (
          <PreviewConfirmationFacts preview={preview} />
        )}
      </Technical>
    </>
  )
}

/**
 * What a review page keeps under Technical details: the full record of the preview and where it came from.
 * The confirmation this replaced showed the same facts.
 */
export function PreviewTechnicalFacts({
  preview,
  current,
  combined,
  t,
}: {
  preview: PackagePreview
  current: PackageInstalledDescriptor | undefined
  combined: boolean
  t: Text
}) {
  return (
    <>
      <ProvenanceReview value={preview.provenance} t={t} />
      {current && (
        <CapabilityReview value={preview.declaredCapabilities} preflight={preview.preflight} t={t} />
      )}
      {current && combined ? (
        <UpdateActivationFacts installed={current} preview={preview} />
      ) : (
        <PreviewConfirmationFacts preview={preview} />
      )}
    </>
  )
}

export function EnableFacts({ item, t }: { item: PackageInstalledDescriptor; t: Text }) {
  return (
    <>
      <CapabilityReview value={item.declaredCapabilities} t={t} />
      <ProvenanceReview value={item.provenance} t={t} />
      {!item.trusted && (
        <Technical open={item.blockers.length > 0}>
          <TrustConfirmationFacts item={item} leadKey="lead.trust-enable" />
        </Technical>
      )}
    </>
  )
}

export function RollbackFacts({ item }: { item: PackageInstalledDescriptor }) {
  return (
    <Technical>
      <RollbackActivationFacts installed={item} />
    </Technical>
  )
}

/** One-sentence confirmations: disable, uninstall and revoke trust each submit a single operation. */
export function confirmSimple(
  page: PluginAdminPage,
  kind: 'disable' | 'remove' | 'untrust',
  item: PackageInstalledDescriptor,
  name: string,
): void {
  if ((kind === 'remove' && isBuiltinPlugin(item)) || manageExample(page, item)) return
  const { t } = page.viewContext()
  page.configureConfirm({
    title: () => t(`confirm.${kind}.title`, { id: name }),
    description: () => t(`confirm.${kind}.description`),
    label: () => t(`confirm.${kind}.action`),
    danger: kind !== 'disable',
    ...(kind === 'untrust'
      ? {
          facts: (
            <Technical>
              <UntrustConfirmationFacts item={item} />
            </Technical>
          ),
        }
      : {}),
    run: async () => {
      const api = page.effectApi(
        kind === 'disable' ? 'packages.activate' : kind === 'remove' ? 'packages.remove' : 'packages.trust',
      )
      if (!api) return
      const hash = item.capabilityHash
      if (kind === 'untrust' && !hash) return
      const receipt = await page.submitPackage(item.id, () =>
        kind === 'disable'
          ? api.disable(item.id)
          : kind === 'remove'
            ? api.remove(item.id)
            : api.untrust(item.id, item.integrity, hash ?? ''),
      )
      page.track(receipt.operationId, { packageId: item.id })
    },
  })
}

/**
 * The actions a plugin is offered. What ships with the product can be switched off, never removed,
 * so its uninstall (the one destructive action among the version actions) is left out.
 */
export function offeredActions(page: PluginAdminPage) {
  return (item: PackageInstalledDescriptor | PackageCatalogDescriptor): readonly DetailActionSpec[] => {
    if (item.metadata?.exampleOf) return []
    const actions = page.detailActions(item)
    return isBuiltinPlugin(item)
      ? actions.filter((action) => !(action.danger && action.group === 'versions'))
      : actions
  }
}

export function confirmEnable(
  page: PluginAdminPage,
  item: PackageInstalledDescriptor,
  run: () => Promise<void>,
): Promise<void> {
  if (manageExample(page, item)) return Promise.resolve()
  const { t } = page.viewContext()
  if (
    hasFeature(page.viewContext().state.context, ADMIN_FEATURES.runtimeIdentity) &&
    page.activeIntegrity(item) === undefined
  ) {
    page.showError({
      code: 'RUNTIME_IDENTITY_UNKNOWN',
      message: 'The actual runtime summary has not been confirmed, so this plugin cannot be safely enabled.',
    })
    return Promise.resolve()
  }
  if (!item.trusted && !item.capabilityHash) {
    page.showError({
      code: 'E_PACKAGE_TRUST',
      message: 'The capability summary has not been confirmed, so this version cannot be safely enabled.',
    })
    return Promise.resolve()
  }
  page.configureConfirm({
    title: () => t('confirm.enable.title', { id: page.nameOf(item) }),
    description: () => t(item.trusted ? 'confirm.enable.trusted' : 'confirm.enable.verify'),
    label: () => t(item.trusted ? 'confirm.enable.action' : 'confirm.enable.trust-action'),
    facts: <EnableFacts item={item} t={t} />,
    run,
  })
  return Promise.resolve()
}
