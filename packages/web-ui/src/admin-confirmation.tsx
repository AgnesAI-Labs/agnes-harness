import type {
  Capabilities,
  PackageBlocker,
  PackageContributionSummary,
  PackageInstalledDescriptor,
  PackagePreview,
  SurfaceServiceGrant,
} from '@agnes/protocol'
import { isWebClientModuleSlotName } from '@agnes/protocol'
import type { JSX, ReactNode } from 'react'
import { ADMIN_LOCALE_NAMESPACE, blockerText, sourceLabel } from './admin-text.js'
import { adminLocaleCatalog } from './locales/admin.js'
import {
  ADMIN_CONFIRMATION_LOCALE_NAMESPACE,
  adminConfirmationLocaleCatalog,
} from './locales/admin-confirmation.js'
import { type LocaleTranslator, useUiText } from './ui-locale.js'

type Fact = readonly [label: string, value: string]

function FactsList({ items }: { items: readonly Fact[] }): JSX.Element {
  return (
    <dl className="confirm-facts-list">
      {items.map(([label, value]) => (
        <Fragmented key={`${label}:${value}`} label={label} value={value} />
      ))}
    </dl>
  )
}

function Fragmented({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  )
}

function ReviewSection({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <details className="confirm-review-section">
      <summary>{title}</summary>
      <div className="confirm-review-content">{children}</div>
    </details>
  )
}

function TextList({ items, empty }: { items: readonly string[]; empty: string }): JSX.Element {
  if (!items.length) return <p className="confirm-empty-fact">{empty}</p>
  return (
    <ul>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  )
}

function serviceGrant(grant: SurfaceServiceGrant): string {
  return `${grant.extension} · ${grant.name} · ${grant.range}`
}

function capabilityLines(capabilities: Capabilities, t: LocaleTranslator): string[] {
  const lines: string[] = []
  if (capabilities.tools) {
    const names = capabilities.tools.names?.length
      ? t('capability.names', { names: capabilities.tools.names.join(t('list.separator')) })
      : t('capability.names-unknown')
    lines.push(
      `${t('capability.tools')}: ${t('capability.prefix')} ${capabilities.tools.prefix || t('value.no-prefix')} · ${names}`,
    )
  }
  if (capabilities['tools.invoke'] !== undefined)
    lines.push(
      `${t('capability.invoke')}: ${t(capabilities['tools.invoke'] ? 'boolean.allowed' : 'boolean.denied')}`,
    )
  if (capabilities.hooks?.length)
    lines.push(`${t('capability.hooks')}: ${capabilities.hooks.join(t('list.separator'))}`)
  if (capabilities.slots?.length)
    lines.push(`${t('capability.slots')}: ${capabilities.slots.join(t('list.separator'))}`)
  if (capabilities.events !== undefined)
    lines.push(`${t('capability.events')}: ${t(capabilities.events ? 'boolean.allowed' : 'boolean.denied')}`)
  if (capabilities.resources?.length)
    lines.push(`${t('capability.resources')}: ${capabilities.resources.join(t('list.separator'))}`)
  if (capabilities.network !== undefined) {
    lines.push(
      Array.isArray(capabilities.network)
        ? t('capability.network-denied')
        : t('capability.network-hosts', { hosts: capabilities.network.hosts.join(t('list.separator')) }),
    )
  }
  if (capabilities.artifacts !== undefined)
    lines.push(
      `${t('capability.artifacts')}: ${t(capabilities.artifacts ? 'boolean.allowed' : 'boolean.denied')}`,
    )
  if (capabilities['network.publicRead'] !== undefined)
    lines.push(
      `${t('capability.public-read')}: ${t(
        capabilities['network.publicRead'] ? 'capability.public-read-allowed' : 'boolean.denied',
      )}`,
    )
  if (capabilities.subagent !== undefined)
    lines.push(
      `${t('capability.subagent')}: ${t(capabilities.subagent ? 'boolean.allowed' : 'boolean.denied')}`,
    )
  for (const service of capabilities.services ?? []) {
    lines.push(
      t('capability.service', { name: service.name, kind: service.kind, timeoutMs: service.timeoutMs }),
    )
  }
  for (const projection of capabilities.projections ?? []) {
    lines.push(
      t('capability.projection', {
        name: projection.name,
        inputs: projection.inputEventTypes.join(t('list.separator')),
        maxStateBytes: projection.maxStateBytes,
      }),
    )
  }
  return lines
}

