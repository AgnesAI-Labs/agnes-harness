import type {
  WebhookRequest,
  WebhookResult,
  WebhookRule,
  WebhookSnapshot,
} from '@agnes/protocol/gen/app-server'
import {
  Button,
  Dialog,
  EmptyState,
  Field,
  Icon,
  IconButton,
  ListRow,
  Menu,
  SettingsDetails,
  SettingsInput,
  SettingsSelect,
  SettingsState,
  SettingsTextArea,
  SettingsToolbar,
  StateSwitch,
  Tag,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { contextRequest } from './context.js'
import { useSettingsOverlay } from './overlay.js'
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
  const [formOpen, setFormOpen] = useState(false)
  const [removing, setRemoving] = useState<string>()
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
  useSettingsOverlay(formOpen || !!removing)
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
      if (input.action === 'upsert') setFormOpen(false)
      if (input.action === 'delete') setRemoving(undefined)
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
    <section data-testid="triggers-panel" aria-busy={busy}>
      <SettingsToolbar
        controls={
          <Button
            appearance="primary"
            data-testid="trigger-new"
            disabled={!canSave || busy}
            onClick={() => {
              setRule(blank(workspaces[0] ?? ''))
              setEditing(false)
              setFilters('{"$.action":"opened"}')
              setBundles('')
              setFormOpen(true)
            }}
          >
            {t('new')}
          </Button>
        }
      />
      <p>{t('help')}</p>
      {snapshot && !snapshot.config.enabled && <p>{t('off')}</p>}
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
        <SettingsDetails title={t('receiving')} data-testid="triggers-config-details">
          <section>
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
            <Button
              data-testid="triggers-configure"
              disabled={!canSave || busy}
              onClick={() => void request({ action: 'configure', config: snapshot.config })}
            >
              {t('configure')}
            </Button>
          </section>
        </SettingsDetails>
      )}
      {!busy && snapshot?.rules.length === 0 && (
        <EmptyState icon={<Icon name="activity" size={48} />} title={t('noRules')} description={t('help')} />
      )}
      <div className="agnes-settings-list">
        {snapshot?.rules.map((item) => (
          <ListRow
            key={item.id}
            data-testid="trigger-row"
            title={item.id}
            meta={`${item.event} · ${item.workspace.split(/[\\/]/).filter(Boolean).at(-1) ?? ''}`}
            status={!item.enabled ? <Tag tone="warn">{t('paused')}</Tag> : undefined}
            actions={
              <>
                <Button
                  data-testid={`trigger-edit-${item.id}`}
                  disabled={busy}
                  onClick={() => {
                    setRule(item)
                    setEditing(true)
                    setFormOpen(true)
                    setFilters(JSON.stringify(item.filters, null, 2))
                    setBundles(item.bundles.join(', '))
                  }}
                >
                  {t('edit')}
                </Button>
                <Menu
                  label={t('actions')}
                  trigger={
                    <IconButton
                      name="ellipsis"
                      label={t('actions')}
                      data-testid={`trigger-delete-${item.id}`}
                    />
                  }
                  items={[
                    {
                      id: 'remove',
                      label: t('remove'),
                      danger: true,
                      disabled: !canSave || busy,
                      onSelect: () => setRemoving(item.id),
                    },
                  ]}
                />
              </>
            }
          />
        ))}
      </div>
      <Dialog
        getContainer={() => document.body}
        open={formOpen}
        title={editing ? t('edit') : t('new')}
        onCancel={() => {
          if (!busy) setFormOpen(false)
        }}
        footer={
          <>
            <Button disabled={busy} onClick={() => setFormOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              appearance="primary"
              htmlType="submit"
              form="trigger-editor"
              data-testid="trigger-save"
              disabled={!canSave || busy}
              loading={busy}
            >
              {t('save')}
            </Button>
          </>
        }
      >
        <form
          id="trigger-editor"
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
          <SettingsDetails title={t('connectionSecurity')} data-testid="trigger-security-details">
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
                {[
                  ...new Set([...(snapshot?.secretRefs ?? []), ...(rule.secretRef ? [rule.secretRef] : [])]),
                ].map((ref) => (
                  <option key={ref} value={ref}>
                    {ref.replace(/^secret:\/\//, '').replace(/\//g, ' · ')}
                  </option>
                ))}
              </SettingsSelect>
            </Field>
            {input('secretRef', 'secret')}
            <p>{t('refHelp')}</p>
          </SettingsDetails>
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
          <SettingsDetails title={t('advanced')} data-testid="trigger-advanced">
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
          </SettingsDetails>
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
          <SettingsDetails title={t('deliveryOptions')} data-testid="trigger-delivery-options">
            {input('timestampPath', 'timestamp')}
            {rule.provider === 'github' && <p>{t('githubTime')}</p>}
            {(['windowSeconds', 'ratePerMinute'] as const).map((key) => (
              <Field
                key={key}
                htmlFor={`trigger-${key}`}
                label={t(key === 'windowSeconds' ? 'window' : 'rate')}
              >
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
          </SettingsDetails>
        </form>
        {error && <SettingsState tone="error">{t('failed')}</SettingsState>}
        <SettingsDetails title={t('sample')} data-testid="trigger-test-details">
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
        </SettingsDetails>
      </Dialog>
      <SettingsDetails title={t('recent')} data-testid="trigger-recent-details">
        <h3>{t('recent')}</h3>
        <Button
          data-testid="triggers-refresh"
          disabled={busy}
          onClick={() => void request({ action: 'list' })}
        >
          {t('refresh')}
        </Button>
        {snapshot?.deliveries.length === 0 && <SettingsState>{t('empty')}</SettingsState>}
        <ul className="agnes-settings-list">
          {snapshot?.deliveries.map((item) => (
            <li className="agnes-settings-row" key={item.id} data-testid="trigger-delivery">
              <span>
                {new Date(item.at).toLocaleString(document.documentElement.lang || 'en')} · {item.ruleId} ·{' '}
                {t(item.status)}
              </span>
              {item.sessionId && (
                <a data-testid="trigger-session" href={`/?session=${encodeURIComponent(item.sessionId)}`}>
                  {t('open')}
                </a>
              )}
            </li>
          ))}
        </ul>
      </SettingsDetails>
      <Dialog
        getContainer={() => document.body}
        open={!!removing}
        title={t('remove')}
        onCancel={() => {
          if (!busy) setRemoving(undefined)
        }}
        footer={
          <>
            <Button disabled={busy} onClick={() => setRemoving(undefined)}>
              {t('cancel')}
            </Button>
            <Button
              danger
              dangerFilled
              data-testid="trigger-remove-confirm"
              loading={busy}
              onClick={() => {
                if (removing) void request({ action: 'delete', ruleId: removing })
              }}
            >
              {t('remove')}
            </Button>
          </>
        }
      >
        <p>{t('removeHelp')}</p>
        {error && <SettingsState tone="error">{t('failed')}</SettingsState>}
      </Dialog>
    </section>
  )
}
