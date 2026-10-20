import {
  type PackagePreview,
  type PackageProvenance,
  type PluginCapabilities,
  pluginFailureHelp,
} from '@agnes/protocol'
import { SettingsCode, useDocumentLanguage, useUiText } from '@agnes/web-ui'
import { PLUGIN_ADMIN_LOCALE_NAMESPACE, pluginAdminLocaleCatalog } from './locales/admin.js'

type Text = (key: string) => string

/** Each capability a package declares, as one line of plain words. */
export function capabilityRequests(value: PluginCapabilities | undefined, t: Text): string[] {
  return value
    ? [
        ...(['network', 'exec', 'secrets', 'credentials'] as const).flatMap((key) =>
          (value[key] ?? []).map((scope) => `${t('capability.' + key)}: ${scope}`),
        ),
        ...(['read', 'write'] as const).flatMap((key) =>
          (value.filesystem?.[key] ?? []).map((scope) => `${t('capability.' + key)}: ${scope}`),
        ),
        ...(['model', 'childAgents', 'ui'] as const)
          .filter((key) => value[key])
          .map((key) => t('capability.' + key)),
      ]
    : []
}

export function CapabilityReview({
  value,
  preflight,
  t,
}: {
  value: PluginCapabilities | undefined
  preflight?: PackagePreview['preflight']
  t: Text
}) {
  useUiText(PLUGIN_ADMIN_LOCALE_NAMESPACE, pluginAdminLocaleCatalog)
  const requests = capabilityRequests(value, t)
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

export function ProvenanceReview({ value, t }: { value: PackageProvenance | undefined; t: Text }) {
  const language = useDocumentLanguage()
  const local =
    ['local-folder', 'local-file', 'workspace'].includes(value?.sourceKind ?? '') ||
    ['file', 'local', 'workspace', 'path'].includes(value?.source.type ?? '')
  const installedAt = value?.installedAt && new Date(value.installedAt)
  return (
    <section aria-label={t('provenance.title')}>
      <h3>{t('provenance.title')}</h3>
      <p>{t(value?.signatureVerified ? 'provenance.verified' : 'provenance.unverified')}</p>
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
