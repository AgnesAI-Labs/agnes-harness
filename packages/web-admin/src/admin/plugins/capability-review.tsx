import { type PackageProvenance, type PluginCapabilities, pluginFailureHelp } from '@agnes/protocol'
import { useUiText } from '@agnes/web-ui'
import { PLUGIN_ADMIN_LOCALE_NAMESPACE, pluginAdminLocaleCatalog } from './locales/admin.js'

type Text = (key: string) => string

export function CapabilityReview({ value, t }: { value: PluginCapabilities | undefined; t: Text }) {
  useUiText(PLUGIN_ADMIN_LOCALE_NAMESPACE, pluginAdminLocaleCatalog)
  const requests = value
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
  return (
    <section aria-label={t('provenance.title')}>
      <h3>{t('provenance.title')}</h3>
      <p>{t(value?.signatureVerified ? 'provenance.verified' : 'provenance.unverified')}</p>
      {value && (
        <dl>
          <dt>{t('provenance.source')}</dt>
          <dd>
            {value.sourceKind ?? value.source.type}: {value.resolvedLocation ?? value.source.ref}
          </dd>
          {value.publisher && (
            <>
              <dt>{t('provenance.publisher')}</dt>
              <dd>{value.publisher}</dd>
            </>
          )}
          <dt>{t('provenance.digest')}</dt>
          <dd>{value.treeIntegrity ?? value.integrity}</dd>
          {value.installedAt && (
            <>
              <dt>{t('provenance.installed')}</dt>
              <dd>
                {value.installedAt} · {value.installer}
              </dd>
            </>
          )}
        </dl>
      )}
    </section>
  )
}