function contributionLines(
  contribution: PackageContributionSummary,
  t: LocaleTranslator,
  adminText: LocaleTranslator,
): string[] {
  const contributionKey = `contribution.${contribution.kind}`
  const translatedKind = adminText(contributionKey)
  const kind = translatedKind === contributionKey ? contribution.kind : translatedKind
  const lines = [`${kind} · ${contribution.id}`]
  switch (contribution.kind) {
    case 'client':
      return [
        ...lines,
        t('contribution.description', { value: contribution.path }),
        t('contribution.backend-row', { value: contribution.rowId }),
        ...('client' in contribution
          ? [t('contribution.browser-entry', { value: contribution.client.entry })]
          : []),
        ...('client' in contribution && contribution.client.services?.length
          ? [t('contribution.services', { services: contribution.client.services.join(t('list.separator')) })]
          : []),
      ]
    case 'extension': {
      lines.push(
        t('contribution.entry', { value: contribution.path }),
        t('contribution.api-range', { value: contribution.apiRange }),
      )
      if (contribution.runtimeSupports?.length)
        lines.push(
          t('contribution.run-mode', { modes: contribution.runtimeSupports.join(t('list.separator')) }),
        )
      const declared = capabilityLines(contribution.capabilities, t)
      lines.push(...(declared.length ? declared : [t('contribution.no-declared-capabilities')]))
      const clientSlots = contribution.client?.slots ?? []
      if (clientSlots.length) {
        lines.push(t('contribution.client-slots', { slots: clientSlots.join(t('list.separator')) }))
        const unsupported = clientSlots.filter((slot) => !isWebClientModuleSlotName(slot))
        if (unsupported.length)
          lines.push(t('contribution.unsupported-slots', { slots: unsupported.join(t('list.separator')) }))
      }
      return lines
    }
    case 'seam':
      return [
        ...lines,
        t('contribution.entry', { value: contribution.path }),
        t('contribution.api-range', { value: contribution.apiRange }),
        t('contribution.provides', { value: contribution.provides.join(t('list.separator')) }),
      ]
    case 'provider':
    case 'runtime':
      return [
        ...lines,
        t('contribution.entry', { value: contribution.path }),
        t('contribution.api-range', { value: contribution.apiRange }),
      ]
    case 'skill':
    case 'preset':
      return [...lines, t('contribution.entry', { value: contribution.path })]
    case 'surface': {
      const { descriptor } = contribution
      const artifact =
        descriptor.artifact.kind === 'node' ? descriptor.artifact.entry : descriptor.artifact.image
      return [
        ...lines,
        t('contribution.surface', { value: descriptor.id }),
        t('contribution.api-range', { value: descriptor.apiRange }),
        t('contribution.artifact', { kind: descriptor.artifact.kind, value: artifact }),
        t('contribution.health-check', { value: descriptor.healthPath }),
        ...(descriptor.requires.services.length
          ? descriptor.requires.services.map((grant) =>
              t('contribution.required-service', { value: serviceGrant(grant) }),
            )
          : [t('contribution.no-required-services')]),
      ]
    }
  }
}

function Contributions({
  values,
  t,
  adminText,
}: {
  values: readonly PackageContributionSummary[]
  t: LocaleTranslator
  adminText: LocaleTranslator
}): JSX.Element {
  if (!values.length) {
    return <TextList items={[]} empty={t('empty.contributions')} />
  }
  return (
    <ul className="confirm-contributions">
      {values.map((contribution) => (
        <li
          key={`${contribution.kind}:${contribution.id}:${contributionLines(contribution, t, adminText).join('|')}`}
        >
          {contributionLines(contribution, t, adminText).map((line) => (
            <p key={line}>{line}</p>
          ))}
        </li>
      ))}
    </ul>
  )
}

function Blockers({
  values,
  t,
  adminText,
}: {
  values: readonly PackageBlocker[]
  t: LocaleTranslator
  adminText: LocaleTranslator
}): JSX.Element {
  return (
    <TextList items={values.map((blocker) => blockerText(blocker, adminText))} empty={t('empty.blockers')} />
  )
}

