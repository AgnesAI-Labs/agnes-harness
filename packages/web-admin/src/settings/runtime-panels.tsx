import type { PluginGenerationStatus, RuntimeAdminSnapshot } from '@agnes/protocol'
import {
  Badge,
  Banner,
  Button,
  CopyButton,
  MetaText,
  reportSuccess,
  resolveFeedback,
  SettingsDetails,
  SettingsFooter,
  SettingsGroup,
  SettingsInput,
  SettingsItem,
  SettingsList,
  SettingsRow,
  SettingsSection,
  SettingsState,
  SettingsTechnicalDetails,
  StatusMessage,
  Tag,
} from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import type { PluginAdminApi } from '../admin/plugins/api.js'
import { captureRequest, useRequestScope } from './async-request.js'
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
      {kinds.map((kind) => (
        <SettingsSection
          key={kind}
          aria-label={t(`provider.${kind}`)}
          data-testid={`providers-${kind}`}
          title={t(`provider.${kind}`)}
          description={t(`providerHelp.${kind}`)}
        >
          {kind === 'persistence' && (
            <SettingsTechnicalDetails data-testid="persistence-provider-help">
              <p>{t('persistenceHelp')}</p>
            </SettingsTechnicalDetails>
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
                      // The summary keeps three items. Payload-only already says it reads payloads, so
                      // the weaker label does not take the place the stronger one needs.
                      ...entry.capabilities
                        .filter(
                          (capability) =>
                            capability !== 'payload' || !entry.capabilities.includes('payloadOnly'),
                        )
                        .flatMap((capability) => label('providerCapability', capability) ?? []),
                    ]
                      .slice(0, 3)
                      .join(' · ')}
                  </MetaText>
                  <SettingsTechnicalDetails data-testid="provider-technical-details">
                    <dl>
                      <dt>{t('providerName')}</dt>
                      <dd>
                        <code>{entry.id}</code>{' '}
                        <CopyButton text={entry.id} label={t('copyId')} copiedLabel={t('copiedId')} />
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
                  </SettingsTechnicalDetails>
                </SettingsRow>
              ))}
          </SettingsList>
        </SettingsSection>
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
  const lifetime = useRequestScope(api, canSave)
  const [sessionId, setSessionId] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [result, setResult] = useState<{ previous: string; current: string }>()
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope changes retire pending callbacks and reset their UI state.
  useEffect(() => {
    setBusy(false)
    setConfirming(false)
    setResult(undefined)
    setMessage('')
  }, [api, canSave])
  const supported = !!api
  const isCurrent = (generation: PluginGenerationStatus['generations'][number]) =>
    generation.current ?? generation.id === status?.currentGenerationId
  const stale =
    status?.generations
      .filter((generation) => !isCurrent(generation))
      .flatMap((generation) =>
        (generation.sessions ?? []).map((session) => ({ ...session, generation: generation.id })),
      ) ?? []
  async function migrate() {
    if (!api || !canSave || busy || !sessionId.trim()) return
    const request = captureRequest(lifetime)
    setBusy(true)
    setMessage('')
    setResult(undefined)
    try {
      const value = await api.migrateSession(sessionId.trim())
      if (!request.isCurrent()) return
      setResult({ previous: value.previousGenerationId, current: value.generationId })
      reportSuccess('session-migration', t(value.changed ? 'migrated' : 'alreadyCurrent'))
      setConfirming(false)
      // Migration remains successful if the separate catalog refresh is unavailable.
      try {
        await onRefresh?.()
      } catch {
        /* The refresh controller presents its own error. */
      }
    } catch {
      if (request.isCurrent()) setMessage('migrationFailed')
    } finally {
      if (request.isCurrent()) setBusy(false)
    }
  }
  const short = (id: string) => (id.length > 12 ? `${id.slice(0, 12)}…` : id)
  return (
    <SettingsDetails
      data-testid="plugin-generations"
      title={t('generation')}
      summary={
        status?.generations.length ? t('generationCount', { count: status.generations.length }) : undefined
      }
    >
      {!status?.generations.length ? (
        <SettingsState>{t('noGenerations')}</SettingsState>
      ) : (
        <SettingsList>
          {status.generations.map((generation) => (
            <SettingsRow
              key={generation.id}
              title={
                <>
                  <code title={generation.id}>{short(generation.id)}</code>{' '}
                  <Badge tone={generation.state === 'failed' ? 'bad' : isCurrent(generation) ? 'ok' : 'off'}>
                    {t(isCurrent(generation) ? 'currentGeneration' : `generationState.${generation.state}`)}
                  </Badge>
                </>
              }
              description={`${t('bound')} ${generation.boundSessions} · ${t('openSessions')} ${generation.openSessions}`}
            >
              {generation.error && <SettingsState tone="error">{t('generationFailure')}</SettingsState>}
              <SettingsTechnicalDetails>
                <dl>
                  <dt>{t('generationId')}</dt>
                  <dd>
                    <code>{generation.id}</code>{' '}
                    <CopyButton text={generation.id} label={t('copyId')} copiedLabel={t('copiedId')} />
                  </dd>
                  <dt>{t('generationPackages')}</dt>
                  <dd>{generation.packages.map((pkg) => `${pkg.id} ${pkg.version}`).join(', ') || '—'}</dd>
                  {generation.sessions && generation.sessions.length > 0 && (
                    <>
                      <dt>{t('generationSessions')}</dt>
                      <dd>{generation.sessions.map((item) => item.key).join(', ')}</dd>
                    </>
                  )}
                </dl>
              </SettingsTechnicalDetails>
            </SettingsRow>
          ))}
        </SettingsList>
      )}
      <SettingsSection
        data-testid="session-generation-migration"
        aria-busy={busy}
        title={t('migrate')}
        description={t(supported ? 'migrationHelp' : 'migrationUnavailable')}
      >
        {/* Pick from the sessions the backend reports on an earlier version; typing a key stays possible. */}
        {stale.length === 0 ? (
          <SettingsState>{t('migrateNone')}</SettingsState>
        ) : (
          <SettingsList data-testid="migration-sessions" aria-label={t('migrateFromList')}>
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
        {confirming && (
          <Banner
            tone="warning"
            role="group"
            aria-label={t('migrationConfirm')}
            action={
              <>
                <Button size="small" disabled={busy} onClick={() => setConfirming(false)}>
                  {t('cancel')}
                </Button>
                <Button
                  size="small"
                  appearance="primary"
                  data-testid="confirm-session-migration"
                  disabled={busy}
                  loading={busy}
                  onClick={() => void migrate()}
                >
                  {t('confirmMigration')}
                </Button>
              </>
            }
          >
            {t('migrationConfirm')} <code>{sessionId.trim()}</code>
          </Banner>
        )}
        {message && (
          <StatusMessage
            kind="error"
            action={{ label: t('confirmMigration'), onSelect: () => void migrate(), busy }}
          >
            {t(message)}
          </StatusMessage>
        )}
        {result && (
          <SettingsState data-testid="session-migration-status">
            <span data-testid="session-migration-result">
              <code>{short(result.previous)}</code> → <code>{short(result.current)}</code>
            </span>
          </SettingsState>
        )}
        <SettingsDetails title={t('migrateManual')} data-testid="migration-manual" compact>
          <SettingsGroup>
            <SettingsItem label={t('sessionKey')} labelId="migration-session-key-label">
              <SettingsInput
                id="migration-session-key"
                data-testid="migration-session-key"
                aria-labelledby="migration-session-key-label"
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
              <Button
                data-testid="migrate-session"
                disabled={!supported || !canSave || busy || !sessionId.trim() || confirming}
                onClick={() => setConfirming(true)}
              >
                {t('migrateAction')}
              </Button>
            </SettingsItem>
          </SettingsGroup>
        </SettingsDetails>
      </SettingsSection>
    </SettingsDetails>
  )
}
export function PublicationPanel({ snapshot, t }: { snapshot: RuntimeAdminSnapshot; t: Text }) {
  const report = snapshot.publication
  return (
    <SettingsSection
      data-testid="composition-publication"
      title={t('publication')}
      description={report ? report.operation : undefined}
    >
      {!report ? (
        <SettingsState>{t('noPublication')}</SettingsState>
      ) : (
        <>
          {!report.ok && (
            <Banner tone="error" role="alert">
              {t('publicationRetry')}
            </Banner>
          )}
          <SettingsList>
            {report.containers.map((container) => (
              <SettingsRow
                key={container.compositionHash}
                title={
                  <>
                    <code title={container.compositionHash}>{container.compositionHash.slice(0, 12)}</code>{' '}
                    <CopyButton
                      text={container.compositionHash}
                      label={t('copyId')}
                      copiedLabel={t('copiedId')}
                    />
                  </>
                }
                actions={
                  <Badge tone={container.status === 'applied' ? 'ok' : 'bad'}>
                    {t(container.status === 'applied' ? 'publicationApplied' : 'publicationFailed')}
                  </Badge>
                }
              />
            ))}
          </SettingsList>
        </>
      )}
    </SettingsSection>
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
  const lifetime = useRequestScope(api, `${canSave}:${canTrust}`)
  const [confirming, setConfirming] = useState<WorkspaceDeployment>()
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope changes retire pending callbacks and reset their UI state.
  useEffect(() => {
    setBusy(false)
    setConfirming(undefined)
    setMessage('')
    setFailed(false)
  }, [api, canSave, canTrust])
  // Offered by the backend only; without the list there is nothing this page can vouch for.
  const deployments = snapshot.workspaceDeployments ?? []
  async function trust(deployment: WorkspaceDeployment) {
    const request = captureRequest(lifetime)
    setBusy(true)
    setMessage('')
    setFailed(false)
    setConfirming(undefined)
    try {
      await api.trustWorkspace(deployment.deployDir, deployment.trustHash)
      if (!request.isCurrent()) return
      reportSuccess('plugin-folders', t('trusted'), {
        kind: 'rescan-required',
        message: t('rescanRequired'),
        action: {
          label: t('reloadLocal'),
          onSelect: () => {
            if (request.isCurrent()) void reload()
          },
        },
      })
      // The trust stands even if the separate catalog refresh is unavailable.
      await onRefresh().catch(() => undefined)
    } catch {
      if (!request.isCurrent()) return
      setMessage('trustFailed')
      setFailed(true)
    } finally {
      if (request.isCurrent()) setBusy(false)
    }
  }
  async function reload() {
    const request = captureRequest(lifetime)
    setBusy(true)
    setMessage('')
    setFailed(false)
    try {
      await api.reloadLocal()
      if (!request.isCurrent()) return
      resolveFeedback('plugin-folders')
      reportSuccess('plugin-folders', t('rescanned'))
      await onRefresh().catch(() => {
        if (!request.isCurrent()) return
        setMessage('reloadRefreshFailed')
        setFailed(true)
      })
    } catch {
      if (!request.isCurrent()) return
      setMessage('reloadFailed')
      setFailed(true)
    } finally {
      if (request.isCurrent()) setBusy(false)
    }
  }
  return (
    <SettingsDetails data-testid="local-plugins" title={t('local')}>
      <SettingsSection description={t('localHelp')}>
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
      </SettingsSection>
      {deployments.length > 0 && (
        <SettingsSection title={t('workspaceDeployments')}>
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
              {t(confirming.pluginCount === undefined ? 'trustConfirm' : 'localTrustConfirm', {
                path: confirming.path,
                count: confirming.pluginCount ?? 0,
              })}
            </Banner>
          )}
        </SettingsSection>
      )}
      {message && failed && (
        <Banner tone="error" role="alert">
          {t(message)}
        </Banner>
      )}
      <SettingsFooter status={message && !failed ? t(message) : undefined}>
        <Button
          data-testid="reload-local-plugins"
          disabled={!canSave || busy}
          loading={busy}
          onClick={() => void reload()}
        >
          {t('reloadLocal')}
        </Button>
      </SettingsFooter>
    </SettingsDetails>
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
  return <SecurityStatusPanel status={snapshot.security} t={t} view="details" />
}
