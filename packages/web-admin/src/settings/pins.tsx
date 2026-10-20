import type { PackagePinsInspectResult } from '@agnes/protocol'
import {
  Banner,
  Button,
  CopyButton,
  Icon,
  ListRow,
  SettingsList,
  SettingsSection,
  SettingsState,
  SettingsTechnicalDetails,
} from '@agnes/web-ui'
import { useCallback, useEffect, useState } from 'react'
import type { PluginAdminApi } from '../admin/plugins/api.js'
import { captureRequest, useRequestScope } from './async-request.js'

type Pin = PackagePinsInspectResult['orphans'][number]
type Text = (key: string, vars?: Record<string, string | number>) => string
/** Release is per pin and not transactional, so a long list goes up in bounded requests. */
const BATCH = 64

/**
 * Read and release unused plugin retention records on demand, independently of the plugin list.
 */
export function PinsPanel({
  api,
  canRelease,
  t,
}: {
  api: PluginAdminApi | undefined
  canRelease: boolean
  t: Text
}) {
  const lifetime = useRequestScope(api, canRelease)
  const [pins, setPins] = useState<readonly Pin[]>()
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState<readonly string[]>()
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map())
  const [skipped, setSkipped] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope changes retire pending callbacks and reset their UI state.
  const load = useCallback(async () => {
    if (!api) return
    const request = captureRequest(lifetime)
    setFailed(false)
    try {
      const next = await api.pinsInspect()
      if (request.isCurrent()) setPins(next.orphans)
    } catch {
      if (!request.isCurrent()) return
      // A list that could not be verified is not shown as current.
      setPins(undefined)
      setFailed(true)
    }
  }, [api, canRelease, lifetime])
  useEffect(() => {
    setPins(undefined)
    setBusy(false)
    setConfirming(undefined)
    setErrors(new Map())
    setSkipped(0)
    void load()
  }, [load])
  async function release(ids: readonly string[]) {
    if (!api || !canRelease || busy) return
    const request = captureRequest(lifetime)
    setBusy(true)
    setConfirming(undefined)
    const failures = new Map<string, string>()
    let returned = 0
    try {
      for (let offset = 0; offset < ids.length; offset += BATCH) {
        const { results } = await api.pinsRelease(ids.slice(offset, offset + BATCH))
        if (!request.isCurrent()) return
        const released = new Set<string>()
        for (const result of results) {
          if (result.outcome === 'failed')
            failures.set(result.pinId, result.error?.safeMessage ?? t('pinsReleaseFailed'))
          else {
            if (result.outcome === 'skipped-no-longer-orphaned') returned++
            released.add(result.pinId)
          }
        }
        // Each request's result shows as it arrives; a later failure does not undo it.
        setPins((current) => current?.filter((pin) => !released.has(pin.pinId)))
      }
    } catch {
      if (!request.isCurrent()) return
      for (const id of ids) if (!failures.has(id)) failures.set(id, t('pinsReleaseFailed'))
      void load()
    } finally {
      if (request.isCurrent()) {
        setErrors(failures)
        setSkipped(returned)
        setBusy(false)
      }
    }
  }
  const purpose = (pin: Pin) => t(`pinsPurpose.${pin.purpose}`)
  return (
    <SettingsSection
      data-testid="runtime-occupancy"
      aria-busy={busy}
      title={t('pinsTitle')}
      description={pins?.length ? t('pinsCount', { count: pins.length }) : undefined}
      actions={
        !!pins?.length && (
          <Button
            appearance="ghost"
            size="small"
            data-testid="pins-release-all"
            disabled={!canRelease || busy}
            onClick={() => setConfirming(pins.map((pin) => pin.pinId))}
          >
            {t('pinsReleaseAll')}
          </Button>
        )
      }
    >
      {!pins && !failed && <SettingsState>{t('pinsChecking')}</SettingsState>}
      {failed && (
        <Banner tone="error" action={<Button onClick={() => void load()}>{t('retry')}</Button>}>
          {t('pinsUnavailable')}
        </Banner>
      )}
      {skipped > 0 && <SettingsState>{t('pinsSkipped', { count: skipped })}</SettingsState>}
      {confirming && (
        <Banner
          tone="warning"
          data-testid="pins-confirm"
          action={
            <>
              <Button size="small" onClick={() => setConfirming(undefined)}>
                {t('cancel')}
              </Button>
              <Button
                size="small"
                danger
                data-testid="pins-confirm-release"
                onClick={() => void release(confirming)}
              >
                {t('pinsConfirm')}
              </Button>
            </>
          }
        >
          {confirming.length === 1
            ? t('pinsConfirmOne', { id: confirming[0] ?? '' })
            : t('pinsConfirmAll', { count: confirming.length })}
        </Banner>
      )}
      {pins && pins.length === 0 && !failed && <SettingsState>{t('pinsEmpty')}</SettingsState>}
      {!!pins?.length && (
        <SettingsList>
          {pins.map((pin) => (
            <ListRow
              key={pin.pinId}
              data-testid="pin-row"
              data-pin-id={pin.pinId}
              icon={<Icon name="folder" size={20} />}
              title={`${pin.packageId} ${pin.version}`}
              meta={purpose(pin)}
              actions={
                <Button
                  size="small"
                  data-testid="pin-release"
                  disabled={!canRelease || busy}
                  onClick={() => setConfirming([pin.pinId])}
                >
                  {t('pinsRelease')}
                </Button>
              }
            >
              {errors.get(pin.pinId) && <SettingsState tone="error">{errors.get(pin.pinId)}</SettingsState>}
              <SettingsTechnicalDetails>
                <dl>
                  <dt>{t('pinsId')}</dt>
                  <dd>
                    <code>{pin.pinId}</code>{' '}
                    <CopyButton text={pin.pinId} label={t('copyId')} copiedLabel={t('copiedId')} />
                  </dd>
                  <dt>{t('pinsSnapshot')}</dt>
                  <dd>
                    <code>{pin.snapshotId}</code>{' '}
                    <CopyButton text={pin.snapshotId} label={t('copyId')} copiedLabel={t('copiedId')} />
                  </dd>
                </dl>
              </SettingsTechnicalDetails>
            </ListRow>
          ))}
        </SettingsList>
      )}
    </SettingsSection>
  )
}
