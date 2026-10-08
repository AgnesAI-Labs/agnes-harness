import type { RuntimeSecurityStatus } from '@agnes/protocol'
import { Badge, SettingsDetails, SettingsList, SettingsRow, SettingsState } from '@agnes/web-ui'

type Text = (key: string) => string
export function SecurityStatusPanel({ status, t }: { status: RuntimeSecurityStatus | undefined; t: Text }) {
  if (!status)
    return (
      <SettingsState tone="empty" data-testid="sandbox-status-unavailable">
        {t('securityUnavailable')}
      </SettingsState>
    )
  const choice = (id: string) => {
    const text = t(`choice.${id}`)
    return text === `choice.${id}` ? id : text
  }
  const provider = (id: string) => {
    const text = t(`providerName.${id}`)
    return text === `providerName.${id}` ? id : text
  }
  const scopes = (values: readonly string[]) =>
    values
      .map((scope) =>
        t(`securityScope.${scope}`) === `securityScope.${scope}` ? scope : t(`securityScope.${scope}`),
      )
      .join(' · ')
  return (
    <section data-testid="sandbox-security-status">
      <h3>{t('platformProbe')}</h3>
      <p>
        {t(`platform.${status.platform.os}`) === `platform.${status.platform.os}`
          ? status.platform.os
          : t(`platform.${status.platform.os}`)}{' '}
        <Badge tone={status.platform.l1.level === 'full' ? 'ok' : 'warn'}>
          {t(`enforcement.${status.platform.l1.level}`)}
        </Badge>{' '}
        {scopes(status.platform.l1.scope) || '—'}
      </p>
      {status.platform.l1.reason && <p>{t('securityProbeIssue')}</p>}
      <p>{t('probeHelp')}</p>
      <h3>{t('permissionRequirements')}</h3>
      <section
        className="runtime-table-scroll"
        aria-label={t('permissionRequirements')}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need to scroll the wide permission table.
        tabIndex={0}
      >
        <table data-testid="permission-preset-status">
          <thead>
            <tr>
              <th>{t('presets')}</th>
              <th>{t('sandboxLevel')}</th>
              <th>{t('required')}</th>
              <th>{t('onUnavailable')}</th>
              <th>{t('approvalPolicy')}</th>
              <th>{t('commandNetwork')}</th>
            </tr>
          </thead>
          <tbody>
            {status.presetPolicies.map((preset) => (
              <tr key={preset.id}>
                <td>{choice(preset.id)}</td>
                <td>{preset.level}</td>
                <td>{t(preset.required ? 'yes' : 'no')}</td>
                <td>{t(preset.onUnavailable)}</td>
                <td>{provider(preset.approvalPolicy)}</td>
                <td>{t(`network.${preset.networkMode}`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <h3>{t('workspacePosture')}</h3>
      {!status.workspaces.length ? (
        <p>{t('noWorkspacePosture')}</p>
      ) : (
        <SettingsList>
          {status.workspaces.map((workspace) => (
            <SettingsRow
              key={workspace.sessionId}
              data-testid="workspace-sandbox-status"
              title={workspace.path}
            >
              <dl>
                <dt>{t('workspace')}</dt>
                <dd>{workspace.path}</dd>
                <dt>{t('presets')}</dt>
                <dd>{choice(workspace.preset)}</dd>
                <dt>{t('sandboxProvider')}</dt>
                <dd>{provider(workspace.provider)}</dd>
                <dt>{t('readiness')}</dt>
                <dd>{t(`readiness.${workspace.state}`)}</dd>
                <dt>{t('enforcement')}</dt>
                <dd>
                  <span data-testid="workspace-enforcement">
                    {workspace.enforcement ? (
                      <>
                        <Badge tone={workspace.enforcement.level === 'full' ? 'ok' : 'warn'}>
                          {t(`enforcement.${workspace.enforcement.level}`)}
                        </Badge>{' '}
                        {scopes(workspace.enforcement.scope) || '—'}
                      </>
                    ) : (
                      t('unmeasured')
                    )}
                  </span>
                </dd>
              </dl>
              <SettingsDetails title={t('technicalDetails')}>
                <dl>
                  <dt>{t('sessionKey')}</dt>
                  <dd>
                    <code>{workspace.sessionId}</code>
                  </dd>
                  <dt>{t('policyDigest')}</dt>
                  <dd>
                    <code>{workspace.policyDigest ?? '—'}</code>
                  </dd>
                </dl>
              </SettingsDetails>
            </SettingsRow>
          ))}
        </SettingsList>
      )}
    </section>
  )
}
