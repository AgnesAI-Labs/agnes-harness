import { pluginFailureHelp, type PluginCapabilities } from '@agnes/protocol'

type Text = (key: string) => string

export function CapabilityReview({ value, t }: { value: PluginCapabilities | undefined; t: Text }) {
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
      {advice.fixHint}{' '}
      <a href={advice.docsUrl} target="_blank" rel="noreferrer">
        {t('capability.docs')}
      </a>
    </p>
  )
}
