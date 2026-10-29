import type { RuntimeSecurityStatus } from '@agnes/protocol'
import {
  Banner,
  Button,
  SettingsBlock,
  SettingsDetails,
  SettingsDrill,
  SettingsItem,
  SettingsList,
  SettingsRow,
  SettingsState,
  SettingsTag,
  setSettingsNavAttention,
  useUiText,
} from '@agnes/web-ui'
import { useEffect } from 'react'

import { SECURITY_NAMESPACE, securityUxCatalog } from './security-locale.js'

type Text = (key: string) => string
type Policy = RuntimeSecurityStatus['presetPolicies'][number]
export function SecurityStatusPanel({
  status,
  t,
  view = 'status',
}: {
  status: RuntimeSecurityStatus | undefined
  t: Text
  /** `status` is the one-line state for the permissions page; `details` is the diagnostic record. */
  view?: 'status' | 'details'
}) {
  const { t: ux } = useUiText(SECURITY_NAMESPACE, securityUxCatalog)
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
  // Retained generations can report several postures for the same session, including identical ones.
  const occurrences = new Map<string, number>()
  const workspaces = status.workspaces.map((workspace) => {
    const identity = JSON.stringify([
      workspace.sessionId,
      workspace.path,
      workspace.preset,
      workspace.permission,
      workspace.provider,
      workspace.policyDigest,
    ])
    const occurrence = occurrences.get(identity) ?? 0
    occurrences.set(identity, occurrence + 1)
    return { workspace, key: `${identity}:${occurrence}` }
  })
  // A Host that reports permission levels apart lists them in their own table; an older one keeps
  // them among the presets, shown as before.
  const levels = status.permissionPolicies
  const policyTable = (testId: string, heading: string, column: string, rows: readonly Policy[]) => (
    <>
      <h4>{heading}</h4>
      <section
        className="runtime-table-scroll"
        aria-label={heading}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need to scroll the wide permission table.
        tabIndex={0}
      >
        <table data-testid={testId}>
          <thead>
            <tr>
              <th>{column}</th>
              <th>{t('sandboxLevel')}</th>
              <th>{t('required')}</th>
              <th>{t('onUnavailable')}</th>
              <th>{t('approvalPolicy')}</th>
              <th>{t('commandNetwork')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((policy) => (
              <tr key={policy.id}>
                <td>{choice(policy.id)}</td>
                <td>{policy.level}</td>
                <td>{t(policy.required ? 'yes' : 'no')}</td>
                <td>{t(policy.onUnavailable)}</td>
                <td>{provider(policy.approvalPolicy)}</td>
                <td>{t(`network.${policy.networkMode}`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  )
  if (view === 'details')
    return (
      <div data-testid="security-details">
        <p>{t('probeHelp')}</p>
        <h4>{t('platformProbe')}</h4>
        <p>
          {t(`enforcement.${status.platform.l1.level}`)} · {scopes(status.platform.l1.scope) || '—'}
          {status.platform.l1.reason ? ` · ${t('securityProbeIssue')}` : ''}
        </p>
        {status.platform.l1.reason && (
          <p>
            <code>{status.platform.l1.reason}</code>
          </p>
        )}
        {levels &&
          policyTable('permission-level-status', t('permissionRequirements'), t('permissionLevel'), levels)}
        {policyTable(
          'permission-preset-status',
          t(levels ? 'presetIsolationRequirements' : 'permissionRequirements'),
          t('presets'),
          status.presetPolicies,
        )}
        <h4>{t('workspacePosture')}</h4>
        {!status.workspaces.length ? (
          <p>{t('noWorkspacePosture')}</p>
        ) : (
          <SettingsList>
            {workspaces.map(({ workspace, key }) => (
              <SettingsRow key={key} data-testid="workspace-sandbox-status" title={workspace.path}>
                <dl>
                  <dt>{t('workspace')}</dt>
                  <dd>{workspace.path}</dd>
                  <dt>{t('presets')}</dt>
                  <dd>{choice(workspace.preset)}</dd>
                  {workspace.permission && (
                    <>
                      <dt>{t('permissionLevel')}</dt>
                      <dd data-testid="workspace-permission">{choice(workspace.permission)}</dd>
                    </>
                  )}
                  <dt>{t('sandboxProvider')}</dt>
                  <dd>{provider(workspace.provider)}</dd>
                  <dt>{t('readiness')}</dt>
                  <dd>{t(`readiness.${workspace.state}`)}</dd>
                  <dt>{t('enforcement')}</dt>
                  <dd>
                    <span data-testid="workspace-enforcement">
                      {workspace.provider === 'local' &&
                      workspace.enforcement &&
                      workspace.enforcement.level !== 'full' &&
                      !workspace.enforcement.scope.includes('process') ? (
                        t('noOsIsolation')
                      ) : workspace.enforcement ? (
                        <>
                          <span>{t(`enforcement.${workspace.enforcement.level}`)}</span>{' '}
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
      </div>
    )
  const level = status.platform.l1.level
  const tone =
    level === 'full' ? 'ok' : level === 'partial' ? 'warn' : level === 'unprobed' ? 'muted' : 'error'
  const all = ['file', 'process', 'network']
  const missing = all.filter((scope) => !status.platform.l1.scope.includes(scope as never))
  const value =
    level === 'full'
      ? scopes(status.platform.l1.scope)
      : level === 'partial'
        ? ux('missing', { list: scopes(missing) })
        : level === 'unprobed'
          ? ux('unprobedHelp')
          : ''
  const platform = t(`platform.${status.platform.os}`)
  return (
    <SettingsBlock label={ux('isolation')} data-testid="sandbox-security-status" data-level={level}>
      <NavAttention tone={tone} />
      <SettingsDrill
        id="isolation"
        data-testid="sandbox-isolation"
        label={ux('commandIsolation')}
        hint={platform}
        info={ux('isolationHelp')}
        title={ux('isolationDetails')}
        value={
          <>
            <SettingsTag
              tone={tone}
              data-testid={level === 'unprobed' ? 'sandbox-status-unprobed' : undefined}
            >
              {ux(`state.${level}`)}
            </SettingsTag>
            {value}
          </>
        }
      >
        {level === 'partial' && <Banner tone="warning">{ux('partialImpact')}</Banner>}
        {level === 'unavailable' && (
          <Banner
            tone="error"
            action={
              <Button
                appearance="ghost"
                size="small"
                href="https://github.com/AgnesAI-Labs/agnes-harness/blob/feat/agh-plugin-core/docs/guide/sandbox-providers.md"
              >
                {ux('protectionHelp')}
              </Button>
            }
          >
            {ux('partial')}
          </Banner>
        )}
        <SettingsBlock label={ux('thisComputer')} data-testid="security-platform">
          <SettingsItem label={ux('system')}>
            <span className="agnes-settings-value">{platform}</span>
          </SettingsItem>
          <SettingsItem label={ux('state')}>
            <SettingsTag tone={tone}>{ux(`state.${level}`)}</SettingsTag>
          </SettingsItem>
          <SettingsItem label={ux('scope')}>
            <span className="agnes-settings-value">{scopes(status.platform.l1.scope) || '—'}</span>
          </SettingsItem>
          <SettingsItem label={ux('reason')}>
            <span className="agnes-settings-value" title={status.platform.l1.reason}>
              {status.platform.l1.reason ? t('securityProbeIssue') : '—'}
            </span>
          </SettingsItem>
        </SettingsBlock>
        <SettingsBlock label={ux('perWorkspace')} data-testid="security-workspaces">
          {!status.workspaces.length && <SettingsItem label={t('noWorkspacePosture')} />}
          {workspaces.map(({ workspace, key }) => {
            const enforcement = workspace.enforcement?.level ?? 'unprobed'
            const workspaceTone =
              enforcement === 'full'
                ? 'ok'
                : enforcement === 'partial'
                  ? 'warn'
                  : enforcement === 'unprobed'
                    ? 'muted'
                    : 'error'
            return (
              <SettingsItem
                key={key}
                data-testid="workspace-sandbox-status"
                label={<span translate="no">{workspace.path}</span>}
                description={[
                  choice(workspace.preset),
                  workspace.permission && choice(workspace.permission),
                  provider(workspace.provider),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              >
                <span className="agnes-settings-value" data-testid="workspace-enforcement">
                  <SettingsTag tone={workspaceTone}>{ux(`state.${enforcement}`)}</SettingsTag>
                  {workspace.enforcement ? scopes(workspace.enforcement.scope) || '—' : ''}
                </span>
              </SettingsItem>
            )
          })}
        </SettingsBlock>
        <p className="agnes-settings-note">{ux('platformOnly')}</p>
      </SettingsDrill>
    </SettingsBlock>
  )
}

/** Yellow and red isolation states put a dot on Permissions and security in the navigation. */
function NavAttention({ tone }: { tone: string }) {
  useEffect(() => {
    const attention = tone === 'warn' ? 'warn' : tone === 'error' ? 'error' : undefined
    setSettingsNavAttention('security', attention)
    return () => setSettingsNavAttention('security', undefined)
  }, [tone])
  return null
}
