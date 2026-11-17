import {
  type PackagePreview,
  type PackageProvenance,
  type PluginCapabilities,
  pluginFailureHelp,
} from '@agnes/protocol'
import { SettingsCode, useDocumentLanguage, useUiText } from '@agnes/web-ui'
import { PLUGIN_ADMIN_LOCALE_NAMESPACE, pluginAdminLocaleCatalog } from './locales/admin.js'

type Text = (key: string) => string

/** A named list on one review line. `short` keeps the first four names and the count; use it only for
 * lists the review's technical details print in full. */
function named(label: string, names: readonly string[], short = true): string {
  return short && names.length > 4
    ? `${label} (${names.length}): ${names.slice(0, 4).join(', ')}, …`
    : `${label}: ${names.join(', ')}`
}

/** Declared switches, each one line under its review label. */
const SWITCHES = [
  ['model', 'model'],
  ['childAgents', 'childAgents'],
  ['ui', 'ui'],
  ['store', 'store'],
  ['device', 'device'],
  ['events', 'events'],
  ['tools.invoke', 'invoke'],
  ['network.publicRead', 'publicRead'],
  ['artifacts', 'artifacts'],
  ['subagent', 'subagent'],
  ['sessionWork', 'sessionWork'],
  ['autoTitle', 'autoTitle'],
  ['wake', 'wake'],
] as const satisfies readonly (readonly [keyof PluginCapabilities, string])[]

/** Each capability a package declares, as one line of plain words. Every manifest capability has a
 * line. Long tool, hook, slot, resource, service and projection lists show four names and the count;
 * the technical details list those in full. UI data and stream names are always listed in full. */
export function capabilityRequests(value: PluginCapabilities | undefined, t: Text): string[] {
  if (!value) return []
  const label = (key: string) => t(`capability.${key}`)
  const services = (profile: boolean) =>
    (value.services ?? []).filter((service) => (service.scope === 'profile') === profile).map((s) => s.name)
  return [
    ...(['network', 'exec', 'secrets', 'credentials'] as const).flatMap((key) =>
      (value[key] ?? []).map((scope) => `${label(key)}: ${scope}`),
    ),
    ...(['read', 'write'] as const).flatMap((key) =>
      (value.filesystem?.[key] ?? []).map((scope) => `${label(key)}: ${scope}`),
    ),
    ...SWITCHES.filter(([key]) => value[key] === true).map(([, key]) => label(key)),
    ...(value.tools
      ? [
          value.tools.names?.length
            ? named(label('tools'), value.tools.names)
            : `${label('tools')}: ${value.tools.prefix}*`,
        ]
      : []),
    ...(['hooks', 'slots', 'resources', 'uiData'] as const)
      .filter((key) => value[key]?.length)
      .map((key) => named(label(key), value[key] ?? [], key !== 'uiData')),
    ...(services(true).length ? [named(label('profileServices'), services(true))] : []),
    ...(services(false).length ? [named(label('services'), services(false))] : []),
    ...(['projections', 'streams'] as const)
      .filter((key) => value[key]?.length)
      .map((key) =>
        named(
          label(key),
          (value[key] ?? []).map((item) => item.name),
          key === 'projections',
        ),
      ),
    ...(value.managedServices ?? []).map((service) => `${label('managedService')}: ${service.id}`),
    ...(value.managedServices?.some((service) => service.sessions === true)
      ? [t('capability.sessions')]
      : []),
    ...(value.managedServices?.some((service) => service.channelTargets === true)
      ? [t('capability.channelTargets')]
      : []),
  ]
}

export function CapabilityReview({
  value,
  preflight,
  ownerApplication = false,
  t,
}: {
  value: PluginCapabilities | undefined
  preflight?: PackagePreview['preflight']
  /** The Host proved the shipped copy whose release grants the bundled-application runtime. */
  ownerApplication?: boolean
  t: Text
}) {
  useUiText(PLUGIN_ADMIN_LOCALE_NAMESPACE, pluginAdminLocaleCatalog)
  const requests = [
    ...capabilityRequests(value, t),
    ...(ownerApplication ? [t('capability.ownerApplication')] : []),
  ]
  return (
    <section aria-label={t('capability.title')}>
      <h3>{t('capability.title')}</h3>
      {requests.length ? (
        <ul>
          {requests.map((request) => (
            <li key={request}>{request}</li>
          ))}
        </ul>
      ) : (
        <p>{t(value === undefined ? 'capability.undeclared' : 'capability.none')}</p>
      )}
      <p>{t('capability.community')}</p>
      {preflight && (
        <p data-testid="package-preflight">
          {t(`preflight.${preflight.level}`)} · {t(`preflight.next.${preflight.next}`)}
        </p>
      )}
    </section>
  )
}

export function FailureHelp({ reason, t }: { reason: string; t: Text }) {
  const advice = pluginFailureHelp(reason)
  return (
    <p className="resource-safe-error">
      {t('failure.repair')}{' '}
      <a href={advice.docsUrl} target="_blank" rel="noreferrer">
        {t('capability.docs')}
      </a>
    </p>
  )
}

export function ProvenanceReview({
  value,
  bundled = false,
  t,
}: {
  value: PackageProvenance | undefined
  /** The Host proved this is the copy shipped with this AGH; shown apart from publisher evidence. */
  bundled?: boolean
  t: Text
}) {
  const language = useDocumentLanguage()
  const local =
    ['local-folder', 'local-file', 'workspace'].includes(value?.sourceKind ?? '') ||
    ['file', 'local', 'workspace', 'path'].includes(value?.source.type ?? '')
  const installedAt = value?.installedAt && new Date(value.installedAt)
  return (
    <section aria-label={t('provenance.title')}>
      <h3>{t('provenance.title')}</h3>
      {bundled && <p data-testid="provenance-bundled">{t('provenance.bundled')}</p>}
      <p>
        {t(
          value?.signatureVerified
            ? 'provenance.verified'
            : bundled
              ? 'provenance.bundledSignature'
              : 'provenance.unverified',
        )}
      </p>
      {value?.authoring && (
        <a
          data-testid="plugin-fact-chain"
          href={`/?session=${encodeURIComponent(value.authoring.origin.sessionKey)}&factCandidate=${encodeURIComponent(value.authoring.candidateId)}`}
        >
          {t('candidates.viewDrafting')}
        </a>
      )}
      {value && (
        <dl className="confirm-facts-list">
          <dt>{t('provenance.source')}</dt>
          <dd>
            {local
              ? language === 'zh-CN'
                ? '本地文件夹或文件'
                : 'Local folder or file'
              : language === 'zh-CN'
                ? '远程插件来源'
                : 'Remote plugin source'}{' '}
            · {value.resolvedLocation ?? value.source.ref}
          </dd>
          {value.publisher && (
            <>
              <dt>{t('provenance.publisher')}</dt>
              <dd>{value.publisher}</dd>
            </>
          )}
          <dt>{t('provenance.digest')}</dt>
          <dd>
            <SettingsCode label={t('provenance.digest')} copy={value.treeIntegrity ?? value.integrity}>
              {value.treeIntegrity ?? value.integrity}
            </SettingsCode>
          </dd>
          {value.installedAt && (
            <>
              <dt>{t('provenance.installed')}</dt>
              <dd>
                {installedAt && Number.isFinite(installedAt.getTime())
                  ? new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(
                      installedAt,
                    )
                  : value.installedAt}
              </dd>
            </>
          )}
        </dl>
      )}
    </section>
  )
}
