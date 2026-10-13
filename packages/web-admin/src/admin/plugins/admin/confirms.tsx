import type { PackageInstalledDescriptor, PackagePreview } from '@agnes/protocol'
import {
  PreviewConfirmationFacts,
  RollbackActivationFacts,
  SettingsTechnicalDetails,
  TrustConfirmationFacts,
  UntrustConfirmationFacts,
  UpdateActivationFacts,
} from '@agnes/web-ui'
import type { ReactNode } from 'react'
import { CapabilityReview, ProvenanceReview } from '../capability-review.js'
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

/** What a package gets, in plain words, above the technical record of the same preview. */
export function PreviewFacts({
  preview,
  installed,
  t,
}: {
  preview: PackagePreview
  /** Set when the update also activates: the facts then bind both current summaries. */
  installed: PackageInstalledDescriptor | undefined
  t: Text
}) {
  return (
    <>
      <CapabilityReview value={preview.declaredCapabilities} t={t} />
      <ProvenanceReview value={preview.provenance} t={t} />
      {/* A blocker or warning is why the user is reading this: show it without a click. */}
      <Technical open={preview.blockers.length > 0 || preview.warnings.length > 0}>
        {installed ? (
          <UpdateActivationFacts installed={installed} preview={preview} />
        ) : (
          <PreviewConfirmationFacts preview={preview} />
        )}
      </Technical>
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
