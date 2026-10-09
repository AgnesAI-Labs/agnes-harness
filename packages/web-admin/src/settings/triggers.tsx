import type {
  WebhookRequest,
  WebhookResult,
  WebhookRule,
  WebhookSnapshot,
} from '@agnes/protocol/gen/app-server'
import {
  Button,
  Field,
  SettingsCard,
  SettingsInput,
  SettingsSelect,
  SettingsState,
  SettingsTextArea,
  SettingsToolbar,
  StateSwitch,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { contextRequest } from './context.js'
import { triggersCatalog } from './triggers-locale.js'

const blank = (workspace: string): WebhookRule => ({
  id: '',
  enabled: true,
  provider: 'github',
  auth: 'hmac',
  secretRef: '',
  event: 'issues',
  filters: { '$.action': 'opened' },
  workspace,
  agent: 'workspace-write',
  bundles: [],
  template: 'Review this issue: {{$.issue.title}}',
  timestampPath: '$.issue.updated_at',
  windowSeconds: 300,
  ratePerMinute: 10,
})
export async function triggersRequest(input: WebhookRequest, signal?: AbortSignal): Promise<WebhookResult> {
  const response = await fetch('/api/triggers', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) throw new Error('Trigger request failed')
  return response.json()
}
export function TriggersPanel({ canSave }: { canSave: boolean }) {
  const { t } = useUiText('@agnes/web/triggers', triggersCatalog)
  const lifetime = useRef<AbortController>()
  const [snapshot, setSnapshot] = useState<WebhookSnapshot>()
  const [workspaces, setWorkspaces] = useState<string[]>([])
  const [rule, setRule] = useState<WebhookRule>(blank(''))
  const [editing, setEditing] = useState(false)
  const [filters, setFilters] = useState('{"$.action":"opened"}')
  const [bundles, setBundles] = useState('')
  const [payload, setPayload] = useState(() =>
    JSON.stringify(
      {
        action: 'opened',
        issue: { title: t('syntheticEvent'), updated_at: new Date().toISOString() },
      },
      null,
      2,
    ),
  )
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState(false)
  const [notice, setNotice] = useState('')
  useEffect(() => {
    const abort = new AbortController()
    lifetime.current = abort
    void Promise.all([
      triggersRequest({ action: 'list' }, abort.signal),
      contextRequest({}, fetch, abort.signal),
    ])
      .then(([result, context]) => {
        if (abort.signal.aborted) return
        setSnapshot(result.snapshot)
        const paths = context.workspaces.filter((item) => item.available).map((item) => item.path)
        setWorkspaces(paths)
        setRule(blank(paths[0] ?? ''))
      })
      .catch(() => {
        if (!abort.signal.aborted) setError(true)
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false)
      })
    return () => abort.abort()
  }, [])
  async function request(input: WebhookRequest) {
    if (busy) return
    setBusy(true)
    setError(false)
    setNotice('')
    try {
      const result = await triggersRequest(input, lifetime.current?.signal)
      const refreshed = result.snapshot
        ? result
        : await triggersRequest({ action: 'list' }, lifetime.current?.signal)
      if (lifetime.current?.signal.aborted) return
      setSnapshot(refreshed.snapshot)
      setNotice(result.delivery?.status ?? 'saved')
    } catch {
      if (!lifetime.current?.signal.aborted) setError(true)
    } finally {
      if (!lifetime.current?.signal.aborted) setBusy(false)
    }
  }
  const set = <K extends keyof WebhookRule>(key: K, value: WebhookRule[K]) =>
    setRule((current) => ({ ...current, [key]: value }))
  const input = (
    key: 'id' | 'workspace' | 'agent' | 'event' | 'secretRef' | 'timestampPath' | 'template',
    label: string,
  ) => (
    <Field htmlFor={`trigger-${key}`} label={t(label)}>
      <SettingsInput
        id={`trigger-${key}`}
        data-testid={`trigger-${key}`}
        required
        value={rule[key]}
        disabled={!canSave || busy || (key === 'id' && editing)}
        onChange={(event) => set(key, event.target.value)}
      />
    </Field>
  )
  return (
    <SettingsCard data-testid="triggers-panel" aria-busy={busy}>
      <p>{t('help')}</p>
      <p>{t('off')}</p>
      {error && (
        <SettingsState tone="error" role="alert" data-testid="triggers-error">
          {t('failed')}
        </SettingsState>
      )}
      {notice && (
        <SettingsState
          tone={
            notice === 'saved' || notice === 'accepted'
              ? 'success'
              : notice === 'pending' ||
                  notice === 'disabled' ||
                  notice === 'duplicate' ||
                  notice === 'no-rule'
                ? 'empty'
                : 'error'
          }
          role="status"
          data-testid="triggers-notice"
        >
          {t(notice)}
        </SettingsState>
      )}
      {snapshot && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void request({ action: 'configure', config: snapshot.config })
          }}
        >
          <Field label={t('enabled')} htmlFor="triggers-enabled">
            <StateSwitch
              id="triggers-enabled"
              testId="triggers-enabled"
              label={t('enabled')}
              checked={snapshot.config.enabled}
              disabled={!canSave || busy}
              onToggle={(enabled) => setSnapshot({ ...snapshot, config: { ...snapshot.config, enabled } })}
            />
          </Field>
          <Field htmlFor="triggers-path" label={t('path')}>
            <SettingsInput
              id="triggers-path"
              data-testid="triggers-path"
              value={snapshot.config.path}
              disabled={!canSave || busy}
              onChange={(event) =>
                setSnapshot({ ...snapshot, config: { ...snapshot.config, path: event.target.value } })
              }
            />
          </Field>
          <Field htmlFor="triggers-bytes" label={t('bytes')}>
            <SettingsInput
              id="triggers-bytes"
              type="number"
              min={1}
              max={1048576}
              value={snapshot.config.maxPayloadBytes}
              disabled={!canSave || busy}
              onChange={(event) =>
                setSnapshot({
                  ...snapshot,
                  config: { ...snapshot.config, maxPayloadBytes: Number(event.target.value) },
                })
              }
            />
          </Field>
          <Button htmlType="submit" data-testid="triggers-configure" disabled={!canSave || busy}>
            {t('configure')}
          </Button>
        </form>
      )}
      <h3>{t('rules')}</h3>
      <ul className="agnes-settings-list">
        {snapshot?.rules.map((item) => (
          <li className="agnes-settings-row" key={item.id} data-testid="trigger-row">
            <span>
              {item.id} · {item.provider} · {item.event} · {item.workspace}
            </span>
            <SettingsToolbar>
              <Button
                data-testid={`trigger-edit-${item.id}`}
                disabled={busy}
                onClick={() => {
                  setRule(item)
                  setEditing(true)
                  setFilters(JSON.stringify(item.filters, null, 2))
                  setBundles(item.bundles.join(', '))
                }}
              >
                {t('edit')}
              </Button>
              <Button
                data-testid={`trigger-delete-${item.id}`}
                disabled={!canSave || busy}
                onClick={() => void request({ action: 'delete', ruleId: item.id })}
              >
                {t('remove')}
              </Button>
            </SettingsToolbar>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          try {
            void request({
              action: 'upsert',
              rule: {
                ...rule,
                filters: JSON.parse(filters),
                bundles: bundles
                  .split(',')
                  .map((value) => value.trim())
                  .filter(Boolean),
              },
            })
          } catch {
            setError(true)
          }
        }}
      >
        {input('id', 'id')}
        <Field label={t('active')} htmlFor="trigger-active">
          <StateSwitch
            id="trigger-active"
            testId="trigger-active"
            label={t('active')}
            checked={rule.enabled}
            disabled={!canSave || busy}
            onToggle={(enabled) => set('enabled', enabled)}
          />
        </Field>
        <Field htmlFor="trigger-provider" label={t('provider')}>
          <SettingsSelect
            id="trigger-provider"
            data-testid="trigger-provider"
            value={rule.provider}
            disabled={!canSave || busy}
            onChange={(event) => {
              set('provider', event.target.value as WebhookRule['provider'])
              set('auth', 'hmac')
            }}
          >
            <option value="github">{t('github')}</option>
            <option value="generic">{t('generic')}</option>
          </SettingsSelect>
        </Field>
        <Field htmlFor="trigger-auth" label={t('auth')}>
          <SettingsSelect
            id="trigger-auth"
            data-testid="trigger-auth"
            value={rule.auth}
            disabled={!canSave || busy || rule.provider === 'github'}
            onChange={(event) => set('auth', event.target.value as WebhookRule['auth'])}
          >
            <option value="hmac">{t('hmac')}</option>
            <option value="bearer">{t('bearer')}</option>
          </SettingsSelect>
        </Field>
        <Field htmlFor="trigger-secret-picker" label={t('secretLabel')}>
          <SettingsSelect
            id="trigger-secret-picker"
            data-testid="trigger-secret-picker"
            value={rule.secretRef}
            disabled={!canSave || busy}
            onChange={(event) => set('secretRef', event.target.value)}
          >
            <option value="">{t('choose')}</option>
            {[...new Set([...(snapshot?.secretRefs ?? []), ...(rule.secretRef ? [rule.secretRef] : [])])].map(
              (ref) => (
                <option key={ref} value={ref}>
                  {ref}
                </option>
              ),
            )}
          </SettingsSelect>
        </Field>
        {input('secretRef', 'secret')}
        <p>{t('refHelp')}</p>
        <Field htmlFor="trigger-workspace" label={t('workspace')}>
          <SettingsSelect
            id="trigger-workspace"
            data-testid="trigger-workspace"
            required
            value={rule.workspace}
            disabled={!canSave || busy}
            onChange={(event) => set('workspace', event.target.value)}
          >
            {workspaces.map((path) => (
              <option key={path} value={path}>
                {path}
              </option>
            ))}
          </SettingsSelect>
        </Field>
        {input('agent', 'agent')}
        <Field htmlFor="trigger-bundles" label={t('bundles')}>
          <SettingsInput
            id="trigger-bundles"
            data-testid="trigger-bundles"
            value={bundles}
            disabled={!canSave || busy}
            onChange={(event) => setBundles(event.target.value)}
          />
        </Field>
        {input('event', 'event')}
        <Field htmlFor="trigger-filters" label={t('filters')}>
          <SettingsTextArea
            id="trigger-filters"
            data-testid="trigger-filters"
            rows={3}
            value={filters}
            disabled={!canSave || busy}
            onChange={(event) => setFilters(event.target.value)}
          />
        </Field>
        <Field htmlFor="trigger-template" label={t('template')}>
          <SettingsTextArea
            id="trigger-template"
            data-testid="trigger-template"
            rows={3}
            required
            value={rule.template}
            disabled={!canSave || busy}
            onChange={(event) => set('template', event.target.value)}
          />
        </Field>
        <p>{t('templateHelp')}</p>
        {input('timestampPath', 'timestamp')}
        {rule.provider === 'github' && <p>{t('githubTime')}</p>}
        {(['windowSeconds', 'ratePerMinute'] as const).map((key) => (
          <Field key={key} htmlFor={`trigger-${key}`} label={t(key === 'windowSeconds' ? 'window' : 'rate')}>
            <SettingsInput
              id={`trigger-${key}`}
              data-testid={`trigger-${key}`}
              type="number"
              min={1}
              max={key === 'windowSeconds' ? 86400 : 1000}
              value={rule[key]}
              disabled={!canSave || busy}
              onChange={(event) => set(key, Number(event.target.value))}
            />
          </Field>
        ))}
        <SettingsToolbar>
          <Button htmlType="submit" data-testid="trigger-save" disabled={!canSave || busy}>
            {t('save')}
          </Button>
          <Button
            data-testid="trigger-new"
            disabled={busy}
            onClick={() => {
              setRule(blank(workspaces[0] ?? ''))
              setEditing(false)
              setFilters('{"$.action":"opened"}')
              setBundles('')
            }}
          >
            {t('new')}
          </Button>
        </SettingsToolbar>
      </form>
      <h3>{t('sample')}</h3>
      <p>{t('testHelp')}</p>
      <Field htmlFor="trigger-sample" label={t('sample')}>
        <SettingsTextArea
          id="trigger-sample"
          data-testid="trigger-sample"
          rows={6}
          value={payload}
          disabled={busy}
          onChange={(event) => setPayload(event.target.value)}
        />
      </Field>
      <Button
        data-testid="trigger-test"
        disabled={!canSave || busy || !snapshot?.rules.some((item) => item.id === rule.id)}
        onClick={() => {
          try {
            void request({ action: 'test', ruleId: rule.id, payload: JSON.parse(payload) })
          } catch {
            setError(true)
          }
        }}
      >
        {t('test')}
      </Button>
      <h3>{t('recent')}</h3>
      <Button data-testid="triggers-refresh" disabled={busy} onClick={() => void request({ action: 'list' })}>
        {t('refresh')}
      </Button>
      {snapshot?.deliveries.length === 0 && <SettingsState>{t('empty')}</SettingsState>}
      <ul className="agnes-settings-list">
        {snapshot?.deliveries.map((item) => (
          <li className="agnes-settings-row" key={item.id} data-testid="trigger-delivery">
            <span>
              {new Date(item.at).toLocaleString()} · {item.ruleId} · {t(item.status)}
            </span>
            {item.sessionId && (
              <a data-testid="trigger-session" href={`/?session=${encodeURIComponent(item.sessionId)}`}>
                {t('open')}
              </a>
            )}
          </li>
        ))}
      </ul>
    </SettingsCard>
  )
}
