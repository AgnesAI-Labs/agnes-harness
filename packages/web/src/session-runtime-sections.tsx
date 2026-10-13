import type { ApprovalGrantRecord, SessionToolsResult } from '@agnes/protocol'
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
} from '@agnes/web-ui'

type Tool = SessionToolsResult['tools'][number]
export type GrantBinding = { toolId: string; scope: string; policyVersion: string }
/** Undefined while the daemon has not answered; `unavailable` when it does not manage grants here. */
export type SessionGrants = readonly ApprovalGrantRecord[] | 'unavailable' | undefined

const GRANT_LOOKUPS = 64
const GRANT_CONCURRENCY = 6

/**
 * The binding a tool gets when it declares no approval scope and no classifier of its own. Grants
 * are stored per exact binding and the daemon offers no per-session listing, so these are the
 * bindings a client can ask about.
 */
export const defaultGrantBinding = (toolId: string): GrantBinding => ({
  toolId,
  scope: `tool:${toolId}:execute`,
  policyVersion: 'static-v1',
})

/** Reads the remembered approvals of a session's tools; one refusal means the daemon keeps none here. */
export async function readSessionGrants(
  tools: readonly Pick<Tool, 'name'>[],
  list: (binding: GrantBinding) => Promise<{ grants: readonly ApprovalGrantRecord[] }>,
): Promise<Exclude<SessionGrants, undefined>> {
  const names = [...new Set(tools.map((tool) => tool.name))].slice(0, GRANT_LOOKUPS)
  const found: ApprovalGrantRecord[] = []
  let refused = false
  let next = 0
  const worker = async () => {
    while (!refused && next < names.length) {
      const name = names[next++]
      if (name === undefined) return
      try {
        const result = await list(defaultGrantBinding(name))
        found.push(...result.grants.filter((grant) => !grant.revokedAt))
      } catch {
        refused = true
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(GRANT_CONCURRENCY, names.length) }, worker))
  if (refused) return 'unavailable'
  return found.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

const when = (iso: string) => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(document.documentElement.lang || 'en', { dateStyle: 'medium', timeStyle: 'short' })
}

/** What the user told this session's tools they may always do, each with its own undo. */
export function SessionGrantList({
  grants,
  revoking,
  onRevoke,
  t,
}: {
  grants: SessionGrants
  revoking?: string | undefined
  onRevoke(grant: ApprovalGrantRecord): void
  t: Translate
}) {
  // A daemon that does not manage grants for this session has nothing to list or undo.
  if (grants === 'unavailable') return null
  return (
    <SettingsSection
      title={t('session.runtime.grants')}
      description={t('session.runtime.grantsHelp')}
      data-testid="session-runtime-grants"
    >
      {grants === undefined ? (
        <SettingsState tone="loading">{t('session.runtime.grantsLoading')}</SettingsState>
      ) : grants.length === 0 ? (
        <SettingsState>{t('session.runtime.grantsEmpty')}</SettingsState>
      ) : (
        <SettingsList>
          {grants.map((grant) => (
            <ListRow
              key={grant.grantId}
              data-testid="session-runtime-grant"
              icon={<Icon name="shield-check" size={16} />}
              title={<code translate="no">{grant.toolId}</code>}
              titleLabel={grant.toolId}
              description={t('session.runtime.grantSince', { time: when(grant.createdAt) })}
              actions={
                <Button
                  size="small"
                  data-testid="session-runtime-grant-revoke"
                  loading={revoking === grant.grantId}
                  disabled={revoking !== undefined}
                  aria-label={t('session.runtime.grantRevokeLabel', { tool: grant.toolId })}
                  onClick={() => onRevoke(grant)}
                >
                  {t('session.runtime.grantRevoke')}
                </Button>
              }
            />
          ))}
        </SettingsList>
      )}
    </SettingsSection>
  )
}

type ToolGroup = { source: string; tools: Tool[] }
const PREVIEW = 5

export function groupTools(tools: readonly Tool[]): ToolGroup[] {
  const groups = new Map<string, Tool[]>()
  for (const tool of tools) groups.set(tool.source, [...(groups.get(tool.source) ?? []), tool])
  return [...groups].map(([source, list]) => ({ source, tools: list }))
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
        <SettingsList>
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
              description={t('session.runtime.toolsFrom', {
                source: group.source,
                count: group.tools.length,
              })}
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
