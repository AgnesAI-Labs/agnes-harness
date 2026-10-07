import type { PluginGenerationStatus, RuntimeAdminSnapshot } from '@agnes/protocol'
import { Badge, Button, Field } from '@agnes/web-ui'
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
] as const
type Text = (key: string) => string
export function ProvidersPanel({
  snapshot,
  t,
  kinds = PROVIDER_KINDS,
}: {
  snapshot: RuntimeAdminSnapshot
  t: Text
  kinds?: readonly string[]
}) {
  return (
    <>
      <p>{t('providerHelp')}</p>
      {kinds.map((kind) => (
        <section key={kind} aria-label={kind} data-testid={`providers-${kind}`} className="runtime-card">
          <h3>{kind}</h3>
          {kind === 'persistence' && <p data-testid="persistence-provider-help">{t('persistenceHelp')}</p>}
          {!snapshot.providers.some((entry) => entry.kind === kind) && <p>{t('empty')}</p>}
          {snapshot.providers
            .filter((entry) => entry.kind === kind)
            .map((entry) => (
              <article key={`${entry.id}@${entry.version}`}>
                <h4>
                  {entry.id} · {entry.version}{' '}
                  <Badge tone={entry.active ? 'ok' : 'off'}>{t(entry.active ? 'active' : 'inactive')}</Badge>{' '}
                  {entry.restartRequired && <Badge tone="warn">{t('restart')}</Badge>}
                </h4>
                <dl>
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
              </article>
            ))}
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
    <details data-testid="plugin-generations">
      <summary>{t('generation')}</summary>
      {!status?.generations.length && <p>{t('noGenerations')}</p>}
      {status?.currentGenerationId && (
        <p>
          {t('currentGeneration')}: <code>{status.currentGenerationId}</code>
        </p>
      )}
      {status?.generations.map((generation) => (
        <article className="runtime-card" key={generation.id}>
          <p>
            <code>{generation.id}</code> <Badge>{generation.state}</Badge>
          </p>
          <p>
            {t('bound')}: {generation.boundSessions}
          </p>
          <ul>
            {generation.packages.map((pkg) => (
              <li key={pkg.id}>
                {pkg.id} · {pkg.version}
              </li>
            ))}
          </ul>
          {generation.error && <p role="alert">{generation.error}</p>}
        </article>
      ))}
      <section data-testid="session-generation-migration" aria-busy={busy}>
        <h3>{t('migrate')}</h3>
        <p>{t('migrationHelp')}</p>
        {!supported && <p>{t('migrationUnavailable')}</p>}
        <Field label={t('sessionKey')} htmlFor="migration-session-key">
          <input
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
        {!confirming ? (
          <Button
            data-testid="migrate-session"
            disabled={!supported || !canSave || busy || !sessionId.trim()}
            onClick={() => setConfirming(true)}
          >
            {t('migrate')}
          </Button>
        ) : (
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
    </details>
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
          {!report.ok && <p role="alert">{t('publicationRetry')}</p>}
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
  t,
  onRefresh,
}: {
  api: PluginAdminApi
  snapshot: RuntimeAdminSnapshot
  canSave: boolean
  t: Text
  onRefresh(): Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
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
    <details data-testid="local-plugins">
      <summary>{t('local')}</summary>
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
      <Button
        data-testid="reload-local-plugins"
        disabled={!canSave || busy}
        loading={busy}
        onClick={() => void reload()}
      >
        {t('reloadLocal')}
      </Button>
      {message && <p role={failed ? 'alert' : 'status'}>{t(message)}</p>}
    </details>
  )
}
export const sessionStartUrl = (preset?: string, prompt?: string, bundles: readonly string[] = []) => {
  const query = new URLSearchParams({ new: '1' })
  if (preset) query.set('preset', preset)
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
          <code>{preset.id}</code> {preset.isDefault && <Badge>{t('default')}</Badge>}{' '}
          <Button href={sessionStartUrl(preset.id)}>{t('start')}</Button>
        </p>
      ))}
    </section>
  )
}
export function SecurityPanel({ snapshot, t }: { snapshot: RuntimeAdminSnapshot; t: Text }) {
  return (
    <>
      <p>{t('securityHelp')}</p>
      <div className="runtime-grid">
        {(['read-only', 'workspace-write', 'full-access'] as const).map((id, index) => (
          <article key={id} className="runtime-card" data-testid={`security-${id}`}>
            <h3>{t(['readOnly', 'workspaceWrite', 'fullAccess'][index] ?? id)}</h3>
            <code>{id}</code>
            <p>
              {snapshot.presets.some((preset) => preset.id === id) ? (
                <Button href={sessionStartUrl(id)}>{t('securityStart')}</Button>
              ) : (
                t('notAllowed')
              )}
            </p>
          </article>
        ))}
      </div>
      <SecurityStatusPanel status={snapshot.security} t={t} />
      <h3>{t('sandbox')}</h3>
      <ProvidersPanel snapshot={snapshot} kinds={['sandbox']} t={t} />
    </>
  )
}
