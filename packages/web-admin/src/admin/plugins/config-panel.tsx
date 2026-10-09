import type { PluginConfigSnapshot } from '@agnes/protocol'
import {
  Button,
  type PluginFormIssue,
  type PluginSchema,
  PluginSchemaFields,
  pluginSchemaDefault,
  SettingsSelect,
  SettingsToolbar,
  useUiText,
} from '@agnes/web-ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PluginConfigApi } from './config-api.js'
import { PLUGIN_CONFIG_ADMIN_NAMESPACE, pluginConfigAdminCatalog } from './config-locale.js'

export function PluginConfigPanel({
  api,
  id,
  canSave,
}: {
  api: PluginConfigApi
  id: string
  canSave: boolean
}) {
  const { t } = useUiText(PLUGIN_CONFIG_ADMIN_NAMESPACE, pluginConfigAdminCatalog)
  const [snapshot, setSnapshot] = useState<PluginConfigSnapshot>()
  const [rowId, setRowId] = useState('')
  const [draft, setDraft] = useState<unknown>()
  const [issues, setIssues] = useState<readonly PluginFormIssue[]>([])
  const [invalidJson, setInvalidJson] = useState<ReadonlySet<string>>(new Set())
  const [validating, setValidating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
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
    alive.current = true
    const abort = new AbortController()
    void api
      .get(id, abort.signal)
      .then((snapshot) => {
        if (abort.signal.aborted) return
        setSnapshot(snapshot)
        const entry = snapshot.entries[0]
        setRowId(entry?.rowId ?? '')
        setDraft(entry?.value)
        setIssues([])
        setInvalidJson(new Set())
        setNotice('')
      })
      .catch(() => {
        if (!abort.signal.aborted) setNotice('unavailable')
      })
    return () => {
      alive.current = false
      abort.abort()
    }
  }, [api, id, loadVersion])
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
  }, [api, id, entry, draft, invalidJson])
  const change = (value: unknown) => {
    setDraft(value)
    setValidating(true)
    setNotice('')
  }
  const save = async () => {
    if (!snapshot || !entry || issues.length || invalidJson.size || validating || !canSave) return
    setSaving(true)
    try {
      const result = await api.save(id, entry.rowId, draft, snapshot.revision)
      if (!alive.current) return
      setIssues(result.issues)
      setNotice(result.reason === 'saved' ? 'saved' : result.reason)
      if (result.ok) {
        const latest = await api.get(id)
        if (alive.current) {
          if (latest.revision === result.revision) {
            setSnapshot(latest)
            setDraft(latest.entries.find((item) => item.rowId === entry.rowId)?.value)
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
    <section data-testid="plugin-config-panel" aria-label={t('config')}>
      {notice && (
        <p role="status" data-testid="plugin-config-notice">
          {t(notice)}
        </p>
      )}
      {!snapshot && !notice && <p role="status">{t('loading')}</p>}
      {snapshot && !entry && <p>{t('empty')}</p>}
      <SettingsToolbar>
        <Button htmlType="button" disabled={saving} onClick={() => setLoadVersion((value) => value + 1)}>
          {t('reload')}
        </Button>
      </SettingsToolbar>
      {entry && snapshot && (
        <>
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
              }
            }}
          >
            {snapshot.entries.map((entry) => (
              <option key={entry.rowId} value={entry.rowId}>
                {entry.rowId}
              </option>
            ))}
          </SettingsSelect>
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
                disabled={!canSave || saving || validating || issues.length > 0 || invalidJson.size > 0}
              >
                {t('save')}
              </Button>
            </SettingsToolbar>
          </form>
          <details data-testid="plugin-config-history">
            <summary>{t('audit')}</summary>
            {snapshot.audit
              .filter((fact) => fact.rowId === rowId)
              .map((fact) => (
                <article key={fact.revision}>
                  <p>{t('auditFact', { who: fact.who, when: fact.when })}</p>
                  <pre>{JSON.stringify({ before: fact.before, after: fact.after }, null, 2)}</pre>
                </article>
              ))}
          </details>
        </>
      )}
    </section>
  )
}
