import type { SkillImportResult } from '@agnes/protocol'
import { ListRow, SettingsList, SettingsState } from '@agnes/web-ui'

type Text = (key: string, vars?: Readonly<Record<string, string | number>>) => string
export const externalIssueText = (code: string, t: Text) => {
  for (const prefix of ['skill.import.reason.', 'mcp.import.error.']) {
    const key = prefix + code,
      value = t(key)
    if (value !== key) return value
  }
  return code
}

export function ExternalOperationResult({
  activation,
  t,
}: {
  activation: SkillImportResult['activation']
  t: Text
}) {
  if (!activation?.outcomes?.length) return null
  const success = activation.outcomes.filter((row) => row.status === 'succeeded').length
  return (
    <section data-testid="external-operation-results">
      <h3>{t('external.results')}</h3>
      <SettingsState>
        {t(
          activation.outcomes.length < activation.resources.length
            ? 'external.results.progress'
            : success === activation.resources.length
              ? 'external.results.complete'
              : success
                ? 'external.results.partial'
                : 'external.results.failed',
          { success, total: activation.resources.length },
        )}
      </SettingsState>
      <SettingsList>
        {activation.outcomes.map((row) => (
          <ListRow
            key={row.resourceId}
            title={
              activation.resources.find((member) => member.resourceId === row.resourceId)?.name ??
              row.resourceId
            }
            meta={t(`external.outcome.${row.status}`)}
            description={row.code ? externalIssueText(row.code, t) : undefined}
          />
        ))}
      </SettingsList>
    </section>
  )
}
