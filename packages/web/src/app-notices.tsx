import { tr as t } from '@agnes/web-foundation/locale-bridge'
import { Banner, Button, createExternalStore, useDocumentLanguage, useStoreSelector } from '@agnes/web-ui'
import type { ReconnectPhase } from './reconnect.js'

type RecoveryNotice = { message: string; error: string; disabled: boolean; retry(): void; create(): void }
type NoticeAction = { label: string; run(): void }
type NoticeSnapshot = {
  text: string
  kind: string
  recovery?: RecoveryNotice
  repair?: () => void
  action?: NoticeAction
}
const store = createExternalStore<NoticeSnapshot>({ text: '', kind: '' })
type ReadOnlyNoticeView = {
  message: Readonly<{ en: string; 'zh-CN': string }>
  actions: readonly { id: 'reopen' | 'new'; onSelect(): void }[]
  /** Present when the record was too large to read whole: the rows that are shown, and why the rest are not. */
  scan?: Readonly<{ fromSeq: number; throughSeq: number }>
}
const readOnlyStore = createExternalStore<ReadOnlyNoticeView | undefined>(undefined)
type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed'
const reconnectStore = createExternalStore<{
  phase: ReconnectPhase
  connection: ConnectionState
  retry?: () => void
}>({ phase: 'idle', connection: 'connecting' })

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
  /** The valid next step for the notice just shown; the next notice text clears it. */
  offer(action: NoticeAction) {
    store.set({ ...store.getSnapshot(), action })
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
  reconnectStore.set({ ...reconnectStore.getSnapshot(), phase, retry })
}

/** The transport's own state: a dropped socket shows before page-level recovery starts. */
export function setConnectionNotice(connection: ConnectionState) {
  const view = reconnectStore.getSnapshot()
  if (view.connection !== connection) reconnectStore.set({ ...view, connection })
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
      {view.action && (
        <>
          {' '}
          <Button data-testid="notice-action" onClick={view.action.run}>
            {view.action.label}
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
      {view.scan && (
        <>
          {' '}
          <span data-testid="session-scan-truncated">
            {t('app.readOnly.truncated', { from: view.scan.fromSeq, through: view.scan.throughSeq })}
          </span>
        </>
      )}
    </Banner>
  )
}

/**
 * The one connection status for the whole workbench: hidden while connected, and otherwise what
 * happened and what the person can do. Pages and panels do not repeat it.
 */
export function ConnectionBar() {
  const view = useStoreSelector(reconnectStore, (value) => value)
  const dropped = view.connection === 'reconnecting' || view.connection === 'closed'
  const state = view.phase !== 'idle' ? view.phase : dropped ? view.connection : 'connected'
  return (
    <div
      id="reconnect-notice"
      className="connection-bar"
      data-testid="connection-bar"
      data-state={state}
      role="status"
      hidden={state === 'connected'}
    >
      <span className="connection-bar-dot" aria-hidden="true" />
      <span className="connection-bar-text">
        {state === 'waiting'
          ? t('app.reconnect.waiting')
          : state === 'recovering'
            ? t('app.reconnect.reloading')
            : state === 'stalled'
              ? t('app.reconnect.stalled')
              : state === 'reconnecting'
                ? t('home.connection.reconnecting')
                : state === 'closed'
                  ? t('home.connection.closed')
                  : null}
      </span>
      {state === 'stalled' && (
        <Button size="small" onClick={view.retry}>
          {t('app.reconnect.retry')}
        </Button>
      )}
    </div>
  )
}
