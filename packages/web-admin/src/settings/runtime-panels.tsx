import type { PluginGenerationStatus, RuntimeAdminSnapshot } from '@agnes/protocol'
import {
  Badge,
  Banner,
  Button,
  Disclosure,
  Field,
  MetaText,
  SettingsDetails,
  SettingsInput,
  SettingsList,
  SettingsRow,
  SettingsState,
  Tag,
} from '@agnes/web-ui'
import { useState } from 'react'
import type { PluginAdminApi } from '../admin/plugins/api.js'
import { SecurityStatusPanel } from './security-status.js'

export const PROVIDER_KINDS = [
  'loop',
  'model-adapter',
  'compaction',
  'persistence',
  'sandbox',
  'tool-runtime',
  'tool-policy',
  'child-agent',
  'memory',
] as const
type Text = (key: string, vars?: Record<string, string | number>) => string
/** A deploy directory `packages.trustWorkspace` accepts, as the runtime snapshot offers it. */
type WorkspaceDeployment = NonNullable<RuntimeAdminSnapshot['workspaceDeployments']>[number]
export function ProvidersPanel({
  snapshot,
  t,
  kinds = PROVIDER_KINDS,
}: {
  snapshot: RuntimeAdminSnapshot
  t: Text
  kinds?: readonly string[]
}) {
  const label = (prefix: string, value: string) => {
    const text = t(`${prefix}.${value}`)
    return text === `${prefix}.${value}` ? undefined : text
  }
  return (
    <>
      {kinds.length > 1 && <p>{t('providerHelp')}</p>}
      {kinds.map((kind) => (
        <section key={kind} aria-label={t(`provider.${kind}`)} data-testid={`providers-${kind}`}>
          <h3>{t(`provider.${kind}`)}</h3>
          <p>{t(`providerHelp.${kind}`)}</p>
          {kind === 'persistence' && (
            <SettingsDetails title={t('technicalDetails')} data-testid="persistence-provider-help">
              <p>{t('persistenceHelp')}</p>
            </SettingsDetails>
          )}
          {!snapshot.providers.some((entry) => entry.kind === kind) && (
            <SettingsState>{t('empty')}</SettingsState>
          )}
          <SettingsList>
            {snapshot.providers
              .filter((entry) => entry.kind === kind)
              .map((entry) => (
                <SettingsRow
                  key={`${entry.id}@${entry.version}`}
                  title={label('providerName', entry.id) ?? entry.id}
                  actions={entry.restartRequired ? <Tag tone="warn">{t('restart')}</Tag> : undefined}
                >
                  <MetaText>
                    {[
                      t(kind === 'model-adapter' ? 'available' : entry.active ? 'active' : 'inactive'),
                      entry.version,
                      ...entry.capabilities.flatMap(
                        (capability) => label('providerCapability', capability) ?? [],
                      ),
                    ]
                      .slice(0, 3)
                      .join(' · ')}
                  </MetaText>
                  <SettingsDetails title={t('technicalDetails')} data-testid="provider-technical-details">
                    <dl>
                      <dt>{t('providerName')}</dt>
                      <dd>
                        <code>{entry.id}</code>
                      </dd>
                      <dt>{t('providerKind')}</dt>
                      <dd>
                        <code>{kind}</code>
                      </dd>
                      <dt>{t('providerVersion')}</dt>
                      <dd>{entry.version}</dd>
                      <dt>{t('source')}</dt>
                      <dd>{entry.sourcePackage}</dd>
                      <dt>{t('capabilities')}</dt>
                      <dd>{entry.capabilities.join(', ') || '—'}</dd>
                      <dt>{t('scopes')}</dt>
                      <dd>{entry.selectedFor.join(', ') || '—'}</dd>
                      {entry.scope && (
                        <>
                          <dt>{t('lifecycle')}</dt>
                          <dd>{entry.scope}</dd>
                        </>
                      )}
                    </dl>
                  </SettingsDetails>
                </SettingsRow>
              ))}
          </SettingsList>
        </section>
      ))}
    </>
  )
}

