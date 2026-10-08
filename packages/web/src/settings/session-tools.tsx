type ToolGroup = {
  packageId: string
  reason: string
  bundles: string[]
  tools: string[]
}
type SessionInfo = { sessionKey: string; preset: string; toolGroups: ToolGroup[] }
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')
const reasons = ['official-default', 'enabled-plugin', 'bundle', 'selected-loop']

/** Read only the safe live catalog, never infer active tools from desired package state. */
export function sessionToolInfo(value: unknown): SessionInfo[] {
  if (!object(value) || !Array.isArray(value.sessions)) return []
  return value.sessions.flatMap((session) => {
    if (
      !object(session) ||
      typeof session.sessionKey !== 'string' ||
      typeof session.preset !== 'string' ||
      !Array.isArray(session.toolGroups)
    )
      return []
    const toolGroups = session.toolGroups.filter(
      (group): group is ToolGroup =>
        object(group) &&
        typeof group.packageId === 'string' &&
        typeof group.reason === 'string' &&
        reasons.includes(group.reason) &&
        strings(group.bundles) &&
        strings(group.tools),
    )
    return [{ sessionKey: session.sessionKey, preset: session.preset, toolGroups }]
  })
}

export function SessionToolsPanel({ value, t }: { value: unknown; t(key: string): string }) {
  const sessions = sessionToolInfo(value)
  return (
    <section data-testid="session-tool-info" aria-label={t('sessionToolInfo')}>
      <h3>{t('sessionToolInfo')}</h3>
      <p>{t('sessionToolHelp')}</p>
      {!sessions.length && <p>{t('sessionToolUnavailable')}</p>}
      {sessions.map((session) => (
        <details key={session.sessionKey} data-testid="session-tool-groups">
          <summary>
            {session.sessionKey} · {session.preset}
          </summary>
          <table style={{ tableLayout: 'fixed', width: '100%' }}>
            <caption>{t('activeToolGroups')}</caption>
            <thead>
              <tr>
                <th scope="col" style={{ width: '25%' }}>
                  {t('source')}
                </th>
                <th scope="col" style={{ width: '35%' }}>
                  {t('toolReason')}
                </th>
                <th scope="col" style={{ width: '40%' }}>
                  {t('tools')}
                </th>
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
        </details>
      ))}
    </section>
  )
}
