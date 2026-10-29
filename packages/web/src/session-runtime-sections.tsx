import { AGNES_ERRORS, type SessionApprovalGrant, type SessionToolsResult } from '@agnes/protocol'
import type { Translate } from '@agnes/web-conversation/presentation'
import {
  Button,
  Icon,
  ListRow,
  MetaText,
  SettingsDetails,
  SettingsList,
  SettingsSection,
  SettingsState,
  Tag,
} from '@agnes/web-ui'

type Tool = SessionToolsResult['tools'][number]
/**
 * Undefined while the daemon has not answered. A failed read says why: `denied` when this viewer may
 * not list them, `unavailable` when the read itself failed. Neither means there are none.
 */
export type SessionGrants =
  | readonly SessionApprovalGrant[]
  | { failed: 'denied' | 'unavailable'; retries: number }
  | undefined
/** Manual retries offered for a temporary failure before the dialog asks to come back later. */
export const GRANT_RETRY_LIMIT = 3

/** A refusal (no right to read this session's grants) is told apart from a read that failed. */
export function grantsFailure(error: unknown): 'denied' | 'unavailable' {
  const code = (error as { code?: unknown } | null)?.code
  return code === AGNES_ERRORS.CAPABILITY_DENIED ||
    code === AGNES_ERRORS.AUTH_INVALID ||
    code === AGNES_ERRORS.CLAIM_DENIED
    ? 'denied'
    : 'unavailable'
}

/** Session allowances lead, then standing ones; newest first within each. */
export const orderGrants = (grants: readonly SessionApprovalGrant[]): SessionApprovalGrant[] =>
  grants
    .filter((grant) => !grant.revokedAt)
    .sort(
      (a, b) =>
        Number(a.lifetime === 'always') - Number(b.lifetime === 'always') ||
        b.createdAt.localeCompare(a.createdAt),
    )

const when = (iso: string) => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(document.documentElement.lang || 'en', { dateStyle: 'medium', timeStyle: 'short' })
}

/** What this session may do without asking: for this session only, or always. Each has its own undo. */
export function SessionGrantList({
  grants,
  revoking,
  onRevoke,
  onRetry,
  t,
}: {
  grants: SessionGrants
  revoking?: string | undefined
  onRevoke(grant: SessionApprovalGrant): void
  onRetry?: (() => void) | undefined
  t: Translate
}) {
  return (
    <SettingsSection
      title={t('session.runtime.grants')}
      description={t('session.runtime.grantsHelp')}
      data-testid="session-runtime-grants"
    >
      {grants === undefined ? (
        <SettingsState tone="loading">{t('session.runtime.grantsLoading')}</SettingsState>
      ) : 'failed' in grants ? (
        <SettingsState tone="error" role="alert" data-testid="session-runtime-grants-failed">
          <p>
            {t(
              grants.failed === 'denied'
                ? 'session.runtime.grantsDenied'
                : grants.retries >= GRANT_RETRY_LIMIT
                  ? 'session.runtime.grantsLater'
                  : 'session.runtime.grantsUnavailable',
            )}
          </p>
          {grants.failed === 'unavailable' && onRetry && grants.retries < GRANT_RETRY_LIMIT ? (
            <Button size="small" data-testid="session-runtime-grants-retry" onClick={onRetry}>
              {t('session.runtime.grantsRetry')}
            </Button>
          ) : null}
        </SettingsState>
      ) : grants.length === 0 ? (
        <SettingsState>{t('session.runtime.grantsEmpty')}</SettingsState>
      ) : (
        <SettingsList>
          {grants.map((grant) => {
            const always = grant.lifetime === 'always'
            return (
              <ListRow
                key={grant.grantId}
                data-testid="session-runtime-grant"
                data-lifetime={grant.lifetime}
                icon={<Icon name="shield-check" size={16} />}
                title={<code translate="no">{grant.toolId}</code>}
                titleLabel={grant.toolId}
                description={t(
                  always ? 'session.runtime.grantAlwaysHelp' : 'session.runtime.grantSessionHelp',
                  {
                    time: when(grant.createdAt),
                  },
                )}
                status={
                  <Tag tone={always ? 'warn' : 'info'}>
                    {t(always ? 'session.runtime.grantAlways' : 'session.runtime.grantSession')}
                  </Tag>
                }
                actions={
                  <Button
                    size="small"
                    data-testid="session-runtime-grant-revoke"
                    loading={revoking === grant.grantId}
                    disabled={revoking !== undefined}
                    aria-label={t(
                      always ? 'session.runtime.grantRevokeAlwaysLabel' : 'session.runtime.grantRevokeLabel',
                      { tool: grant.toolId },
                    )}
                    onClick={() => onRevoke(grant)}
                  >
                    {t('session.runtime.grantRevoke')}
                  </Button>
                }
              />
            )
          })}
        </SettingsList>
      )}
    </SettingsSection>
  )
}

