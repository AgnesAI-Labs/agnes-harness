import type { PluginConfigSnapshot } from '@agnes/protocol'
import { useCredentialOptions } from '@agnes/resource-control-web/credentials'
import {
  Button,
  Disclosure,
  type PluginFormIssue,
  type PluginSchema,
  PluginSchemaFields,
  pluginSchemaDefault,
  reportSuccess,
  SettingsSelect,
  SettingsState,
  SettingsToolbar,
  StatusMessage,
  useUiText,
} from '@agnes/web-ui'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PluginConfigApi } from './config-api.js'
import { PLUGIN_CONFIG_ADMIN_NAMESPACE, pluginConfigAdminCatalog } from './config-locale.js'
import type { AdminContext } from './types.js'

type ExactRow = Readonly<{ rowId: string; isCurrent(): boolean; onMissing(): void }>

/** The workbench's bound Configure action uses the same editor and permissions as plugin details. */
export function PluginRowConfiguration({
  context,
  packageId,
  target,
}: {
  context: AdminContext
  packageId: string
  target: ExactRow
}) {
  const { profile, clientId } = context
  const api = useMemo(() => new PluginConfigApi({ profile, clientId }), [profile, clientId])
  return (
    <PluginConfigPanel
      api={api}
      id={packageId}
      canSave={!context.readOnly && context.permissions.includes('packages.activate')}
      exactRow={target}
    />
  )
}