function CapabilityDiff({ preview, t }: { preview: PackagePreview; t: LocaleTranslator }): JSX.Element {
  const diff = preview.capabilityDiff
  const changes = [
    ...diff.added.map((item) => t('diff.added', { item })),
    ...diff.removed.map((item) => t('diff.removed', { item })),
    ...diff.runtimeSupportRemoved.map((item) => t('diff.runtime-removed', { item })),
    ...diff.dependenciesAdded.map((item) => t('diff.dependency-added', { item })),
    ...diff.serviceGrantsAdded.map((item) => t('diff.service-added', { value: serviceGrant(item) })),
  ]
  return <TextList items={changes} empty={t('empty.capability-diff')} />
}

function Dependencies({
  entries,
  t,
}: {
  entries: Readonly<Record<string, string>>
  t: LocaleTranslator
}): JSX.Element {
  return (
    <TextList
      items={Object.entries(entries).map(([name, range]) => `${name} · ${range}`)}
      empty={t('empty.dependencies')}
    />
  )
}

function Warnings({ preview, t }: { preview: PackagePreview; t: LocaleTranslator }): JSX.Element {
  return (
    <TextList
      items={preview.warnings.map((warning) =>
        t('warning.label', { code: warning.code, message: warning.safeMessage }),
      )}
      empty={t('empty.warnings')}
    />
  )
}

/** Renders the exact preview DTO as inert text nodes before an install or update is confirmed. */
export function PreviewConfirmationFacts({ preview }: { preview: PackagePreview }): JSX.Element {
  const { locale, t } = useUiText(ADMIN_CONFIRMATION_LOCALE_NAMESPACE, adminConfirmationLocaleCatalog)
  const { t: adminText } = useUiText(ADMIN_LOCALE_NAMESPACE, adminLocaleCatalog)
  return (
    <>
      <p className="confirm-facts-lead">{t('lead.preview')}</p>
      <FactsList
        items={[
          [t('fact.version'), preview.version],
          [t('fact.source'), sourceLabel(preview.source, adminText)],
          [t('fact.integrity'), preview.integrity],
          [t('fact.capability-hash'), preview.capabilityHash ?? t('value.not-reported-cannot-trust')],
          [t('fact.license'), preview.license],
          [
            t('fact.provenance-signature'),
            t(preview.provenance.signatureVerified ? 'value.verified' : 'value.unverified'),
          ],
        ]}
      />
      <ReviewSection title={t('section.provenance')}>
        <FactsList
          items={[
            [t('fact.provenance-source'), sourceLabel(preview.provenance.source, adminText)],
            [t('fact.provenance-integrity'), preview.provenance.integrity],
            [
              t('fact.release-time'),
              preview.provenance.releasedAt
                ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
                    new Date(preview.provenance.releasedAt),
                  )
                : t('value.not-reported'),
            ],
            [
              t('fact.signature-verification'),
              t(preview.provenance.signatureVerified ? 'value.verified' : 'value.unverified'),
            ],
          ]}
        />
      </ReviewSection>
      <ReviewSection title={t('section.reported-contributions')}>
        <Contributions values={preview.contributions} t={t} adminText={adminText} />
      </ReviewSection>
      <ReviewSection title={t('section.capability-diff')}>
        <CapabilityDiff preview={preview} t={t} />
      </ReviewSection>
      <ReviewSection title={t('section.dependencies-license')}>
        <FactsList items={[[t('fact.license'), preview.license]]} />
        <Dependencies entries={preview.dependencies} t={t} />
      </ReviewSection>
      <ReviewSection title={t('section.warnings-blockers')}>
        <Warnings preview={preview} t={t} />
        <Blockers values={preview.blockers} t={t} adminText={adminText} />
      </ReviewSection>
    </>
  )
}

/** Renders the installed DTO that will be bound by a trust decision. */
export function TrustConfirmationFacts({
  item,
  lead,
  leadKey = 'lead.trust',
}: {
  item: PackageInstalledDescriptor
  lead?: string
  leadKey?: 'lead.trust' | 'lead.trust-enable'
}): JSX.Element {
  const { t } = useUiText(ADMIN_CONFIRMATION_LOCALE_NAMESPACE, adminConfirmationLocaleCatalog)
  const { t: adminText } = useUiText(ADMIN_LOCALE_NAMESPACE, adminLocaleCatalog)
  return (
    <>
      <p className="confirm-facts-lead">{lead ?? t(leadKey)}</p>
      <FactsList
        items={[
          [t('fact.version'), item.version],
          [t('fact.source'), sourceLabel(item.source, adminText)],
          [t('fact.integrity'), item.integrity],
          [t('fact.capability-hash'), item.capabilityHash ?? t('value.not-reported')],
        ]}
      />
      <ReviewSection title={t('section.trust-contributions')}>
        <Contributions values={item.contributions} t={t} adminText={adminText} />
      </ReviewSection>
      <ReviewSection title={t('section.current-blockers')}>
        <Blockers values={item.blockers} t={t} adminText={adminText} />
      </ReviewSection>
    </>
  )
}