type ToolGroup = { source: string; tools: Tool[]; deferred: number }
const PREVIEW = 5

export function groupTools(tools: readonly Tool[]): ToolGroup[] {
  const groups = new Map<string, Tool[]>()
  for (const tool of tools) groups.set(tool.source, [...(groups.get(tool.source) ?? []), tool])
  return [...groups].map(([source, list]) => ({
    source,
    tools: list,
    deferred: list.filter((tool) => tool.deferred).length,
  }))
}

/** The tools this session can call right now, by where they come from. */
export function SessionToolList({
  tools,
  failed,
  busy,
  onRefresh,
  t,
}: {
  tools: SessionToolsResult | undefined
  failed: boolean
  busy: boolean
  onRefresh(): void
  t: Translate
}) {
  const count = tools?.tools.length
  const states = new Map(tools?.capabilities?.tools.map((item) => [item.id, item.enabled]))
  return (
    <SettingsSection
      title={count === undefined ? t('session.runtime.tools') : t('session.runtime.toolsCount', { count })}
      actions={
        <Button
          appearance="ghost"
          size="small"
          data-testid="session-runtime-tools-refresh"
          loading={busy}
          disabled={busy}
          onClick={onRefresh}
        >
          {t('session.runtime.refresh')}
        </Button>
      }
      data-testid="session-runtime-tools"
    >
      {failed ? (
        <SettingsState tone="error">{t('session.runtime.toolsUnavailable')}</SettingsState>
      ) : !tools ? (
        <SettingsState tone="loading">{t('session.runtime.toolsLoading')}</SettingsState>
      ) : tools.tools.length === 0 ? (
        <SettingsState>{t('session.runtime.toolsEmpty')}</SettingsState>
      ) : (
        <SettingsList className="session-runtime-tool-groups">
          {groupTools(tools.tools).map((group) => (
            <ListRow
              key={group.source}
              data-testid="session-runtime-tool-group"
              icon={<Icon name="terminal" size={16} />}
              title={
                <span translate="no">
                  {group.tools
                    .slice(0, PREVIEW)
                    .map((tool) => tool.name)
                    .join(' · ')}
                  {group.tools.length > PREVIEW ? ' …' : ''}
                </span>
              }
              description={[
                t('session.runtime.toolsFrom', { source: group.source, count: group.tools.length }),
                // Deferred tools reach the model only after tool_search finds and loads them.
                ...(group.deferred ? [t('session.runtime.toolsDeferred', { count: group.deferred })] : []),
              ].join(' · ')}
            >
              {group.tools.length > PREVIEW && (
                <SettingsDetails compact title={t('session.runtime.toolsAll')}>
                  <ul className="session-runtime-tools">
                    {group.tools.map((tool) => (
                      <li key={tool.name}>
                        <code translate="no">{tool.name}</code>
                        {states.get(tool.name) === false && (
                          <MetaText>{t('session.runtime.toolDisabled')}</MetaText>
                        )}
                        {tool.readOnly && <MetaText>{t('session.runtime.toolReadOnly')}</MetaText>}
                        {tool.deferred && <MetaText>{t('session.runtime.toolDeferred')}</MetaText>}
                      </li>
                    ))}
                  </ul>
                </SettingsDetails>
              )}
            </ListRow>
          ))}
        </SettingsList>
      )}
    </SettingsSection>
  )
}
