import type { Translate } from '@agnes/web-conversation/presentation'
import { Banner, SettingsItem, SettingsSection, Switch } from '@agnes/web-ui'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { callHeadsUp, headsUpNote } from './heads-up.js'

/** The side review's note for the newest finished turn, under the reply. Advisory, never an instruction. */
export function HeadsUpNote({ sessionId, t }: { sessionId: string | undefined; t: Translate }) {
  const note = useSyncExternalStore(headsUpNote.subscribe, headsUpNote.getSnapshot)
  const [dismissed, setDismissed] = useState<string>()
  if (!note || note.sessionId !== sessionId) return null
  const key = `${note.sessionId}:${note.turn}`
  if (dismissed === key) return null
  return (
    <Banner
      tone="warning"
      data-testid="heads-up-note"
      dismissLabel={t('headsUp.dismiss')}
      onDismiss={() => setDismissed(key)}
    >
      <strong>{t('headsUp.label')}</strong> {note.text}
    </Banner>
  )
}

/** The per-session switch. It is off until turned on, and says plainly what a review sends. */
export function SessionHeadsUp({ sessionId, t }: { sessionId: string; t: Translate }) {
  const [enabled, setEnabled] = useState<boolean | null>()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const abort = new AbortController()
    setEnabled(undefined)
    void callHeadsUp(sessionId, 'headsup.read', {}, abort.signal)
      .then((state) => {
        if (!abort.signal.aborted) setEnabled(state?.enabled ?? null)
      })
      .catch(() => undefined)
    return () => abort.abort()
  }, [sessionId])
  return (
    <SettingsSection
      title={t('headsUp.title')}
      description={t('headsUp.help')}
      data-testid="session-runtime-heads-up"
    >
      <SettingsItem label={t('headsUp.label')} description={t('headsUp.sends')}>
        <Switch
          aria-label={t('headsUp.title')}
          checked={enabled === true}
          disabled={typeof enabled !== 'boolean' || busy}
          loading={busy}
          onChange={(next) => {
            setBusy(true)
            void callHeadsUp(sessionId, 'headsup.set', { enabled: next })
              .then((state) => setEnabled(state?.enabled ?? null))
              .catch(() => undefined)
              .finally(() => setBusy(false))
          }}
        />
      </SettingsItem>
      {enabled === null && <p role="status">{t('headsUp.unavailable')}</p>}
    </SettingsSection>
  )
}
