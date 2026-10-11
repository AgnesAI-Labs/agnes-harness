import { isSessionDefaultsSnapshot } from '@agnes/protocol'
import { Banner, Button, Dialog, SettingsChoice, SettingsState, Toast, useUiText } from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { PluginAdminApi } from '../admin/plugins/api.js'
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
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [canSave, setCanSave] = useState(false)
  const [effective, setEffective] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [saved, setSaved] = useState(false)
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
      setSnapshot(value as Snapshot)
      setConfirm(false)
      setSaved(true)
    } catch {
      if (!lifetime.current?.signal.aborted) setError(true)
    } finally {
      if (!lifetime.current?.signal.aborted) setBusy(false)
    }
  }
  return (
    <section data-testid="security-default-permissions" aria-busy={busy}>
      <h3>{t('defaultPermissions')}</h3>
      <p>{t('defaultHelp')}</p>
      {busy && !snapshot && <SettingsState tone="loading">{t('loading')}</SettingsState>}
      {error && (
        <Banner
          tone="error"
          action={<Button onClick={() => setRevision((value) => value + 1)}>{t('retry')}</Button>}
        >
          {t('failed')}
        </Banner>
      )}
      <fieldset aria-label={t('defaultPermissions')} disabled={!canSave || !snapshot || busy}>
        {presets.map((preset) => (
          <div key={preset} data-testid={`security-${preset}`}>
            <SettingsChoice
              type="radio"
              name="security-default-preset"
              value={preset}
              checked={(snapshot?.defaults.preset ?? effective) === preset}
              disabled={!canSave || !snapshot || busy || !available.includes(preset)}
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
      <Toast open={saved} onDismiss={() => setSaved(false)}>
        {t('saved')}
      </Toast>
      <Dialog
        focusTriggerAfterClose={false}
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
    </section>
  )
}