/** Renders the immutable baselines that make a trust revocation race-safe. */
export function UntrustConfirmationFacts({ item }: { item: PackageInstalledDescriptor }): JSX.Element {
  const { t } = useUiText(ADMIN_CONFIRMATION_LOCALE_NAMESPACE, adminConfirmationLocaleCatalog)
  const { t: adminText } = useUiText(ADMIN_LOCALE_NAMESPACE, adminLocaleCatalog)
  return (
    <>
      <p className="confirm-facts-lead">{t('lead.untrust')}</p>
      <FactsList
        items={[
          [t('fact.version'), item.version],
          [t('fact.source'), sourceLabel(item.source, adminText)],
          [t('fact.integrity'), item.integrity],
          [t('fact.capability-hash'), item.capabilityHash ?? t('value.not-reported')],
        ]}
      />
      <ReviewSection title={t('section.revoked-contributions')}>
        <Contributions values={item.contributions} t={t} adminText={adminText} />
      </ReviewSection>
      <ReviewSection title={t('section.current-blockers')}>
        <Blockers values={item.blockers} t={t} adminText={adminText} />
      </ReviewSection>
    </>
  )
}

/** Shows both immutable baselines bound by an atomic update-and-activate confirmation. */
export function UpdateActivationFacts({
  installed,
  preview,
}: {
  installed: PackageInstalledDescriptor
  preview: PackagePreview
}): JSX.Element {
  const { t } = useUiText(ADMIN_CONFIRMATION_LOCALE_NAMESPACE, adminConfirmationLocaleCatalog)
  return (
    <>
      <PreviewConfirmationFacts preview={preview} />
      <ReviewSection title={t('section.current-baseline')}>
        <FactsList
          items={[
            [t('fact.current-install-version'), installed.version],
            [t('fact.current-install-integrity'), installed.integrity],
            [t('fact.current-runtime-version'), installed.actualVersion ?? t('fact.not-confirmed')],
            [
              t('fact.current-runtime-integrity'),
              installed.actualIntegrity ??
                (installed.actual === 'not-running' ? t('fact.not-running') : t('fact.not-confirmed')),
            ],
            [t('fact.target-trust-integrity'), preview.integrity],
            [
              t('fact.target-capability-hash'),
              preview.capabilityHash ?? t('value.not-reported-cannot-activate'),
            ],
          ]}
        />
      </ReviewSection>
    </>
  )
}

/** Shows the verified rollback target and current baselines without exposing internal tree hashes. */
export function RollbackActivationFacts({
  installed,
}: {
  installed: PackageInstalledDescriptor
}): JSX.Element {
  const { t } = useUiText(ADMIN_CONFIRMATION_LOCALE_NAMESPACE, adminConfirmationLocaleCatalog)
  const { t: adminText } = useUiText(ADMIN_LOCALE_NAMESPACE, adminLocaleCatalog)
  const target = installed.rollbackTarget
  return (
    <>
      <p className="confirm-facts-lead">{t('lead.rollback')}</p>
      <FactsList
        items={[
          [t('fact.current-install-version'), installed.version],
          [t('fact.current-install-integrity'), installed.integrity],
          [t('fact.current-runtime-version'), installed.actualVersion ?? t('fact.not-confirmed')],
          [
            t('fact.current-runtime-integrity'),
            installed.actualIntegrity ??
              (installed.actual === 'not-running' ? t('fact.not-running') : t('fact.not-confirmed')),
          ],
          [t('fact.rollback-target-version'), target?.version ?? t('fact.rollback-target-missing')],
          [t('fact.rollback-target-integrity'), target?.integrity ?? t('fact.rollback-target-missing')],
          [t('fact.target-capability-hash'), target?.capabilityHash ?? t('fact.rollback-target-missing')],
        ]}
      />
      <ReviewSection title={t('section.rollback-blockers')}>
        <Blockers values={installed.blockers} t={t} adminText={adminText} />
      </ReviewSection>
    </>
  )
}
