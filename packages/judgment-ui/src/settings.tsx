import type { ClientContext } from '@agnes/web-client'
import { Button, SettingsGroup, SettingsItem, SettingsPage } from '@agnes/web-ui'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { judgmentCatalog } from './locales.js'
import { type JudgmentStatus, parseJudgmentStatus } from './status.js'

const settingsHref = '?page=plugins&tab=plugins&view=plugin%3A%40agnes%2Fjudgment'

export function JudgmentSettings({ client }: { client: ClientContext }) {
  const binding = useSyncExternalStore(client.availability.subscribe, client.availability.getSnapshot)
  useSyncExternalStore(client.locale.subscribe, client.locale.getSnapshot)
  const active = binding?.lifetime === 'profile' && binding.availability === 'active'
  const [status, setStatus] = useState<JudgmentStatus | null>(null)
  const [busy, setBusy] = useState(active)
  const [unavailable, setUnavailable] = useState(!active)
  const epoch = useRef(0)
  const mounted = useRef(false)
  // A mounted view can briefly outlive its registry/locale contribution during withdrawal.
  const t = (key: string) => {
    const name = `judgment.${key}`
    return judgmentCatalog[client.locale.locale]?.[name] ?? judgmentCatalog.en?.[name] ?? name
  }
  const load = useCallback(async () => {
    const request = ++epoch.current
    setStatus(null)
    if (!active) {
      setBusy(false)
      setUnavailable(true)
      return
    }
    setBusy(true)
    setUnavailable(false)
    const current = () =>
      mounted.current &&
      epoch.current === request &&
      client.availability.getSnapshot()?.availability === 'active'
    try {
      const result = parseJudgmentStatus(await client.profile.services.query('judgment.status', {}))
      if (current()) {
        setStatus(result)
        setUnavailable(result === null)
      }
    } catch {
      if (current()) setUnavailable(true)
    } finally {
      if (current()) setBusy(false)
    }
  }, [active, client])
  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
      epoch.current += 1
    }
  }, [load])
  const visible = active ? status : null
  return (
    <SettingsPage
      title={t('title')}
      routeId="judgment"
      actions={
        <Button disabled={!active || busy} onClick={() => void load()}>
          {t('refresh')}
        </Button>
      }
    >
      <p>{t('nextSession')}</p>
      <a href={settingsHref}>{t('configure')}</a>
      {active && busy && <p role="status">{t('loading')}</p>}
      {(!active || unavailable) && <p role="alert">{t('unavailable')}</p>}
      {visible && (
        <>
          <p>
            {t(`state.${visible.state}`)} · {t(`reason.${visible.reason}`)}
          </p>
          <p>{t('hook')}</p>
          <p>{t('instance')}</p>
          <SettingsGroup aria-label={t('cache')}>
            <SettingsItem label={t('cache')}>
              <span>
                {t('hits')}: {visible.cache.hit} · {t('misses')}: {visible.cache.miss} · {t('size')}:{' '}
                {visible.cache.size}
              </span>
            </SettingsItem>
          </SettingsGroup>
          <SettingsGroup aria-label={t('uses')}>
            {(['stop', 'findRelevant', 'judgeBatch', 'rules'] as const).map((name) => {
              const use = visible.uses[name]
              return (
                <SettingsItem
                  key={name}
                  label={t(`use.${name}`)}
                  description={`${t(use.enabled ? 'enabled' : 'disabled')} · ${t(use.available ? 'available' : `reason.${use.reason}`)}`}
                >
                  <span>
                    {t('requests')}: {use.requests}
                  </span>
                </SettingsItem>
              )
            })}
          </SettingsGroup>
          <details>
            <summary>{t('fingerprint')}</summary>
            <code>{visible.configurationRevision}</code>
          </details>
        </>
      )}
    </SettingsPage>
  )
}
