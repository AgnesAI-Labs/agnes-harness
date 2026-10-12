import { tr as t } from '@agnes/web-foundation/locale-bridge'
import { Banner, Button, createExternalStore, useDocumentLanguage, useStoreSelector } from '@agnes/web-ui'
import type { ReconnectPhase } from './reconnect.js'

type RecoveryNotice = { message: string; error: string; disabled: boolean; retry(): void; create(): void }
type NoticeSnapshot = { text: string; kind: string; recovery?: RecoveryNotice; repair?: () => void }
const store = createExternalStore<NoticeSnapshot>({ text: '', kind: '' })
type ReadOnlyNoticeView = {
  message: Readonly<{ en: string; 'zh-CN': string }>
  actions: readonly { id: 'reopen' | 'new'; onSelect(): void }[]
}
const readOnlyStore = createExternalStore<ReadOnlyNoticeView | undefined>(undefined)
const reconnectStore = createExternalStore<{ phase: ReconnectPhase; retry?: () => void }>({ phase: 'idle' })

/** Controllers own notices and their commands; the shell only renders their snapshots. */
export const appNotice = {
  setText(text: string) {
    store.set({ text, kind: store.getSnapshot().kind })
  },
  setKind(kind: string) {
    store.set({ ...store.getSnapshot(), kind })
  },
  recover(recovery: RecoveryNotice) {
    store.set({ text: '', kind: 'session-recovery', recovery })
  },
  repair(repair: () => void) {
    store.set({ ...store.getSnapshot(), repair })
  },
  disableRecovery(disabled: boolean) {
    const snapshot = store.getSnapshot()
    if (snapshot.recovery && snapshot.recovery.disabled !== disabled)
      store.set({ ...snapshot, recovery: { ...snapshot.recovery, disabled } })
  },
}

/** A session shown from its record alone: why it cannot continue, and what the person can do. */
export const appReadOnly = {
  show(view: ReadOnlyNoticeView) {
    readOnlyStore.set(view)
  },
  clear() {
    if (readOnlyStore.getSnapshot()) readOnlyStore.set(undefined)
  },
}

export function setReconnectNotice(phase: ReconnectPhase, retry: () => void) {
  reconnectStore.set({ phase, retry })
}

export function AppNotice() {
  const view = useStoreSelector(store, (value) => value)
  return (
    <p id="notice" role="alert" data-kind={view.kind}>
      {view.recovery ? (
        <>
          <span data-recovery-message="">{t('app.recovery.hint', { message: view.recovery.message })}</span>
          <Button
            data-recovery-action="retry"
            disabled={view.recovery.disabled}
            onClick={view.recovery.retry}
          >
            {t('app.recovery.retry')}
          </Button>{' '}
          <Button
            data-recovery-action="create"
            disabled={view.recovery.disabled}
            onClick={view.recovery.create}
          >
            {t('app.recovery.create')}
          </Button>
          <span data-recovery-error="">{view.recovery.error ? ` ${view.recovery.error}` : ''}</span>
        </>
      ) : (
        view.text
      )}
      {view.repair && (
        <>
          {' '}
          <Button data-testid="credential-repair" onClick={view.repair}>
            {t('session.error.openAccount')}
          </Button>
        </>
      )}
    </p>
  )
}

export function ReadOnlyNotice() {
  const view = useStoreSelector(readOnlyStore, (value) => value)
  const language = useDocumentLanguage()
  if (!view) return null
  return (
    <Banner
      tone="warning"
      data-testid="session-read-only"
      action={view.actions.map((action) => (
        <Button key={action.id} data-read-only-action={action.id} onClick={action.onSelect}>
          {t(action.id === 'reopen' ? 'app.readOnly.reopen' : 'app.readOnly.new')}
        </Button>
      ))}
    >
      <strong>{t('app.readOnly.label')}</strong> {view.message[language === 'zh-CN' ? 'zh-CN' : 'en']}
    </Banner>
  )
}

export function ReconnectNotice() {
  const view = useStoreSelector(reconnectStore, (value) => value)
  return (
    <p id="reconnect-notice" role="status" hidden={view.phase === 'idle'}>
      {view.phase === 'waiting' ? (
        t('app.reconnect.waiting')
      ) : view.phase === 'recovering' ? (
        t('app.reconnect.reloading')
      ) : view.phase === 'stalled' ? (
        <>
          {t('app.reconnect.stalled')}
          <Button onClick={view.retry}>{t('app.reconnect.retry')}</Button>
        </>
      ) : null}
    </p>
  )
}
