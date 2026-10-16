import type {
  PackageActivationRequest,
  PackageInstalledDescriptor,
  PackagePreview,
  PackageUpdateParams,
} from '@agnes/protocol'
import { Banner, SettingsGroup, SettingsItem, UpdateDiff } from '@agnes/web-ui'
import type { PluginAdminApi } from '../api.js'
import { capabilityRequests } from '../capability-review.js'
import { PreviewTechnicalFacts } from './confirms.js'
import type { PluginAdminPage } from './page.js'

export function blockedDependents(preview: PackagePreview): string[] {
  return [...new Set(preview.blockers.filter((b) => b.code === 'dependency').flatMap((b) => b.references))]
}
async function inspect(api: PluginAdminApi, source: PackagePreview['source'], signal: AbortSignal) {
  signal.throwIfAborted()
  const receipt = await api.inspect(source),
    deadline = Date.now() + 30_000
  while (!signal.aborted && Date.now() < deadline) {
    const operation = await api.operation(receipt.operationId)
    if (operation.state === 'completed' && operation.preview) return operation.preview
    if (['failed', 'cancelled'].includes(operation.state))
      throw new Error(operation.error?.safeMessage ?? 'Package inspection failed')
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Package inspection did not complete. Retry the review.')
}
/** Every source is inspected before showing a single explicit review; no update occurs here. */
export async function reviewDependentUpdates(
  page: PluginAdminPage,
  api: PluginAdminApi,
  preview: PackagePreview,
  signal: AbortSignal,
): Promise<void> {
  const view = page.viewContext(),
    ids = blockedDependents(preview)
  if (!ids.length || ids.length > 32) throw new Error('The update has no bounded dependent plan')
  const activation = (
    current: PackageInstalledDescriptor,
    candidate: PackagePreview,
  ): PackageActivationRequest => {
    const active = page.activeIntegrity(current)
    if (
      !candidate.capabilityHash ||
      !current.trusted ||
      active === undefined ||
      !page.can('packages.trust') ||
      !page.canEffect('packages.activate')
    )
      throw new Error(view.t('update.dependents.unavailable'))
    return {
      expectedInstalledIntegrity: current.integrity,
      expectedActiveIntegrity: active,
      trust: { integrity: candidate.integrity, capabilityHash: candidate.capabilityHash },
    }
  }
  const parent = view.state.installed.find((item) => item.id === preview.id)
  if (!parent) throw new Error('The parent is no longer installed')
  const parentActivation = activation(parent, preview)
  const members: { current: PackageInstalledDescriptor; preview: PackagePreview }[] = []
  for (const id of ids) {
    const current = view.state.installed.find((item) => item.id === id)
    if (!current) throw new Error(view.t('update.dependents.unavailable'))
    const candidate = await inspect(api, current.source, signal)
    if (
      candidate.id !== id ||
      candidate.integrity === current.integrity ||
      candidate.blockers.some(
        (b) =>
          b.code !== 'dependency' ||
          b.references[0] !== 'example-parent-unavailable' ||
          b.references[1] !== parent.id,
      )
    )
      throw new Error(view.t('update.dependents.unavailable'))
    members.push({ current, preview: candidate })
  }
  const dependents: NonNullable<PackageUpdateParams['dependents']> = members.map((member) => ({
    id: member.current.id,
    source: member.preview.source,
    expectedIntegrity: member.preview.integrity,
    activation: activation(member.current, member.preview),
  }))
  if (signal.aborted) return
  page.configureConfirm({
    title: () => view.t('update.dependents.title'),
    description: () => view.t('update.dependents.description'),
    label: () => view.t('update.dependents.confirm'),
    facts: (
      <div data-testid="dependent-update-review">
        <Banner tone="warning">{ids.join(', ')}</Banner>
        {[{ current: parent, preview }, ...members].map((member) => (
          <section key={member.current.id}>
            <h3>{page.nameOf(member.preview)}</h3>
            <UpdateDiff preview={member.preview} fromVersion={member.current.version} />
            <SettingsGroup>
              <SettingsItem
                label={view.t('review.capabilities')}
                description={
                  capabilityRequests(member.preview.declaredCapabilities, view.t).join(
                    view.t('review.separator'),
                  ) || view.t('capability.none')
                }
              />
            </SettingsGroup>
            <PreviewTechnicalFacts preview={member.preview} current={member.current} combined t={view.t} />
          </section>
        ))}
      </div>
    ),
    run: async () => {
      const receipt = await page.submitPackage(preview.id, () =>
        api.update(preview.id, preview.source, preview.integrity, parentActivation, dependents),
      )
      page.cancelReview()
      page.track(receipt.operationId, { packageId: preview.id })
    },
  })
}

export async function startDependentReview(
  page: PluginAdminPage,
  api: PluginAdminApi | undefined,
  preview: PackagePreview | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (!preview || !api) return
  try {
    await reviewDependentUpdates(page, api, preview, signal)
  } catch (error) {
    if (!signal.aborted) page.showError(error)
  }
}
