import { isSessionDefaultsSnapshot, type RuntimeSecurityStatus } from '@agnes/protocol'
import {
  Banner,
  Button,
  Dialog,
  fallbackT,
  IconTile,
  reportSuccess,
  SettingsBlock,
  SettingsChoice,
  SettingsItem,
  SettingsPickerSelect,
  SettingsState,
  SettingsTag,
  StatusDot,
  type StatusDotTone,
  trackPageRequest,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { PluginAdminApi } from '../admin/plugins/api.js'
import { captureRequest } from './async-request.js'
import { SETTINGS_NAMESPACE, settingsCatalog } from './locales.js'
import { useSettingsOverlay } from './overlay.js'
import { SECURITY_NAMESPACE, securityUxCatalog } from './security-locale.js'
import { allowedPermissions, isPermissionLevel, PERMISSION_LEVELS, recipePresets } from './session-choice.js'

type Snapshot = import('@agnes/protocol').SessionDefaultsSnapshot
type Entry = { id: string; isDefault: boolean }
/** One saved default: the permission level, or the preset (recipe); '' clears the preset. */
type Choice = { field: 'permission' | 'preset'; value: string }
const icons = { 'read-only': 'eye', 'workspace-write': 'pencil', 'full-access': 'lock-keyhole' } as const
const isolationTone: Record<RuntimeSecurityStatus['platform']['l1']['level'], StatusDotTone> = {
  full: 'success',
  partial: 'warning',
  unavailable: 'danger',
  unprobed: 'neutral',
}
/**
 * 默认权限 and the default preset for new sessions. They are separate fields of the saved defaults:
 * choosing one keeps the other, and a permission level is never written as a preset.
 */
export function PermissionDefaults({
  presets,
  permissions,
  security,
  fetcher = fetch,
}: {
  /** The runtime catalog's presets; the legacy permission-level names among them are not offered. */
  presets: readonly Entry[]
  /** The runtime catalog's permission levels; an older Host omits them. */
  permissions?: readonly Entry[] | undefined
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
  const [pending, setPending] = useState<Choice>()
  const [confirm, setConfirm] = useState(false)
  const [revision, setRevision] = useState(0)
  const lifetime = useRef<AbortController>()
  useSettingsOverlay(confirm)
  // biome-ignore lint/correctness/useExhaustiveDependencies: the retry counter explicitly starts a fresh read.
  useEffect(() => {
    const abort = new AbortController()
    lifetime.current = abort
    setBusy(true)
    setCanSave(false)
    setReadFailed(false)
    setSaving(undefined)
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
        if (abort.signal.aborted || !resolved || typeof resolved !== 'object') return
        const row = resolved as { permission?: unknown; preset?: unknown }
        const level = row.permission ?? row.preset
        setEffective(isPermissionLevel(level) ? level : undefined)
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
  const allowed = allowedPermissions(permissions)
  const recipes = recipePresets(presets)
  const defaultRecipe = recipes.find((preset) => preset.isDefault)?.id ?? 'standard'
  const more = recipes.map((preset) => preset.id).filter((id) => id !== defaultRecipe)
  async function save(choice: Choice) {
    if (!canSave || !snapshot || busy) return
    if (choice.field === 'permission' && !allowed.some((level) => level === choice.value)) return
    if (choice.field === 'preset' && choice.value && !more.includes(choice.value)) return
    // Each choice replaces its own field only; the rest of the saved defaults is sent back as read.
    const current = snapshot.defaults
    const { preset: _replaced, ...withoutPreset } = current
    const defaults =
      choice.field === 'permission'
        ? { ...current, permission: choice.value }
        : { ...withoutPreset, ...(choice.value ? { preset: choice.value } : {}) }
    const request = captureRequest(lifetime)
    setBusy(true)
    setSaving(choice.field === 'permission' ? choice.value : undefined)
    setSaveFailed(false)
    setConflict(false)
    setPending(choice)
    try {
      const response = await fetcher('/admin/api/defaults', {
        method: 'PUT',
        credentials: 'same-origin',
        signal: request.signal ?? null,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision: snapshot.revision, defaults }),
      })
      if (response.status === 409) {
        // The revision this page read is stale. Read the current defaults; the retry then saves the
        // same choice against them instead of repeating the stale revision.
        if (!request.isCurrent()) return
        setConflict(true)
        setSaveFailed(true)
        setRevision((value) => value + 1)
        return
      }
      const value: unknown = await response.json()
      if (!response.ok || !isSessionDefaultsSnapshot(value)) throw new Error('save failed')
      if (!request.isCurrent()) return
      window.dispatchEvent(new CustomEvent('agnes:session-configuration-changed'))
      setSnapshot(value as Snapshot)
      reportSuccess('permission-defaults', fallbackT('ui.defaultsSaved'))
      setConfirm(false)
      setPending(undefined)
    } catch {
      if (request.isCurrent()) setSaveFailed(true)
    } finally {
      if (request.isCurrent()) {
        setBusy(false)
        setSaving(undefined)
      }
    }
  }
  const saved = snapshot && snapshot.defaults
  // Only what is stored is shown as chosen; a choice in flight shows on its own card until it lands.
  const stored =
    saved?.permission ??
    effective ??
    permissions?.find((level) => level.isDefault && isPermissionLevel(level.id))?.id
  const chosen = saving ?? stored
  const chosenPreset = saved?.preset ?? ''
  const text = (key: string, fallback: string) => {
    const value = choiceText(key)
    return value === key ? fallback : value
  }
  const name = (id: string | undefined) => (id ? text(`choice.${id}`, id) : '—')
  const recipeHelp = (id: string) => text(`choiceHelp.${id}`, '')
  const isolation = (level: (typeof PERMISSION_LEVELS)[number]): [StatusDotTone, string] => {
    if (level === 'read-only') return ['neutral', t('noCommands')]
    if (level === 'full-access') return ['warning', t('notIsolated')]
    if (!security) return ['neutral', t('isolationUnknown')]
    const policies = security.permissionPolicies ?? security.presetPolicies
    if (policies.find((policy) => policy.id === level)?.level === 'L0') return ['warning', t('notIsolated')]
    const state = security.platform.l1.level
    return [isolationTone[state], `${t('commandIsolation')} · ${t(`state.${state}`)}`]
  }
  const locked = !canSave || !snapshot || busy
  const retry = () => pending && void save(pending)
  return (
    <SettingsBlock
      label={t('defaultPermissions')}
      bare
      data-testid="security-default-permissions"
      aria-busy={busy}
      state={readFailed ? 'error' : busy && !snapshot ? 'loading' : undefined}
      onReload={() => setRevision((value) => value + 1)}
    >
      <p className="agnes-settings-note">{t('defaultHelp')}</p>
      {snapshot && lockReason && <Banner data-testid="security-default-locked">{t(lockReason)}</Banner>}
      {snapshot && saved?.preset && !recipes.some((preset) => preset.id === saved.preset) && (
        <Banner data-testid="security-default-other">{t('otherPreset', { name: name(saved.preset) })}</Banner>
      )}
      {/* While a save or reread is in flight the cards wait without greying out (data-busy). */}
      <fieldset
        className="agnes-settings-modes"
        aria-label={t('defaultPermissions')}
        data-busy={(busy && !!snapshot) || undefined}
      >
        {PERMISSION_LEVELS.map((level) => {
          const permitted = allowed.includes(level)
          const [tone, status] = isolation(level)
          return (
            <div key={level} data-testid={`security-${level}`} data-on={chosen === level || undefined}>
              <SettingsChoice
                type="radio"
                name="security-default-permission"
                value={level}
                checked={chosen === level}
                disabled={locked || !permitted}
                preview={<IconTile name={icons[level]} />}
                label={
                  <>
                    {t(level)}
                    {level === 'workspace-write' && (
                      <SettingsTag tone="muted">{t('recommended')}</SettingsTag>
                    )}
                    {!permitted && <SettingsTag tone="muted">{t('notAllowed')}</SettingsTag>}
                  </>
                }
                hint={t(`${level}Help`)}
                onChange={() => {
                  if (level === 'full-access') setConfirm(true)
                  else void save({ field: 'permission', value: level })
                }}
              />
              <div className="agnes-settings-mode-foot">
                <span data-testid={`security-${level}-isolation`}>
                  <StatusDot tone={saving === level ? 'accent' : tone} running={saving === level} />
                  {saving === level ? t('saving') : status}
                </span>
              </div>
            </div>
          )
        })}
      </fieldset>
      {saveFailed && snapshot && pending && (
        <Banner
          tone={conflict ? 'warning' : 'error'}
          data-testid={conflict ? 'security-default-conflict' : 'security-default-failed'}
          action={
            <Button size="small" data-testid="security-default-retry" onClick={retry}>
              {conflict ? t('retryChoice', { chosen: name(pending.value || defaultRecipe) }) : t('retry')}
            </Button>
          }
        >
          {t(conflict ? 'conflict' : 'saveFailed', {
            actual: name(stored),
            chosen: name(pending.value || defaultRecipe),
          })}
        </Banner>
      )}
      {more.length > 0 && (
        <SettingsBlock>
          <SettingsItem
            label={t('defaultRecipe')}
            info={t('defaultRecipeHelp')}
            description={[
              t('defaultRecipeHelp'),
              recipeHelp(more.includes(chosenPreset) ? chosenPreset : defaultRecipe),
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <SettingsPickerSelect
              data-testid="security-more-presets"
              label={t('defaultRecipe')}
              aria-label={t('defaultRecipe')}
              value={more.includes(chosenPreset) ? chosenPreset : ''}
              disabled={locked}
              onChange={(event) => void save({ field: 'preset', value: event.target.value })}
            >
              <option value="">{t('defaultRecipeFollow', { name: name(defaultRecipe) })}</option>
              {more.map((preset) => (
                <option key={preset} value={preset}>
                  {name(preset)}
                </option>
              ))}
            </SettingsPickerSelect>
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
              onClick={() => void save({ field: 'permission', value: 'full-access' })}
            >
              {t('fullConfirmAction')}
            </Button>
          </>
        }
      >
        <p>{t('fullConfirmBody')}</p>
        {saveFailed && <SettingsState tone="error">{t('failed')}</SettingsState>}
      </Dialog>
    </SettingsBlock>
  )
}
