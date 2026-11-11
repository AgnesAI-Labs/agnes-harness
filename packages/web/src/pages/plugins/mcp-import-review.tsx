import type { SkillImportParams, SkillImportResult } from '@agnes/protocol'
import {
  Button,
  MetaText,
  SettingsCheckbox,
  SettingsDetails,
  SettingsInput,
  SettingsSelect,
  SettingsState,
} from '@agnes/web-ui'

type Text = (key: string, vars?: Readonly<Record<string, string | number>>) => string
export function McpImportReview({
  result,
  selectedServers,
  onServers,
  configurationChanged,
  selected,
  onSelected,
  bindings,
  onBinding,
  test,
  onTest,
  busy,
  canTest,
  sandboxProfile,
  onSandboxProfile,
  onConfigure,
  t,
}: {
  result: SkillImportResult
  selectedServers: string[]
  onServers(value: string[]): void
  configurationChanged: boolean
  selected: string[]
  onSelected(value: string[]): void
  bindings: Record<string, string>
  onBinding(key: string, value: string): void
  test: boolean
  onTest(value: boolean): void
  busy: boolean
  canTest: boolean
  sandboxProfile: NonNullable<SkillImportParams['mcpSandboxProfile']>
  onSandboxProfile(value: NonNullable<SkillImportParams['mcpSandboxProfile']>): void
  onConfigure(): void
  t: Text
}) {
  const preview = result.mcp
  if (!preview) return null
  const reviewing = result.state === 'prepared'
  const credentials = preview.servers
    .filter((server) => selectedServers.includes(server.serverId))
    .flatMap((server) => server.requiredCredentials ?? [])
  const stdio = preview.servers.some(
    (server) => selectedServers.includes(server.serverId) && server.transport === 'stdio',
  )
  return (
    <section className="mcp-import-review" aria-label={t('mcp.import.title')}>
      <h4>{t('mcp.import.connections')}</h4>
      <p>{t('mcp.import.selectionHelp')}</p>
      {reviewing && !selectedServers.length && !selected.length && (
        <SettingsState>{t('mcp.import.emptySelection')}</SettingsState>
      )}
      {preview.servers.map((server) => (
        <div className="mcp-import-server" key={server.serverId}>
          <SettingsCheckbox
            checked={selectedServers.includes(server.serverId)}
            disabled={busy || !reviewing}
            onChange={(event) =>
              onServers(
                event.currentTarget.checked
                  ? [...selectedServers, server.serverId]
                  : selectedServers.filter((id) => id !== server.serverId),
              )
            }
            label={server.serverId}
          />

          <MetaText>
            {server.transport} · {t(`mcp.import.server.${server.state}`)}
          </MetaText>
          {server.command && <pre>{JSON.stringify([server.command, ...(server.args ?? [])], null, 2)}</pre>}
          {server.url && <code>{server.url}</code>}
          {server.cwd && (
            <MetaText>
              {t('mcp.import.cwd')}: {server.cwd}
            </MetaText>
          )}
          {server.toolCount !== undefined && (
            <MetaText>{t('mcp.import.toolCount', { count: server.toolCount })}</MetaText>
          )}
          {server.errorCode && (
            <SettingsState tone="error">
              {t(`mcp.import.error.${server.errorCode}`) === `mcp.import.error.${server.errorCode}`
                ? server.errorCode
                : t(`mcp.import.error.${server.errorCode}`)}
            </SettingsState>
          )}
        </div>
      ))}
      {reviewing && stdio && (
        <>
          <label className="mcp-import-credential" htmlFor="mcp-import-sandbox">
            {t('mcp.import.sandbox')}
            <SettingsSelect
              id="mcp-import-sandbox"
              disabled={busy}
              value={sandboxProfile}
              onChange={(event) =>
                onSandboxProfile(
                  event.currentTarget.value as NonNullable<SkillImportParams['mcpSandboxProfile']>,
                )
              }
            >
              {(['strict', 'workspace-write', 'network', 'off-with-warning'] as const).map((value) => (
                <option key={value} value={value}>
                  {t(`mcp.import.sandbox.${value}`)}
                </option>
              ))}
            </SettingsSelect>
          </label>
          {sandboxProfile === 'off-with-warning' && (
            <SettingsState tone="error">{t('mcp.import.sandboxWarning')}</SettingsState>
          )}
        </>
      )}
      {preview.issues.map((issue) => (
        <SettingsState key={issue} tone="error">
          {t(`skill.import.reason.${issue}`)}
        </SettingsState>
      ))}
      {credentials.length > 0 && (
        <>
          <p>{t('mcp.import.credentialsHelp')}</p>
          {credentials.map((key) => (
            <label className="mcp-import-credential" key={key} htmlFor={`mcp-import-credential-${key}`}>
              {key}
              <SettingsInput
                id={`mcp-import-credential-${key}`}
                value={bindings[key] ?? ''}
                disabled={busy || !reviewing}
                placeholder="secret://provider/name"
                onChange={(event) => onBinding(key, event.currentTarget.value)}
              />
            </label>
          ))}
        </>
      )}
      {reviewing && (configurationChanged || credentials.length > 0) && (
        <Button
          disabled={
            busy ||
            credentials.some((key) => !/^secret:\/\/[a-z0-9-]+\/[a-z0-9._-]+$/.test(bindings[key] ?? ''))
          }
          onClick={onConfigure}
        >
          {t('mcp.import.configure')}
        </Button>
      )}
      {preview.skills.length > 0 && (
        <>
          <h4>{t('mcp.import.skills')}</h4>
          <p>{t('mcp.import.skillsHelp')}</p>
          {preview.skills.map((skill) => (
            <div className="mcp-import-choice" key={skill.path}>
              <SettingsCheckbox
                checked={selected.includes(skill.path)}
                disabled={busy || !reviewing || skill.state !== 'prepared'}
                onChange={(event) =>
                  onSelected(
                    event.currentTarget.checked
                      ? [...selected, skill.path]
                      : selected.filter((path) => path !== skill.path),
                  )
                }
                label={
                  <span>
                    {skill.name}
                    <MetaText>
                      {skill.path} · {t(`mcp.import.skill.${skill.state}`)}
                      {skill.fileCount !== undefined
                        ? ` · ${t('mcp.import.fileCount', { count: skill.fileCount })}`
                        : ''}
                    </MetaText>
                  </span>
                }
              />
            </div>
          ))}
        </>
      )}
      {reviewing && selectedServers.length > 0 && (
        <div className="mcp-import-choice">
          <SettingsCheckbox
            checked={test}
            disabled={
              busy ||
              !canTest ||
              configurationChanged ||
              !!preview.requiredCredentials.length ||
              result.environment?.some((item) => item.state === 'missing' || item.state === 'unsupported')
            }
            onChange={(event) => onTest(event.currentTarget.checked)}
            label={
              <span>
                {t('mcp.import.test')}
                <MetaText>{t('mcp.import.testHelp')}</MetaText>
              </span>
            }
          />
        </div>
      )}
      <MetaText>{t('mcp.import.registrationHelp')}</MetaText>
      {result.warnings?.map((warning) => (
        <MetaText key={warning}>{t(`mcp.import.warning.${warning}`)}</MetaText>
      ))}
      <SettingsDetails title={t('mcp.import.source')}>
        <MetaText>{preview.configurationFiles.join(' · ')}</MetaText>
        <MetaText>{result.resolvedSource?.ref}</MetaText>
        <MetaText>{result.sourceDigest}</MetaText>
        <MetaText>{result.digest}</MetaText>
      </SettingsDetails>
    </section>
  )
}
