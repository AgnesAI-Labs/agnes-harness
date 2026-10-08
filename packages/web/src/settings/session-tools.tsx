import { type SessionCapability, SessionCapabilitySet, validateAgainst } from '@agnes/protocol'
import { SettingsCard, SettingsState } from '@agnes/web-ui'

type ToolGroup = {
  packageId: string
  reason: string
  bundles: string[]
  tools: string[]
}
type SessionInfo = {
  sessionKey: string
  preset: string
  toolGroups: ToolGroup[]
  capabilities?: SessionCapabilitySet | undefined
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')
const reasons = ['official-default', 'enabled-plugin', 'bundle', 'selected-loop']

/** Read only the safe live catalog, never infer active tools from desired package state. */
export function sessionToolInfo(value: unknown): SessionInfo[] {
  if (!object(value) || !Array.isArray(value.sessions)) return []
  return value.sessions.flatMap((session) => {
    if (!object(session) || typeof session.sessionKey !== 'string' || typeof session.preset !== 'string')
      return []
    const toolGroups = (Array.isArray(session.toolGroups) ? session.toolGroups : []).filter(
      (group): group is ToolGroup =>
        object(group) &&
        typeof group.packageId === 'string' &&
        typeof group.reason === 'string' &&
        reasons.includes(group.reason) &&
        strings(group.bundles) &&
        strings(group.tools),
    )
    const capabilities = validateAgainst(SessionCapabilitySet, session.capabilities).ok
      ? (session.capabilities as SessionCapabilitySet)
      : undefined
    return [{ sessionKey: session.sessionKey, preset: session.preset, toolGroups, capabilities }]
  })
}

export function SessionToolsPanel({ value, t }: { value: unknown; t(key: string): string }) {
  const sessions = sessionToolInfo(value)
  return (
    <SettingsCard data-testid="session-tool-info" aria-label={t('sessionToolInfo')}>
      <h3>{t('sessionToolInfo')}</h3>
      <p>{t('sessionToolHelp')}</p>
      {!sessions.length && <SettingsState>{t('sessionToolUnavailable')}</SettingsState>}
      {sessions.map((session) => (
        <details key={session.sessionKey} data-testid="session-tool-groups">
          <summary>
            {session.sessionKey} · {session.preset}
          </summary>
          {session.capabilities ? (
            <CapabilityDetails value={session.capabilities} t={t} />
          ) : (
            <div className="agnes-settings-table">
              <table>
                <caption>{t('activeToolGroups')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('source')}</th>
                    <th scope="col">{t('toolReason')}</th>
                    <th scope="col">{t('tools')}</th>
                  </tr>
                </thead>
                <tbody>
                  {session.toolGroups.map((group) => (
                    <tr key={group.packageId}>
                      <th scope="row">{group.packageId}</th>
                      <td>
                        {t('toolReason.' + group.reason)} {group.bundles.join(', ')}
                      </td>
                      <td>
                        <details>
                          <summary>
                            {group.tools.length} · {t('tools')}
                          </summary>
                          <p>{group.tools.join(', ')}</p>
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </details>
      ))}
    </SettingsCard>
  )
}

const CATEGORIES = [
  'tools',
  'mcp',
  'skills',
  'modelAdapters',
  'childEngines',
  'childModels',
  'uiModules',
  'surfaces',
  'packages',
  'plugins',
] as const
function CapabilityDetails({ value, t }: { value: SessionCapabilitySet; t(key: string): string }) {
  const sourceText = (source: { layer: string; name: string }) =>
    `${t(`capabilitySource.${source.layer}`)} · ${source.name}`
  const selections = [
    ['loop', `${value.loop.value.id} ${value.loop.value.version}`, value.loop.source],
    ['permissions', value.permissions.preset, value.permissions.source],
    ['sandbox', value.sandbox.provider, value.sandbox.source],
    ['compaction', value.compaction.engine ?? t('capabilityNone'), value.compaction.source],
    ['persistence', value.persistence.provider, value.persistence.source],
    ['modelRoutes', value.modelRoutes.value?.primary.model ?? t('capabilityNone'), value.modelRoutes.source],
  ] as const
  return (
    <div data-testid="session-capabilities">
      <dl className="agnes-settings-metadata">
        <dt>{t('capabilityGeneration')}</dt>
        <dd>{value.codePin.generationId ?? t('capabilityLegacy')}</dd>
        <dt>{t('capabilityBundles')}</dt>
        <dd>{value.bundles.join(', ') || t('capabilityNone')}</dd>
        {selections.map(([kind, selected, source]) => (
          <div key={kind}>
            <dt>{t(`capabilityCategory.${kind}`)}</dt>
            <dd>
              {selected}
              <small> · {sourceText(source)}</small>
            </dd>
          </div>
        ))}
      </dl>
      {CATEGORIES.map((kind) => (
        <details key={kind} data-testid={`session-capability-${kind}`} open={kind === 'tools'}>
          <summary>
            {t(`capabilityCategory.${kind}`)} ·{' '}
            {new Intl.NumberFormat(document.documentElement.lang || 'en').format(value[kind].length)}
          </summary>
          {!value[kind].length ? (
            <SettingsState>{t('capabilityEmpty')}</SettingsState>
          ) : (
            <div className="agnes-settings-table">
              <table>
                <caption>{t(`capabilityCategory.${kind}`)}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('source')}</th>
                    <th scope="col">{t('capabilityState')}</th>
                    <th scope="col">{t('capabilityWhy')}</th>
                  </tr>
                </thead>
                <tbody>
                  {value[kind].map((item: SessionCapability) => (
                    <tr key={item.id}>
                      <th scope="row">
                        <code>{item.id}</code>
                      </th>
                      <td>{t(item.enabled ? 'capabilityEnabled' : 'capabilityDisabled')}</td>
                      <td>
                        <ul>
                          {[
                            ...new Map(
                              item.reasons.map((reason) => [
                                JSON.stringify([reason.source.layer, reason.source.name, reason.rule]),
                                reason,
                              ]),
                            ).values(),
                          ].map((reason) => (
                            <li key={`${reason.source.layer}:${reason.source.name}:${reason.rule}`}>
                              {sourceText(reason.source)} · <code>{reason.rule}</code>
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </details>
      ))}
    </div>
  )
}
