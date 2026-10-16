import { isSessionDefaultsSnapshot } from '@agnes/protocol'
import {
  Button,
  Dialog,
  fallbackT,
  reportSuccess,
  Segmented,
  SettingsBlock,
  SettingsItem,
  SettingsSelect,
  SettingsState,
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
export function PermissionDefaults({
  available,
  fetcher = fetch,
}: {
  available: readonly string[]
  fetcher?: typeof fetch
}) {
  const { t } = useUiText(SECURITY_NAMESPACE, securityUxCatalog)
  const { t: choiceText } = useUiText(SETTINGS_NAMESPACE, settingsCatalog)
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [canSave, setCanSave] = useState(false)
  const [effective, setEffective] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [readFailed, setReadFailed] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  // Another place saved the defaults first: they are read again and the choice waits for 重试.
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
    void trackPageRequest(
      Promise.all([
        fetcher('/admin/api/loops', { credentials: 'same-origin', cache: 'no-store', signal: abort.signal }),
        PluginAdminApi.context((url, init) => fetcher(url, { ...init, signal: abort.signal })),
        fetcher('/admin/api/composition', {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: abort.signal,
        }),
      ]),
    )
      .then(async ([defaults, context, composition]) => {
        if (!defaults.ok || !composition.ok) throw new Error('defaults unavailable')
        const value = await defaults.json()
        const resolved = await composition.json()
        const picked: unknown = { revision: value.revision, defaults: value.defaults }
        if (!isSessionDefaultsSnapshot(picked)) throw new Error('invalid defaults')
        if (!abort.signal.aborted) {
          setCanSave(!context.readOnly && context.permissions.includes('packages.activate'))
          setSnapshot(picked as Snapshot)
          setEffective(typeof resolved.preset === 'string' ? resolved.preset : undefined)
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
        // The revision this page read is stale. Read the current defaults; 重试 then saves the
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
      if (!lifetime.current?.signal.aborted) setBusy(false)
    }
  }
  // A choice whose save failed stays shown until it is retried or another is made.
  const chosen = (saveFailed ? failedPreset : undefined) ?? snapshot?.defaults.preset ?? effective
  const more = available.filter((preset) => !(presets as readonly string[]).includes(preset))
  const name = (id: string) => {
    const text = choiceText(`choice.${id}`)
    return text === `choice.${id}` ? id : text
  }
  const locked = !canSave || !snapshot || busy
  return (
    <SettingsBlock
      label={t('defaultPermissions')}
      bare
      data-testid="security-default-permissions"
      aria-busy={busy}
      failed={saveFailed && !!snapshot}
      onRetry={() => failedPreset && void save(failedPreset)}
      state={readFailed && !snapshot ? 'error' : busy && !snapshot ? 'loading' : undefined}
      onReload={() => setRevision((value) => value + 1)}
    >
      {conflict && (
        <p className="agnes-settings-note" role="status" data-testid="security-default-conflict">
          {t('conflict')}
        </p>
      )}
      <Segmented
        label={t('defaultPermissions')}
        name="security-default-preset"
        value={chosen ?? ''}
        disabled={locked}
        options={presets.map((preset) => ({
          value: preset,
          label: t(preset),
          testId: `security-${preset}`,
          disabled: !available.includes(preset),
        }))}
        onChange={(preset) => {
          if (preset === 'full-access') setConfirm(true)
          else void save(preset)
        }}
      />
      <p className="agnes-settings-note">{chosen ? t(`${chosen}Help`) : t('notAllowed')}</p>
      {more.length > 0 && (
        <SettingsBlock>
          <SettingsItem label={t('morePresets')} info={t('morePresetsHelp')}>
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
              {t('cancel')}
            </Button>
            <Button
              danger
              dangerFilled
              loading={busy}
              data-testid="security-full-confirm"
              onClick={() => void save('full-access')}
            >
              {t('full-access')}
            </Button>
          </>
        }
      >
        <p>{t('full-accessHelp')}</p>
        {saveFailed && <SettingsState tone="error">{t('failed')}</SettingsState>}
      </Dialog>
    </SettingsBlock>
  )
}
