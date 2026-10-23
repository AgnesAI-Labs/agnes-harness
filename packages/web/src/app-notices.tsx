import { presentationRoles } from '@agnes/web-client'
import { tr as t } from '@agnes/web-foundation/locale-bridge'
import {
  Banner,
  Button,
  createExternalStore,
  Disclosure,
  FeedbackHost,
  installFeedbackSink,
  Notifications,
  StatusMessage,
  useDocumentLanguage,
  useStoreSelector,
} from '@agnes/web-ui'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { createOperationFeedback } from './operation-feedback.js'
import type { ReconnectPhase } from './reconnect.js'

export type NoticeText = string | (() => string)
const noticeText = (value: NoticeText): string => (typeof value === 'function' ? value() : value)

type RecoveryNotice = {
  message: NoticeText
  error: NoticeText
  disabled: boolean
  retry(): void
  create(): void
}
type NoticeAction = { label: string; run(): void }
type NoticeSnapshot = {
  text: NoticeText
  kind: string
  recovery?: RecoveryNotice
  repair?: () => void
  action?: NoticeAction
  actions?: readonly NoticeAction[]
}
const operationFeedback = createOperationFeedback()
const feedback = operationFeedback.store
installFeedbackSink(operationFeedback.sink)
const dismissFeedback = operationFeedback.dismiss
const store = createExternalStore<NoticeSnapshot>({ text: '', kind: '' })
const errors = createExternalStore<readonly { id: number; message: NoticeText }[]>([])
let nextError = 0
const dismissError = (id: number) => errors.set(errors.getSnapshot().filter((item) => item.id !== id))
type ReadOnlyNoticeView = {
  preview?: boolean
  message: Readonly<{ en: string; 'zh-CN': string }>
  actions: readonly { id: 'reopen' | 'new'; onSelect(): void }[]
  sessionId?: string
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
  clearErrors() {
    errors.set([])
  },
  error(message: NoticeText) {
    errors.set([...errors.getSnapshot(), { id: ++nextError, message }].slice(-5))
  },
  setText(text: NoticeText) {
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
  offerMany(actions: readonly NoticeAction[]) {
    store.set({ ...store.getSnapshot(), actions })
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
  const [noticeContainer, setNoticeContainer] = useState<Element | null>(null)
  useEffect(() => {
    const dialog = document.getElementById('config')
    const sync = () =>
      setNoticeContainer(
        dialog?.hasAttribute('open') ? document.getElementById('settings-operation-notices') : null,
      )
    const observer = new MutationObserver(sync)
    if (dialog) observer.observe(dialog, { attributes: true, attributeFilter: ['open'] })
    sync()
    return () => observer.disconnect()
  }, [])
  const view = useStoreSelector(store, (value) => value)
  const outcomes = useStoreSelector(feedback, (value) => value)
  const notifications = useStoreSelector(errors, (value) => value)
  const zh = useDocumentLanguage() === 'zh-CN'
  const diagnostics = useSyncExternalStore(presentationRoles.subscribe, presentationRoles.getSnapshot)
  return (
    <>
      <FeedbackHost snapshot={outcomes} onDismiss={dismissFeedback} noticeContainer={noticeContainer} />
      {diagnostics
        .filter((item) => item.failure)
        .map((item) => (
          <StatusMessage
            key={item.role}
            kind="error"
            data-testid="presentation-failure"
            action={{
              label: zh ? '重新加载' : 'Reload',
              onSelect: () => window.location.reload(),
            }}
          >
            {zh
              ? '界面显示失败；已保存的交付物可能仍然存在。'
              : 'Display failed; saved deliverables may still exist.'}
            {` · ${item.role} · ${item.failure?.packageId ?? item.owners.join(', ')} · ${item.failure?.phase} · ${item.failure?.code}`}
          </StatusMessage>
        ))}
      <Notifications
        items={notifications.map((item) => ({ ...item, message: noticeText(item.message) }))}
        onDismiss={dismissError}
        closeLabel={t('app.notification.close')}
      />
      <p id="notice" role="alert" data-kind={view.kind}>
        {view.recovery ? (
          <>
            <span data-recovery-message="">
              {t('app.recovery.hint', { message: noticeText(view.recovery.message) })}
            </span>
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
            <span data-recovery-error="">
              {view.recovery.error ? ` ${noticeText(view.recovery.error)}` : ''}
            </span>
          </>
        ) : (
          noticeText(view.text)
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
        {view.actions?.map((action) => (
          <Button key={action.label} data-testid="notice-stop-action" onClick={action.run}>
            {action.label}
          </Button>
        ))}
      </p>
    </>
  )
}

export function ReadOnlyNotice() {
  const view = useStoreSelector(readOnlyStore, (value) => value)
  const language = useDocumentLanguage()
  if (!view) return null
  if (view.preview)
    return (
      <p role="status" data-testid="session-history-preview">
        {view.message[language === 'zh-CN' ? 'zh-CN' : 'en']}
      </p>
    )
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
      {view.sessionId && (
        <Disclosure variant="plain" summary={t('app.readOnly.details')}>
          <code>{view.sessionId}</code>
        </Disclosure>
      )}
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