export function GenerationsPanel({
  status,
  api,
  canSave = false,
  t,
  onRefresh,
}: {
  status: PluginGenerationStatus | undefined
  api?: PluginAdminApi | undefined
  canSave?: boolean
  t: Text
  onRefresh?(): Promise<void>
}) {
  const [sessionId, setSessionId] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [result, setResult] = useState<{ previous: string; current: string }>()
  const supported = !!api
  const stale =
    status?.generations
      .filter((generation) => generation.id !== status.currentGenerationId)
      .flatMap((generation) =>
        (generation.sessions ?? []).map((session) => ({ ...session, generation: generation.id })),
      ) ?? []
  async function migrate() {
    if (!api || !canSave || busy || !sessionId.trim()) return
    setBusy(true)
    setMessage('')
    setResult(undefined)
    try {
      const value = await api.migrateSession(sessionId.trim())
      setResult({ previous: value.previousGenerationId, current: value.generationId })
      setMessage(value.changed ? 'migrated' : 'alreadyCurrent')
      setConfirming(false)
      // Migration remains successful if the separate catalog refresh is unavailable.
      try {
        await onRefresh?.()
      } catch {
        /* The refresh controller presents its own error. */
      }
    } catch {
      setMessage('migrationFailed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Disclosure variant="plain" data-testid="plugin-generations" summary={t('generation')}>
      {!status?.generations.length && <p>{t('noGenerations')}</p>}
      {status?.currentGenerationId && (
        <p>
          {t('currentGeneration')}: <code>{status.currentGenerationId}</code>
        </p>
      )}
      {status?.generations.map((generation) => (
        <div className="agnes-settings-row" key={generation.id}>
          <p>
            <code>{generation.id}</code> <Badge>{t(`generationState.${generation.state}`)}</Badge>
          </p>
          <p>
            {t('bound')}: {generation.boundSessions} · {t('openSessions')}: {generation.openSessions}
          </p>
          {generation.sessions && generation.sessions.length > 0 && (
            <p>
              {t('generationSessions')}: {generation.sessions.map((item) => item.key).join(', ')}
            </p>
          )}
          <ul>
            {generation.packages.map((pkg) => (
              <li key={pkg.id}>
                {pkg.id} · {pkg.version}
              </li>
            ))}
          </ul>
          {generation.error && <SettingsState tone="error">{t('generationFailure')}</SettingsState>}
        </div>
      ))}
      <section data-testid="session-generation-migration" aria-busy={busy}>
        <h3>{t('migrate')}</h3>
        <p>{t('migrationHelp')}</p>
        {!supported && <p>{t('migrationUnavailable')}</p>}
        {/* Pick from the sessions the backend reports on an earlier version; typing a key stays possible. */}
        <h4>{t('migrateFromList')}</h4>
        {stale.length === 0 ? (
          <p>{t('migrateNone')}</p>
        ) : (
          <SettingsList data-testid="migration-sessions">
            {stale.map((session) => (
              <SettingsRow
                key={`${session.generation}:${session.key}`}
                data-testid="migration-session"
                // The backend names the session when it can; the key is always the stable identity.
                title={session.title ?? <code>{session.key}</code>}
                description={
                  <>
                    {session.title && (
                      <>
                        <code>{session.key}</code> ·{' '}
                      </>
                    )}
                    {session.generation.slice(0, 8)} ·{' '}
                    {t(
                      session.run === 'running'
                        ? 'migrateRunning'
                        : session.open
                          ? 'migrateOpen'
                          : 'migrateClosed',
                    )}
                  </>
                }
                actions={
                  <Button
                    size="small"
                    data-testid="migration-session-pick"
                    disabled={!supported || !canSave || busy || session.run === 'running'}
                    onClick={() => {
                      setSessionId(session.key)
                      setConfirming(true)
                      setMessage('')
                      setResult(undefined)
                    }}
                  >
                    {t('migrateAction')}
                  </Button>
                }
              />
            ))}
          </SettingsList>
        )}
        <SettingsDetails title={t('migrateManual')} data-testid="migration-manual" compact>
          <Field label={t('sessionKey')} htmlFor="migration-session-key">
            <SettingsInput
              id="migration-session-key"
              data-testid="migration-session-key"
              type="text"
              maxLength={512}
              value={sessionId}
              disabled={!supported || !canSave || busy}
              onChange={(event) => {
                setSessionId(event.target.value)
                setConfirming(false)
                setMessage('')
                setResult(undefined)
              }}
            />
          </Field>
          <Button
            data-testid="migrate-session"
            disabled={!supported || !canSave || busy || !sessionId.trim() || confirming}
            onClick={() => setConfirming(true)}
          >
            {t('migrate')}
          </Button>
        </SettingsDetails>
        {confirming && (
          <fieldset aria-label={t('migrationConfirm')}>
            <p>
              {t('migrationConfirm')} <code>{sessionId.trim()}</code>
            </p>
            <Button
              data-testid="confirm-session-migration"
              disabled={busy}
              loading={busy}
              onClick={() => void migrate()}
            >
              {t('confirmMigration')}
            </Button>{' '}
            <Button disabled={busy} onClick={() => setConfirming(false)}>
              {t('cancel')}
            </Button>
          </fieldset>
        )}
        {message && <p role={message === 'migrationFailed' ? 'alert' : 'status'}>{t(message)}</p>}
        {result && (
          <p data-testid="session-migration-result">
            <code>{result.previous}</code> → <code>{result.current}</code>
          </p>
        )}
      </section>
    </Disclosure>
  )
}
export function PublicationPanel({ snapshot, t }: { snapshot: RuntimeAdminSnapshot; t: Text }) {
  const report = snapshot.publication
  return (
    <section className="runtime-card" data-testid="composition-publication">
      <h3>{t('publication')}</h3>
      {!report ? (
        <p>{t('noPublication')}</p>
      ) : (
        <>
          <p>{report.operation}</p>
          {!report.ok && <SettingsState tone="error">{t('publicationRetry')}</SettingsState>}
          <ul>
            {report.containers.map((container) => (
              <li key={container.compositionHash}>
                <code>{container.compositionHash}</code>{' '}
                <Badge tone={container.status === 'applied' ? 'ok' : 'bad'}>
                  {t(container.status === 'applied' ? 'publicationApplied' : 'publicationFailed')}
                </Badge>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

export function LocalPluginsPanel({
  api,
  snapshot,
  canSave,
  canTrust = false,
  t,
  onRefresh,
}: {
  api: PluginAdminApi
  snapshot: RuntimeAdminSnapshot
  canSave: boolean
  /** Whether workspace plugins may be trusted (the package trust permission). */
  canTrust?: boolean
  t: Text
  onRefresh(): Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
  const [confirming, setConfirming] = useState<WorkspaceDeployment>()
  // Offered by the backend only; without the list there is nothing this page can vouch for.
  const deployments = snapshot.workspaceDeployments ?? []
  async function trust(deployment: WorkspaceDeployment) {
    setBusy(true)
    setMessage('')
    setFailed(false)
    setConfirming(undefined)
    try {
      await api.trustWorkspace(deployment.deployDir)
      setMessage('trusted')
      // The trust stands even if the separate catalog refresh is unavailable.
      await onRefresh().catch(() => undefined)
    } catch {
      setMessage('trustFailed')
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  async function reload() {
    setBusy(true)
    setMessage('')
    setFailed(false)
    try {
      await api.reloadLocal()
      await onRefresh()
      setMessage('rescanned')
    } catch {
      setMessage('reloadFailed')
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Disclosure
      variant="plain"
      data-testid="local-plugins"
      summary={t('local')}
      summaryProps={{ 'data-testid': 'local-plugins-toggle' }}
    >
      <p>{t('localHelp')}</p>
      <dl>
        <dt>{t('home')}</dt>
        <dd>
          <code>{snapshot.localPluginFolders.home}</code>
        </dd>
        <dt>{t('workspace')}</dt>
        <dd>
          <code>{snapshot.localPluginFolders.workspace}</code>
        </dd>
      </dl>
      {deployments.length > 0 && (
        <>
          <h4>{t('workspaceDeployments')}</h4>
          <SettingsList data-testid="workspace-deployments">
            {deployments.map((deployment) => (
              <SettingsRow
                key={deployment.deployDir}
                data-testid="workspace-deployment"
                title={<code>{deployment.path}</code>}
                description={`${deployment.manifestId} · ${t(`trustState.${deployment.state}`)}`}
                actions={
                  deployment.state === 'trusted' ? (
                    <Badge tone="ok">{t('trustState.trusted')}</Badge>
                  ) : (
                    <Button
                      size="small"
                      data-testid="trust-workspace"
                      disabled={!canTrust || busy}
                      onClick={() => setConfirming(deployment)}
                    >
                      {t(deployment.state === 'changed' ? 'retrustWorkspace' : 'trustWorkspace')}
                    </Button>
                  )
                }
              />
            ))}
          </SettingsList>
          {confirming && (
            <Banner
              tone="warning"
              data-testid="trust-workspace-confirm"
              action={
                <>
                  <Button size="small" onClick={() => setConfirming(undefined)}>
                    {t('cancel')}
                  </Button>
                  <Button
                    size="small"
                    appearance="primary"
                    data-testid="trust-workspace-confirm-action"
                    onClick={() => void trust(confirming)}
                  >
                    {t('trustConfirmAction')}
                  </Button>
                </>
              }
            >
              {t('trustConfirm', { path: confirming.path })}
            </Banner>
          )}
        </>
      )}
      <Button
        data-testid="reload-local-plugins"
        disabled={!canSave || busy}
        loading={busy}
        onClick={() => void reload()}
      >
        {t('reloadLocal')}
      </Button>
      {message && <p role={failed ? 'alert' : 'status'}>{t(message)}</p>}
    </Disclosure>
  )
}
export const sessionStartUrl = (
  preset?: string,
  prompt?: string,
  bundles: readonly string[] = [],
  loop?: { id: string; version: string },
) => {
  const query = new URLSearchParams({ new: '1' })
  if (preset) query.set('preset', preset)
  if (loop) query.set('loop', `${loop.id}@${loop.version}`)
  if (prompt) query.set('prompt', prompt)
  for (const bundle of bundles) query.append('bundle', bundle)
  return `/?${query}`
}
export function PresetsPanel({ snapshot, t }: { snapshot: RuntimeAdminSnapshot; t: Text }) {
  return (
    <section className="runtime-card" data-testid="session-presets">
      <h3>{t('presets')}</h3>
      <p>{t('presetHelp')}</p>
      <p>{t('sessionBundleHelp')}</p>
      {snapshot.bundles?.map((bundle) => (
        <p key={bundle.id}>
          <code>{bundle.id}</code> · {bundle.sourcePackage}{' '}
          <Button href={sessionStartUrl(undefined, undefined, [bundle.id])}>{t('start')}</Button>
        </p>
      ))}
      {snapshot.presets.map((preset) => (
        <p key={preset.id}>
          {t(`choice.${preset.id}`) === `choice.${preset.id}` ? preset.id : t(`choice.${preset.id}`)}{' '}
          {preset.isDefault && <Badge>{t('default')}</Badge>}{' '}
          <Button href={sessionStartUrl(preset.id)}>{t('start')}</Button>
        </p>
      ))}
    </section>
  )
}
/**
 * What the permissions page only summarises: platform checks, per-preset rules and workspaces. The
 * sandbox implementations are listed with the other plugin types.
 */
export function IsolationDetailsPanel({ snapshot, t }: { snapshot: RuntimeAdminSnapshot; t: Text }) {
  return (
    <>
      <SecurityStatusPanel status={snapshot.security} t={t} view="details" />
    </>
  )
}