export function PluginConfigPanel({
  api,
  id,
  canSave,
  exactRow,
}: {
  api: PluginConfigApi
  id: string
  canSave: boolean
  exactRow?: ExactRow
}) {
  const { t } = useUiText(PLUGIN_CONFIG_ADMIN_NAMESPACE, pluginConfigAdminCatalog)
  const credentials = useCredentialOptions(id)
  const [snapshot, setSnapshot] = useState<PluginConfigSnapshot>()
  const [rowId, setRowId] = useState('')
  const [draft, setDraft] = useState<unknown>()
  const [issues, setIssues] = useState<readonly PluginFormIssue[]>([])
  const [invalidJson, setInvalidJson] = useState<ReadonlySet<string>>(new Set())
  const [validating, setValidating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [refusalReason, setRefusalReason] = useState('')
  const [loadVersion, setLoadVersion] = useState(0)
  const [editorVersion, setEditorVersion] = useState(0)
  const alive = useRef(true)
  const generation = useRef(0)
  const onInvalid = useCallback((path: string, invalid: boolean) => {
    setInvalidJson((prior) => {
      if (prior.has(path) === invalid) return prior
      const next = new Set(prior)
      if (invalid) next.add(path)
      else next.delete(path)
      return next
    })
  }, [])
  useEffect(() => {
    void loadVersion
    if (exactRow && !exactRow.isCurrent()) return
    alive.current = true
    const abort = new AbortController()
    void api
      .get(id, abort.signal)
      .then((snapshot) => {
        if (abort.signal.aborted || (exactRow && !exactRow.isCurrent())) return
        const entry = exactRow
          ? snapshot.entries.find(({ rowId }) => rowId === exactRow.rowId)
          : snapshot.entries[0]
        if (exactRow && !entry) {
          setSnapshot(snapshot)
          setRowId('')
          exactRow.onMissing()
          return
        }
        setSnapshot(snapshot)
        setRowId(entry?.rowId ?? '')
        setDraft(entry?.value)
        setIssues([])
        setInvalidJson(new Set())
        setNotice('')
        setRefusalReason('')
      })
      .catch(() => {
        if (!abort.signal.aborted) setNotice('unavailable')
      })
    return () => {
      alive.current = false
      abort.abort()
    }
  }, [api, id, loadVersion, exactRow])
  const entry = snapshot?.entries.find((entry) => entry.rowId === rowId)
  useEffect(() => {
    if (!entry || invalidJson.size) {
      generation.current++
      setValidating(false)
      return
    }
    const current = ++generation.current
    const abort = new AbortController()
    setValidating(true)
    const timer = setTimeout(() => {
      if (exactRow && !exactRow.isCurrent()) return
      void api
        .validate(id, entry.rowId, draft, abort.signal)
        .then((result) => {
          if (!abort.signal.aborted && generation.current === current) {
            setIssues(result.issues)
            setValidating(false)
          }
        })
        .catch(() => {
          if (!abort.signal.aborted) {
            setNotice('unavailable')
            setIssues([{ path: '', code: 'validation' }])
            setValidating(false)
          }
        })
    }, 180)
    return () => {
      clearTimeout(timer)
      abort.abort()
    }
  }, [api, id, entry, draft, invalidJson, exactRow])
  const change = (value: unknown) => {
    setDraft(value)
    setValidating(true)
    setNotice('')
    setRefusalReason('')
  }
  const save = async () => {
    if (!snapshot || !entry || issues.length || invalidJson.size || validating || !canSave) return
    if (exactRow && !exactRow.isCurrent()) return
    setSaving(true)
    try {
      const result = await api.save(id, entry.rowId, draft, snapshot.revision)
      if (!alive.current || (exactRow && !exactRow.isCurrent())) return
      setIssues(result.issues)
      setNotice(result.ok && result.reason === 'saved' ? '' : result.reason)
      setRefusalReason(result.reason === 'refused' ? (result.refusalReason ?? '') : '')
      if (result.ok && result.reason === 'saved') {
        reportSuccess(
          `plugin-config:${id}`,
          t('saved'),
          result.reload === 'next-session' ? { kind: 'new-sessions', message: t('next') } : undefined,
        )
        const latest = await api.get(id).catch(() => {
          if (alive.current) setNotice('refreshFailed')
          return undefined
        })
        if (alive.current && latest && (!exactRow || exactRow.isCurrent())) {
          const refreshed = latest.entries.find((item) => item.rowId === entry.rowId)
          if (exactRow && !refreshed) {
            exactRow.onMissing()
            return
          }
          if (latest.revision === result.revision) {
            setSnapshot(latest)
            setDraft(refreshed?.value)
          } else setNotice('conflict')
        }
      }
    } catch {
      if (alive.current) setNotice('unavailable')
    } finally {
      if (alive.current) setSaving(false)
    }
  }
  return (
    <section data-testid="plugin-config-panel" className="plugin-config-panel" aria-label={t('config')}>
      {notice && (
        <StatusMessage
          kind={notice === 'pending' ? 'pending' : 'error'}
          data-testid="plugin-config-notice"
          action={{ label: t('reload'), onSelect: () => setLoadVersion((value) => value + 1) }}
        >
          {t(notice)}
          {notice === 'refused' && refusalReason && (
            <span data-testid="plugin-config-refusal-reason"> {refusalReason}</span>
          )}
        </StatusMessage>
      )}
      {!snapshot && !notice && <SettingsState tone="loading">{t('loading')}</SettingsState>}
      {snapshot && !entry && <p>{t('empty')}</p>}
      <SettingsToolbar>
        <Button htmlType="button" disabled={saving} onClick={() => setLoadVersion((value) => value + 1)}>
          {t('reload')}
        </Button>
      </SettingsToolbar>
      {entry && snapshot && (
        <>
          {exactRow ? (
            <p data-testid="plugin-config-exact-row">{entry.rowId}</p>
          ) : (
            <SettingsSelect
              aria-label={t('row')}
              data-testid="plugin-config-entry"
              value={rowId}
              disabled={saving}
              onChange={(event) => {
                const next = snapshot.entries.find((entry) => entry.rowId === event.currentTarget.value)
                if (next) {
                  setValidating(true)
                  setRowId(next.rowId)
                  setDraft(next.value)
                  setIssues([])
                  setInvalidJson(new Set())
                  setNotice('')
                  setRefusalReason('')
                }
              }}
            >
              {snapshot.entries.map((entry) => (
                <option key={entry.rowId} value={entry.rowId}>
                  {entry.rowId}
                </option>
              ))}
            </SettingsSelect>
          )}
          <p data-testid="plugin-config-reload-mode">{t(entry.reload === 'live' ? 'live' : 'next')}</p>
          <p>{t('revision', { revision: snapshot.revision })}</p>
          {issues.length > 0 && (
            <ul data-testid="plugin-config-errors">
              {issues.map((issue) => (
                <li role="alert" key={`${issue.path}:${issue.code}`}>
                  {issue.path || '/'}: {t('fieldError', { code: issue.code })}
                </li>
              ))}
            </ul>
          )}
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
          >
            <PluginSchemaFields
              secretOptions={credentials}
              key={`${entry.rowId}:${loadVersion}:${editorVersion}`}
              root={entry.schema as PluginSchema}
              schema={entry.schema as PluginSchema}
              value={draft}
              path=""
              issues={issues}
              disabled={!canSave || saving}
              onChange={change}
              onInvalid={onInvalid}
            />
            {validating && <p role="status">{t('validating')}</p>}
            <SettingsToolbar>
              <Button
                htmlType="button"
                disabled={!canSave || saving}
                onClick={() => {
                  setEditorVersion((version) => version + 1)
                  setInvalidJson(new Set())
                  change(pluginSchemaDefault(entry.schema as PluginSchema, entry.schema as PluginSchema))
                }}
              >
                {t('defaults')}
              </Button>
              <Button
                htmlType="submit"
                data-testid="plugin-config-save"
                loading={saving}
                disabled={!canSave || saving || validating || issues.length > 0 || invalidJson.size > 0}
              >
                {t('save')}
              </Button>
            </SettingsToolbar>
          </form>
          <Disclosure variant="plain" data-testid="plugin-config-history" summary={t('audit')}>
            {snapshot.audit
              .filter((fact) => fact.rowId === rowId)
              .map((fact) => (
                <article key={fact.revision}>
                  <p>{t('auditFact', { who: fact.who, when: fact.when })}</p>
                  <pre>{JSON.stringify({ before: fact.before, after: fact.after }, null, 2)}</pre>
                </article>
              ))}
          </Disclosure>
        </>
      )}
    </section>
  )
}
