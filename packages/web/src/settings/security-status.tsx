import type { RuntimeSecurityStatus } from '@agnes/protocol'
import { Badge } from '@agnes/web-ui'

type Text = (key: string) => string
export function SecurityStatusPanel({ status, t }: { status: RuntimeSecurityStatus | undefined; t: Text }) {
  if (!status)
    return (
      <p role="status" data-testid="sandbox-status-unavailable">
        {t('securityUnavailable')}
      </p>
    )
  return (
    <section data-testid="sandbox-security-status">
      <h3>{t('platformProbe')}</h3>
      <p>
        {status.platform.os}{' '}
        <Badge tone={status.platform.l1.level === 'full' ? 'ok' : 'warn'}>
          {t(`enforcement.${status.platform.l1.level}`)}
        </Badge>{' '}
        {status.platform.l1.scope.join(', ') || '—'}
      </p>
      {status.platform.l1.reason && <p>{status.platform.l1.reason}</p>}
      <p>{t('probeHelp')}</p>
      <h3>{t('permissionRequirements')}</h3>
      <div className="runtime-table-scroll">
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
                <td>
                  <code>{preset.id}</code>
                </td>
                <td>{preset.level}</td>
                <td>{t(preset.required ? 'yes' : 'no')}</td>
                <td>{t(preset.onUnavailable)}</td>
                <td>{preset.approvalPolicy}</td>
                <td>{t(`network.${preset.networkMode}`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>{t('workspacePosture')}</h3>
      {!status.workspaces.length ? (
        <p>{t('noWorkspacePosture')}</p>
      ) : (
        status.workspaces.map((workspace) => (
          <article key={workspace.sessionId} className="runtime-card" data-testid="workspace-sandbox-status">
            <h4>
              <code>{workspace.sessionId}</code>
            </h4>
            <dl>
              <dt>{t('workspace')}</dt>
              <dd>{workspace.path}</dd>
              <dt>{t('presets')}</dt>
              <dd>{workspace.preset}</dd>
              <dt>{t('sandboxProvider')}</dt>
              <dd>{workspace.provider}</dd>
              <dt>{t('readiness')}</dt>
              <dd>{t(`readiness.${workspace.state}`)}</dd>
              <dt>{t('enforcement')}</dt>
              <dd>
                {workspace.enforcement ? (
                  <>
                    <Badge tone={workspace.enforcement.level === 'full' ? 'ok' : 'warn'}>
                      {t(`enforcement.${workspace.enforcement.level}`)}
                    </Badge>{' '}
                    {workspace.enforcement.scope.join(', ') || '—'}
                  </>
                ) : (
                  t('unmeasured')
                )}
              </dd>
              <dt>{t('policyDigest')}</dt>
              <dd>
                <code>{workspace.policyDigest ?? '—'}</code>
              </dd>
            </dl>
          </article>
        ))
      )}
    </section>
  )
}
