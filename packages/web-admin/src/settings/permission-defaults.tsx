import { isSessionDefaultsSnapshot, type RuntimeSecurityStatus } from '@agnes/protocol'
import {
  Banner,
  Button,
  Dialog,
  Disclosure,
  fallbackT,
  Icon,
  IconTile,
  reportSuccess,
  SettingsBlock,
  SettingsChoice,
  SettingsItem,
  SettingsSelect,
  SettingsState,
  SettingsTag,
  StatusDot,
  type StatusDotTone,
  trackPageRequest,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { PluginAdminApi } from '../admin/plugins/api.js'
import { SETTINGS_NAMESPACE, settingsCatalog } from './locales.js'
import { useSettingsOverlay } from './overlay.js'
import { SECURITY_NAMESPACE, securityUxCatalog } from './security-locale.js'

type Snapshot = import('@agnes/protocol').SessionDefaultsSnapshot
const presets = ['read-only', 'workspace-write', 'full-access'] as const
const icons = { 'read-only': 'eye', 'workspace-write': 'pencil', 'full-access': 'lock-keyhole' } as const
/** Limits full access does not relax (docs/guide/security.md#full-access-exceptions). */
const exceptions = {
  protected: 'shield',
  readFirst: 'file-text',
  plugins: 'puzzle',
  memory: 'archive',
  candidateTests: 'terminal',
} as const
const isolationTone: Record<RuntimeSecurityStatus['platform']['l1']['level'], StatusDotTone> = {
  full: 'success',
  partial: 'warning',
  unavailable: 'danger',
  unprobed: 'neutral',
}
export function PermissionDefaults({
  available,
  security,
  fetcher = fetch,
}: {
  available: readonly string[]
  /** This computer's command isolation, stated under the workspace card. */
  security?: RuntimeSecurityStatus | undefined
  fetcher?: typeof fetch
}) {
  const { t } = useUiText(SECURITY_NAMESPACE, securityUxCatalog)
  const { t: choiceText } = useUiText(SETTINGS_NAMESPACE, settingsCatalog)
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [canSave, setCanSave] = useState(false)
  const [lockReason, setLockReason] = useState<'lockedReadOnly' | 'lockedPermission'>()
  const [effective, setEffective] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState<string>()
  const [readFailed, setReadFailed] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  // Another place saved the defaults first: they are read again and the choice waits for a retry.
  const [conflict, setConflict] = useState(false)
  const [failedPreset, setFailedPreset] = useState<string>()
  const [confirm, setConfirm] = useState(false)
  const [revision, setRevision] = useState(0)
  const lifetime = useRef<AbortController>()
  useSettingsOverlay(confirm)
  // biome-ignore lint/correctness/useExhaustiveDependencies: the retry counter explicitly starts a fresh read.
  useEffect(() => {
    const abort = new AbortController()
    lifetime.current = abort
    setBusy(true)
    setReadFailed(false)
    // Effective composition is supplemental; a plugin catalog must not hold up saved defaults.
    setEffective(undefined)
    void fetcher('/admin/api/composition', {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: abort.signal,
    })
      .then(async (response) => {
        if (!response.ok) return
        const resolved: unknown = await response.json()
        if (!abort.signal.aborted && resolved && typeof resolved === 'object' && 'preset' in resolved)
          setEffective(typeof resolved.preset === 'string' ? resolved.preset : undefined)
      })
      .catch(() => {})
    void trackPageRequest(
      Promise.all([
        fetcher('/admin/api/defaults', {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: abort.signal,
        }),
        PluginAdminApi.context((url, init) => fetcher(url, { ...init, signal: abort.signal })),
      ]),
    )
      .then(async ([defaults, context]) => {
        if (!defaults.ok) throw new Error('defaults unavailable')
        const value = await defaults.json()
        const picked: unknown = { revision: value.revision, defaults: value.defaults }
        if (!isSessionDefaultsSnapshot(picked)) throw new Error('invalid defaults')
        if (!abort.signal.aborted) {
          const activate = context.permissions.includes('packages.activate')
          setCanSave(!context.readOnly && activate)
          setLockReason(context.readOnly ? 'lockedReadOnly' : activate ? undefined : 'lockedPermission')
          setSnapshot(picked as Snapshot)
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) setReadFailed(true)
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false)
      })
    return () => abort.abort()
  }, [fetcher, revision])
  // New-session defaults saved elsewhere (run configuration, another window's save) are read again.
  useEffect(() => {
    const reread = () => setRevision((value) => value + 1)
    window.addEventListener('agnes:session-configuration-changed', reread)
    return () => window.removeEventListener('agnes:session-configuration-changed', reread)
  }, [])
  async function save(preset: string) {
    if (!canSave || !snapshot || busy || !available.includes(preset)) return
    setBusy(true)
    setSaving(preset)
    setSaveFailed(false)
    setConflict(false)
    setFailedPreset(preset)
    try {
      const response = await fetcher('/admin/api/defaults', {
        method: 'PUT',
        credentials: 'same-origin',
        signal: lifetime.current?.signal ?? null,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision: snapshot.revision, defaults: { ...snapshot.defaults, preset } }),
      })
      if (response.status === 409) {
        // The revision this page read is stale. Read the current defaults; the retry then saves the
        // same choice against them instead of repeating the stale revision.
        if (lifetime.current?.signal.aborted) return
        setConflict(true)
        setSaveFailed(true)
        setRevision((value) => value + 1)
        return
      }
      const value: unknown = await response.json()
      if (!response.ok || !isSessionDefaultsSnapshot(value)) throw new Error('save failed')
      if (lifetime.current?.signal.aborted) return
      window.dispatchEvent(new CustomEvent('agnes:session-configuration-changed'))
      setSnapshot(value as Snapshot)
      reportSuccess('permission-defaults', fallbackT('ui.defaultsSaved'))
      setConfirm(false)
      setFailedPreset(undefined)
    } catch {
      if (!lifetime.current?.signal.aborted) setSaveFailed(true)
    } finally {
      if (!lifetime.current?.signal.aborted) {
        setBusy(false)
        setSaving(undefined)
      }
    }
  }
  // Only what is stored is shown as chosen; a choice in flight shows on its own card until it lands.
  const stored = snapshot?.defaults.preset ?? effective
  const chosen = saving ?? stored
  const more = available.filter((preset) => !(presets as readonly string[]).includes(preset))
  const name = (id: string | undefined) => {
    if (!id) return '—'
    const text = choiceText(`choice.${id}`)
    return text === `choice.${id}` ? id : text
  }
  const isolation = (preset: (typeof presets)[number]): [StatusDotTone, string] => {
    if (preset === 'read-only') return ['neutral', t('noCommands')]
    if (preset === 'full-access') return ['warning', t('notIsolated')]
    if (!security) return ['neutral', t('isolationUnknown')]
    if (security.presetPolicies.find((policy) => policy.id === preset)?.level === 'L0')
      return ['warning', t('notIsolated')]
    const level = security.platform.l1.level
    return [isolationTone[level], `${t('commandIsolation')} · ${t(`state.${level}`)}`]
  }
  const exceptionList = (detailed: boolean) => (
    <ul className="agnes-settings-exceptions" data-testid={detailed ? 'security-full-exceptions' : undefined}>
      {Object.entries(exceptions).map(([key, icon]) => (
        <li key={key}>
          <Icon name={detailed ? icon : 'check'} />
          <span>
            <span className="agnes-settings-exception-name">{t(`exception.${key}`)}</span>
            {detailed && <span className="agnes-settings-exception-hint">{t(`exception.${key}Help`)}</span>}
          </span>
        </li>
      ))}
    </ul>
  )
  const locked = !canSave || !snapshot || busy
  const retry = () => failedPreset && void save(failedPreset)
  return (
    <SettingsBlock
      label={t('defaultPermissions')}
      bare
      data-testid="security-default-permissions"
      aria-busy={busy}
      state={readFailed && !snapshot ? 'error' : busy && !snapshot ? 'loading' : undefined}
      onReload={() => setRevision((value) => value + 1)}
    >
      <p className="agnes-settings-note">{t('defaultHelp')}</p>
      {snapshot && lockReason && <Banner data-testid="security-default-locked">{t(lockReason)}</Banner>}
      {snapshot && stored && !(presets as readonly string[]).includes(stored) && (
        <Banner data-testid="security-default-other">{t('otherPreset', { name: name(stored) })}</Banner>
      )}
      {/* While a save or reread is in flight the cards wait without greying out (data-busy). */}
      <fieldset
        className="agnes-settings-modes"
        aria-label={t('defaultPermissions')}
        data-busy={(busy && !!snapshot) || undefined}
      >
        {presets.map((preset) => {
          const allowed = available.includes(preset)
          const [tone, status] = isolation(preset)
          return (
            <div key={preset} data-testid={`security-${preset}`} data-on={chosen === preset || undefined}>
              <SettingsChoice
                type="radio"
                name="security-default-preset"
                value={preset}
                checked={chosen === preset}
                disabled={locked || !allowed}
                preview={<IconTile name={icons[preset]} />}
                label={
                  <>
                    {t(preset)}
                    {preset === 'workspace-write' && (
                      <SettingsTag tone="muted">{t('recommended')}</SettingsTag>
                    )}
                    {!allowed && <SettingsTag tone="muted">{t('notAllowed')}</SettingsTag>}
                  </>
                }
                hint={t(`${preset}Help`)}
                onChange={() => {
                  if (preset === 'full-access') setConfirm(true)
                  else void save(preset)
                }}
              />
              <div className="agnes-settings-mode-foot">
                <span data-testid={`security-${preset}-isolation`}>
                  <StatusDot tone={saving === preset ? 'accent' : tone} running={saving === preset} />
                  {saving === preset ? t('saving') : status}
                </span>
                {preset === 'full-access' && (
                  <Disclosure
                    variant="plain"
                    summary={t('exceptionsToggle')}
                    summaryProps={{ 'data-testid': 'security-full-exceptions-toggle' }}
                  >
                    {exceptionList(true)}
                    <p className="agnes-settings-note">{t('exceptionsScope')}</p>
                  </Disclosure>
                )}
              </div>
            </div>
          )
        })}
      </fieldset>
      {saveFailed && snapshot && failedPreset && (
        <Banner
          tone={conflict ? 'warning' : 'error'}
          data-testid={conflict ? 'security-default-conflict' : 'security-default-failed'}
          action={
            <Button size="small" data-testid="security-default-retry" onClick={retry}>
              {conflict ? t('retryChoice', { chosen: name(failedPreset) }) : t('retry')}
            </Button>
          }
        >
          {t(conflict ? 'conflict' : 'saveFailed', { actual: name(stored), chosen: name(failedPreset) })}
        </Banner>
      )}
      {more.length > 0 && (
        <SettingsBlock>
          <SettingsItem label={t('morePresets')} description={t('morePresetsHelp')}>
            <SettingsSelect
              data-testid="security-more-presets"
              aria-label={t('morePresets')}
              value={chosen && more.includes(chosen) ? chosen : ''}
              disabled={locked}
              onChange={(event) => event.target.value && void save(event.target.value)}
            >
              <option value="">{t('morePresetsNone')}</option>
              {more.map((preset) => (
                <option key={preset} value={preset}>
                  {name(preset)}
                </option>
              ))}
            </SettingsSelect>
          </SettingsItem>
        </SettingsBlock>
      )}
      <Dialog
        focusable={{ focusTriggerAfterClose: false }}
        scrollLock={false}
        getContainer={() => document.body}
        open={confirm}
        title={t('fullConfirm')}
        onCancel={() => {
          if (!busy) setConfirm(false)
        }}
        footer={
          <>
            <Button disabled={busy} onClick={() => setConfirm(false)}>
              {t('keepCurrent')}
            </Button>
            <Button
              danger
              dangerFilled
              loading={busy}
              data-testid="security-full-confirm"
              onClick={() => void save('full-access')}
            >
              {t('fullConfirmAction')}
            </Button>
          </>
        }
      >
        <p>{t('fullConfirmBody')}</p>
        <div className="agnes-settings-exceptions-box">
          <p className="agnes-settings-exception-name">{t('fullConfirmList')}</p>
          {exceptionList(false)}
        </div>
        {saveFailed && <SettingsState tone="error">{t('failed')}</SettingsState>}
      </Dialog>
    </SettingsBlock>
  )
}
