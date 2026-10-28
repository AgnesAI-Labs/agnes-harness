import type {
  WebhookRequest,
  WebhookResult,
  WebhookRule,
  WebhookSnapshot,
} from '@agnes/protocol/gen/app-server'
import { useCredentialOptions } from '@agnes/resource-control-web/credentials'
import {
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  Icon,
  IconButton,
  ListRow,
  Loadable,
  Menu,
  PushPage,
  reportSuccess,
  SettingsDetails,
  SettingsGroup,
  SettingsInput,
  SettingsItem,
  SettingsList,
  SettingsPageActions,
  SettingsPageDescription,
  SettingsSection,
  SettingsSelect,
  SettingsState,
  SettingsTextArea,
  StateSwitch,
  StatusDot,
  StatusMessage,
  setResource,
  Tag,
  usePushStack,
  useResource,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { captureRequest } from './async-request.js'
import { contextRequest } from './context.js'
import { useSettingsOverlay } from './overlay.js'
import { triggersRequest } from './triggers-api.js'
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

export { triggersRequest } from './triggers-api.js'

const TRIGGERS_KEY = 'triggers:list'
const TRIGGER_PAGE = 'trigger-'
const NEW_TRIGGER = 'trigger-new'
type TriggersRead = { snapshot: WebhookSnapshot | undefined; workspaces: string[] }

export function TriggersPanel({
  canSave,
  actionsHost,
}: {
  canSave: boolean
  /**
   * Where the page that hosts this panel wants its primary action. Without one, the action and the
   * one-line description go to the enclosing settings page header.
   */
  actionsHost?: HTMLElement | null | undefined
}) {
  const { t } = useUiText('@agnes/web/triggers', triggersCatalog)
  // New and edit open as pages inside Automation: the open page is the address (`view=trigger-…`).
  const nav = usePushStack()
  const top = nav.stack.at(-1)
  const formOpen = top?.startsWith(TRIGGER_PAGE) === true
  const editing = formOpen && top !== NEW_TRIGGER
  const credentials = useCredentialOptions(formOpen)
  const [removing, setRemoving] = useState<string>()
  const lifetime = useRef<AbortController>()
  // The rules and the workspaces a rule may target: one cached read, shown at once on a return visit.
  const list = useResource<TriggersRead>(TRIGGERS_KEY, async () => {
    const [result, context] = await Promise.all([
      triggersRequest({ action: 'list' }, lifetime.current?.signal),
      contextRequest({}, fetch, lifetime.current?.signal),
    ])
    return {
      snapshot: result.snapshot,
      workspaces: context.workspaces.filter((item) => item.available).map((item) => item.path),
    }
  })
  const snapshot = list.data?.snapshot
  const workspaces = list.data?.workspaces ?? []
  /** The settings fields edit the read value in place until they are saved. */
  const setSnapshot = (next: WebhookSnapshot) =>
    setResource<TriggersRead>(TRIGGERS_KEY, { snapshot: next, workspaces })
  const [rule, setRule] = useState<WebhookRule>(blank(''))
  /** The page whose rule the form holds; a link opened directly fills it once the rule is read. */
  const prepared = useRef<string>()
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [notice, setNotice] = useState('')
  const [filtersError, setFiltersError] = useState(false)
  const [payloadError, setPayloadError] = useState(false)
  useSettingsOverlay(formOpen || !!removing)
  // biome-ignore lint/correctness/useExhaustiveDependencies: leaving or reopening a form retires its requests.
  useEffect(() => {
    const abort = new AbortController()
    lifetime.current = abort
    setBusy(false)
    setError(false)
    setNotice('')
    return () => abort.abort()
  }, [top])
  const openRule = (item: WebhookRule) => {
    prepared.current = `${TRIGGER_PAGE}${item.id}`
    setRule(item)
    setFilters(JSON.stringify(item.filters, null, 2))
    setBundles(item.bundles.join(', '))
  }
  const openBlank = () => {
    prepared.current = NEW_TRIGGER
    setRule(blank(workspaces[0] ?? ''))
    setFilters('{"$.action":"opened"}')
    setBundles('')
  }
  // A link (or a reload) that names the form opens it here: a new rule at once, a rule once it is read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the form is prepared once per opened page.
  useEffect(() => {
    if (!formOpen || !top) {
      prepared.current = undefined
      return
    }
    if (prepared.current === top) return
    if (top === NEW_TRIGGER) {
      if (list.data) openBlank()
      return
    }
    const item = snapshot?.rules.find((candidate) => `${TRIGGER_PAGE}${candidate.id}` === top)
    if (item) openRule(item)
  }, [formOpen, top, snapshot, list.data])
  async function request(input: WebhookRequest) {
    if (busy) return
    const request = captureRequest(lifetime)
    setBusy(true)
    setError(false)
    setNotice('')
    try {
      const result = await triggersRequest(input, request.signal)
      if (!request.isCurrent()) return
      const refreshed = result.snapshot ? result : await triggersRequest({ action: 'list' }, request.signal)
      if (!request.isCurrent()) return
      if (refreshed.snapshot)
        setResource<TriggersRead>(TRIGGERS_KEY, { snapshot: refreshed.snapshot, workspaces })
      if (result.delivery) setNotice(result.delivery.status)
      else if (input.action === 'configure' || input.action === 'upsert' || input.action === 'delete') {
        reportSuccess(
          'triggers',
          t(input.action === 'delete' ? 'deleted' : input.action === 'configure' ? 'configured' : 'saved'),
        )
      }
      if (input.action === 'upsert') nav.back()
      if (input.action === 'delete') setRemoving(undefined)
    } catch {
      if (request.isCurrent()) setError(true)
    } finally {
      if (request.isCurrent()) setBusy(false)
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
  const bytes = (value: number) =>
    value % 1048576 === 0
      ? `${value / 1048576} MiB`
      : value % 1024 === 0
        ? `${value / 1024} KiB`
        : `${value} B`
  const moment = (value: number | string) =>
    new Date(value).toLocaleString(document.documentElement.lang || 'en', {
      dateStyle: 'medium',
      timeStyle: 'short',
    })
  const create = (
    <Button
      appearance="primary"
      icon={<Icon name="plus" size={16} />}
      data-testid="trigger-new"
      disabled={!canSave || busy}
      onClick={() => {
        openBlank()
        nav.open(NEW_TRIGGER)
      }}
    >
      {t('new')}
    </Button>
  )
  const folder = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
  return (
    <section data-testid="triggers-panel" className="automation-panel" aria-busy={busy}>
      {actionsHost === undefined ? (
        <>
          <SettingsPageActions>{create}</SettingsPageActions>
          <SettingsPageDescription>{t('intro')}</SettingsPageDescription>
        </>
      ) : (
        actionsHost && createPortal(create, actionsHost)
      )}
      {error && (
        <StatusMessage
          kind="error"
          data-testid="triggers-error"
          action={{ label: t('refresh'), onSelect: list.reload }}
        >
          {t('failed')}
        </StatusMessage>
      )}
      {notice && (
        <StatusMessage
          kind={
            ['accepted', 'pending', 'disabled', 'duplicate', 'no-rule', 'unknown'].includes(notice)
              ? 'pending'
              : 'error'
          }
          data-testid="triggers-notice"
          action={{ label: t('refresh'), onSelect: list.reload }}
        >
          {t(notice)}
        </StatusMessage>
      )}
      <Loadable
        loading={list.loading}
        error={list.error}
        hasData={!!snapshot}
        onRetry={list.reload}
        errorText={t('failed')}
        shape="rows"
      />
      {snapshot && (
        <SettingsGroup>
          {/* The one switch a person needs; it applies at once. */}
          <SettingsItem
            icon="globe"
            label={t('receive')}
            labelId="triggers-enabled-label"
            description={t(snapshot.config.enabled ? 'receiveOn' : 'receiveOff')}
          >
            <StateSwitch
              id="triggers-enabled"
              testId="triggers-enabled"
              label={t('enabled')}
              checked={snapshot.config.enabled}
              disabled={!canSave || busy}
              onToggle={(enabled) =>
                void request({ action: 'configure', config: { ...snapshot.config, enabled } })
              }
            />
          </SettingsItem>
        </SettingsGroup>
      )}
      {snapshot && (
        <SettingsDetails
          card
          icon="sliders-horizontal"
          title={t('receiving')}
          summary={t('endpointSummary', {
            path: snapshot.config.path,
            bytes: bytes(snapshot.config.maxPayloadBytes),
          })}
          data-testid="triggers-config-details"
        >
          <div className="automation-fields">
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
          </div>
          <Button
            loading={busy}
            data-testid="triggers-configure"
            disabled={!canSave || busy}
            onClick={() => void request({ action: 'configure', config: snapshot.config })}
          >
            {t('configure')}
          </Button>
        </SettingsDetails>
      )}
      {snapshot && (
        <SettingsSection
          title={snapshot.rules.length ? t('rulesCount', { count: snapshot.rules.length }) : t('rules')}
          data-testid="trigger-rules"
        >
          {snapshot.rules.length === 0 ? (
            <EmptyState
              icon={<Icon name="activity" size={48} />}
              title={t('noRules')}
              description={t('help')}
            />
          ) : (
            <SettingsList>
              {snapshot.rules.map((item) => (
                <ListRow
                  key={item.id}
                  data-testid="trigger-row"
                  icon={<Icon name="activity" size={16} />}
                  title={item.id}
                  description={[t(item.provider), item.event, folder(item.workspace)]
                    .filter(Boolean)
                    .join(' · ')}
                  status={
                    item.enabled ? (
                      <span className="automation-status">
                        <StatusDot tone="success" />
                        {t('on')}
                      </span>
                    ) : (
                      <Tag tone="warn">{t('paused')}</Tag>
                    )
                  }
                  actions={
                    <>
                      <Button
                        size="small"
                        appearance="ghost"
                        data-testid={`trigger-edit-${item.id}`}
                        disabled={busy}
                        onClick={() => {
                          openRule(item)
                          nav.open(`${TRIGGER_PAGE}${item.id}`)
                        }}
                      >
                        {t('edit')}
                      </Button>
                      <Menu
                        label={t('actionsFor', { name: item.id })}
                        trigger={
                          <IconButton
                            name="ellipsis"
                            label={t('actionsFor', { name: item.id })}
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
            </SettingsList>
          )}
        </SettingsSection>
      )}
      {snapshot && (
        <SettingsSection
          title={t('recent')}
          data-testid="trigger-recent"
          actions={
            <Button
              size="small"
              appearance="ghost"
              data-testid="triggers-refresh"
              disabled={busy}
              onClick={() => void request({ action: 'list' })}
            >
              {t('refresh')}
            </Button>
          }
        >
          {snapshot.deliveries.length === 0 ? (
            <SettingsState>{t('empty')}</SettingsState>
          ) : (
            <SettingsList>
              {snapshot.deliveries.map((item) => (
                <ListRow
                  key={item.id}
                  data-testid="trigger-delivery"
                  data-status={item.status}
                  icon={
                    <span
                      className="automation-mark"
                      data-tone={
                        item.status === 'accepted'
                          ? 'ok'
                          : item.status === 'pending' ||
                              item.status === 'no-rule' ||
                              item.status === 'duplicate'
                            ? undefined
                            : 'bad'
                      }
                    >
                      <Icon
                        name={
                          item.status === 'accepted'
                            ? 'check'
                            : item.status === 'pending'
                              ? 'clock'
                              : item.status === 'no-rule' || item.status === 'duplicate'
                                ? 'info'
                                : 'x'
                        }
                        size={16}
                      />
                    </span>
                  }
                  title={`${moment(item.at)} · ${item.ruleId || '—'}`}
                  description={[
                    t(item.status),
                    item.needsAttention ? t('needsAttention') : '',
                    item.reason ? t(`reason.${item.reason}`) : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  actions={
                    item.sessionId ? (
                      <Button
                        size="small"
                        data-testid="trigger-session"
                        href={`/?session=${encodeURIComponent(item.sessionId)}`}
                      >
                        {t('open')}
                      </Button>
                    ) : undefined
                  }
                />
              ))}
            </SettingsList>
          )}
        </SettingsSection>
      )}
      <PushPage id={formOpen && top ? top : NEW_TRIGGER} title={editing ? t('editTitle') : t('new')}>
        <p className="automation-dialog-lead">{t('formLead')}</p>
        <form
          id="trigger-editor"
          className="automation-form"
          onSubmit={(event) => {
            event.preventDefault()
            setFiltersError(false)
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
              setFiltersError(true)
              document.getElementById('trigger-filters')?.focus()
            }
          }}
        >
          {/* The form's own fields share one frame; the folds below stay separate cards. */}
          <div className="automation-form-card">
            <div className="automation-fields">
              {input('id', 'id')}
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
              <Field htmlFor="trigger-secret-picker" label={t('secretLabel')} hint={t('secretHelp')}>
                <SettingsSelect
                  id="trigger-secret-picker"
                  data-testid="trigger-secret-picker"
                  value={rule.secretRef}
                  disabled={!canSave || busy}
                  onChange={(event) => set('secretRef', event.target.value)}
                >
                  <option value="">{t('choose')}</option>
                  {[
                    ...new Set([
                      ...credentials.map((item) => item.value),
                      ...(snapshot?.secretRefs ?? []),
                      ...(rule.secretRef ? [rule.secretRef] : []),
                    ]),
                  ].map((ref) => (
                    <option key={ref} value={ref}>
                      {credentials.find((item) => item.value === ref)?.label ??
                        ref.replace(/^secret:\/\//, '').replace(/\//g, ' · ')}
                    </option>
                  ))}
                </SettingsSelect>
              </Field>
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
              {input('event', 'event')}
              <Field label={t('approvalBehavior')}>
                <SettingsSelect
                  data-testid="trigger-approval-behavior"
                  disabled={busy}
                  value={rule.unattendedApproval ?? 'notify'}
                  onChange={(event) =>
                    setRule({ ...rule, unattendedApproval: event.target.value as 'notify' | 'refuse' })
                  }
                >
                  <option value="notify">{t('approvalNotify')}</option>
                  <option value="refuse">{t('approvalRefuse')}</option>
                </SettingsSelect>
              </Field>
            </div>
            <Field htmlFor="trigger-template" label={t('template')} hint={t('templateHelp')}>
              <SettingsTextArea
                id="trigger-template"
                data-testid="trigger-template"
                rows={4}
                required
                value={rule.template}
                disabled={!canSave || busy}
                onChange={(event) => set('template', event.target.value)}
              />
            </Field>
            {/* The one switch a saved trigger needs: named on the left, flipped on the right. */}
            <div className="automation-form-switch">
              <label htmlFor="trigger-active">{t('active')}</label>
              <StateSwitch
                id="trigger-active"
                testId="trigger-active"
                label={t('active')}
                checked={rule.enabled}
                disabled={!canSave || busy}
                onToggle={(enabled) => set('enabled', enabled)}
              />
            </div>
          </div>
          <SettingsDetails
            card
            title={t('advanced')}
            summary={t('advancedSummary')}
            data-testid="trigger-advanced"
          >
            <div className="automation-fields">
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
            </div>
            <Field
              htmlFor="trigger-filters"
              label={t('filters')}
              error={filtersError ? t('jsonError') : undefined}
            >
              <SettingsTextArea
                id="trigger-filters"
                data-testid="trigger-filters"
                rows={3}
                value={filters}
                disabled={!canSave || busy}
                onChange={(event) => {
                  setFilters(event.target.value)
                  setFiltersError(false)
                }}
              />
            </Field>
            {input('secretRef', 'refLabel')}
            <p className="automation-note">{t('refHelp')}</p>
            {input('timestampPath', 'timestamp')}
            {rule.provider === 'github' && <p className="automation-note">{t('githubTime')}</p>}
            <div className="automation-fields">
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
            </div>
          </SettingsDetails>
        </form>
        {error && <SettingsState tone="error">{t('failed')}</SettingsState>}
        <SettingsDetails
          card
          title={t('testTitle')}
          summary={t('testSummary')}
          data-testid="trigger-test-details"
        >
          <Field
            htmlFor="trigger-sample"
            label={t('sample')}
            hint={t('testHelp')}
            error={payloadError ? t('jsonError') : undefined}
          >
            <SettingsTextArea
              id="trigger-sample"
              data-testid="trigger-sample"
              rows={6}
              value={payload}
              disabled={busy}
              onChange={(event) => {
                setPayload(event.target.value)
                setPayloadError(false)
              }}
            />
          </Field>
          <Button
            loading={busy}
            data-testid="trigger-test"
            disabled={!canSave || busy || !snapshot?.rules.some((item) => item.id === rule.id)}
            disabledReason={t('testNeedsSave')}
            onClick={() => {
              try {
                void request({ action: 'test', ruleId: rule.id, payload: JSON.parse(payload) })
              } catch {
                setPayloadError(true)
                document.getElementById('trigger-sample')?.focus()
              }
            }}
          >
            {t('test')}
          </Button>
        </SettingsDetails>
        <div className="home-push-actions">
          <Button disabled={busy} onClick={nav.back}>
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
        </div>
      </PushPage>
      <ConfirmDialog
        open={!!removing}
        title={t('removeTitle')}
        confirmLabel={t('remove')}
        cancelLabel={t('cancel')}
        destructive
        busy={busy}
        testIds={{ confirm: 'trigger-remove-confirm' }}
        onCancel={() => setRemoving(undefined)}
        onConfirm={() => {
          if (removing) void request({ action: 'delete', ruleId: removing })
        }}
      >
        <p>{t('removeHelp')}</p>
        {error && <SettingsState tone="error">{t('failed')}</SettingsState>}
      </ConfirmDialog>
    </section>
  )
}
