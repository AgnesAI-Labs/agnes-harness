import { isSessionDefaultsSnapshot } from '@agnes/protocol'
import {
  Button,
  Dialog,
  SettingsBlock,
  SettingsChoice,
  SettingsItem,
  SettingsSelect,
  SettingsState,
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
  const [error, setError] = useState(false)
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
    setError(false)
    void Promise.all([
      fetcher('/admin/api/loops', { credentials: 'same-origin', cache: 'no-store', signal: abort.signal }),
      PluginAdminApi.context((url, init) => fetcher(url, { ...init, signal: abort.signal })),
      fetcher('/admin/api/composition', {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: abort.signal,
      }),
    ])
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
        if (!abort.signal.aborted) setError(true)
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false)
      })
    return () => abort.abort()
  }, [fetcher, revision])
  async function save(preset: string) {
    if (!canSave || !snapshot || busy || !available.includes(preset)) return
    setBusy(true)
    setError(false)
    setFailedPreset(preset)
    try {
      const response = await fetcher('/admin/api/defaults', {
        method: 'PUT',
        credentials: 'same-origin',
        signal: lifetime.current?.signal ?? null,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision: snapshot.revision, defaults: { ...snapshot.defaults, preset } }),
      })
      const value: unknown = await response.json()
      if (!response.ok || !isSessionDefaultsSnapshot(value)) throw new Error('save failed')
      if (lifetime.current?.signal.aborted) return
      window.dispatchEvent(new CustomEvent('agnes:session-configuration-changed'))
      setSnapshot(value as Snapshot)
      setConfirm(false)
      setFailedPreset(undefined)
    } catch {
      if (!lifetime.current?.signal.aborted) setError(true)
    } finally {
      if (!lifetime.current?.signal.aborted) setBusy(false)
    }
  }
  const chosen = snapshot?.defaults.preset ?? effective
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
      failed={error && !!snapshot}
      onRetry={() => failedPreset && void save(failedPreset)}
      state={error && !snapshot ? 'error' : busy && !snapshot ? 'loading' : undefined}
      onReload={() => setRevision((value) => value + 1)}
    >
      <fieldset className="agnes-settings-modes" aria-label={t('defaultPermissions')} disabled={locked}>
        {presets.map((preset) => (
          <div key={preset} data-testid={`security-${preset}`} data-on={chosen === preset || undefined}>
            <SettingsChoice
              type="radio"
              name="security-default-preset"
              value={preset}
              checked={chosen === preset}
              disabled={locked || !available.includes(preset)}
              label={t(preset)}
              hint={available.includes(preset) ? t(`${preset}Help`) : t('notAllowed')}
              onChange={() => {
                if (preset === 'full-access') setConfirm(true)
                else void save(preset)
              }}
            />
          </div>
        ))}
      </fieldset>
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
        {error && <SettingsState tone="error">{t('failed')}</SettingsState>}
      </Dialog>
    </SettingsBlock>
  )
}
