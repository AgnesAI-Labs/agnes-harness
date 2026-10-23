import {
  SESSION_VERSION_CODES,
  type SessionLoadingParams,
  type SessionVersionAction,
  type SessionViewNotice,
  sessionVersionNotice,
} from '@agnes/protocol'
import { appServerErrorMessage } from '@agnes/web-ui'
import type { AppSessionContext } from '../app.js'
import { appReadOnly } from '../app-notices.js'
import type { SessionBinding } from './session-owner.js'

type ViewScan = { fromSeq: number; throughSeq: number } | undefined
type ReadOnlyNotice = Pick<SessionViewNotice, 'actions' | 'localized'>

const PAGE = 200
/** The opening preview shows about what the formal opening will (its `WEB_OPENING` window). */
const PREVIEW_PAGE = 50
const CODES: readonly string[] = Object.values(SESSION_VERSION_CODES)

/** Only known recovery refusals may offer history without reopening the execution session. */
function refusalNotice(error: unknown, sessionId: string): ReadOnlyNotice | undefined {
  const data = (error as { data?: Record<string, unknown> } | null)?.data
  const code = data?.code
  if (code === 'E_SANDBOX_WORKSPACE' && data?.reason === 'session-execution-record-invalid') {
    const message = { data: { messageKey: 'appServer.errors.sessionSandbox' } }
    const en = appServerErrorMessage(message, 'en')
    const zh = appServerErrorMessage(message, 'zh-CN')
    if (!en || !zh) return undefined
    return { actions: ['new-session'], localized: { en, 'zh-CN': zh } }
  }
  if (typeof code !== 'string' || !CODES.includes(code)) return undefined
  const issue = (
    Object.entries(SESSION_VERSION_CODES).find(([, value]) => value === code) as [
      SessionViewNotice['issue'],
      string,
    ]
  )[0]
  const localized = data?.localized as SessionViewNotice['localized'] | undefined
  const actions = Array.isArray(data?.actions) ? (data.actions as SessionVersionAction[]) : undefined
  const fallback = sessionVersionNotice(issue, { sessionId })
  return {
    actions: actions ?? [...fallback.actions],
    localized: localized?.en && localized['zh-CN'] ? localized : fallback.message,
  }
}

export function createReadOnlyController(
  context: Pick<
    AppSessionContext,
    | 'client'
    | 'clientModules'
    | 'current'
    | 'projection'
    | 'readOnly'
    | 'render'
    | 'renderControls'
    | 'run'
    | 'sessionBinding'
    | 'sessionTitles'
    | 't'
    | 'windowAtStart'
  >,
  commands: { open(id: string): Promise<void>; beginNewDraft(): Promise<void> },
) {
  // Bumped by every request and by clear(), so only the newest request of the current selection
  // may write shared state.
  let latest = 0
  let reading: AbortController | undefined
  // The scan marker of the view on screen; the banner states it next to the refusal.
  let verificationRead = 0
  let verificationTimer: ReturnType<typeof setTimeout> | undefined
  let scan: ViewScan

  /** Fetches a view and commits it in one step; false when a newer request or selection superseded it. */
  async function load(id: string, maxNodes: number, epoch: SessionBinding): Promise<boolean> {
    const ticket = ++latest
    reading?.abort()
    const request = new AbortController()
    reading = request
    try {
      const [view, metadata] = await Promise.all([
        context.client.session.view(id, { maxNodes }, { signal: request.signal }),
        context.client.session.list({ q: { prefix: id }, limit: 100 }).catch(() => undefined),
      ])
      if (ticket !== latest || !context.sessionBinding.isCurrent(epoch)) return false
      const title = metadata?.items.find((row) => row.sessionId === id)?.title
      if (title) context.sessionTitles.set(id, title)
      scan = view.history.scan
      context.readOnly = { id, maxNodes, hasEarlier: view.history.hasEarlier }
      // Before admission, recorded views bind only the presentation identity. Admission may
      // finish before this read: retain its identity/readiness while displaying the preview.
      if (!context.current) context.clientModules.session.setSession(id, 'history-only')
      context.projection = view.timeline
      context.windowAtStart = !view.history.hasEarlier
      return true
    } catch (error) {
      // An obsolete failure must not replace the current selection with recovery UI either.
      if (ticket !== latest || !context.sessionBinding.isCurrent(epoch)) return false
      throw error
    } finally {
      if (reading === request) reading = undefined
    }
  }

  function banner(notice: ReadOnlyNotice, scan: ViewScan): void {
    const id = context.readOnly?.id
    if (!id) return
    // Switching to the current version is an administrator operation named per pinned kind
    // (`agh sessions migrate`); the page does not offer it.
    const actions: { id: 'reopen' | 'new'; onSelect(): void }[] = []
    if (notice.actions.includes('upgrade'))
      actions.push({
        id: 'reopen',
        onSelect: () => context.run(() => commands.open(id)),
      })
    if (notice.actions.includes('new-session'))
      actions.push({
        id: 'new',
        onSelect: () => context.run(() => commands.beginNewDraft()),
      })
    // Protocol notices retain identifiers for other clients; this surface puts them in details.
    const localized = {
      en: notice.localized.en.replace(`Session: ${id}.`, '').trim(),
      'zh-CN': notice.localized['zh-CN'].replace(`会话：${id}。`, '').trim(),
    }
    appReadOnly.show({ message: localized, sessionId: id, actions, ...(scan ? { scan } : {}) })
  }

  /**
   * Shows a session that refused to open as a read-only conversation. Returns false when the
   * refusal does not support read-only recovery, or the record cannot be read; the caller offers the
   * usual recovery.
   */
  async function show(id: string, error: unknown, epoch: SessionBinding): Promise<boolean> {
    const refusal = refusalNotice(error, id)
    if (!refusal) return false
    try {
      if (!(await load(id, PAGE, epoch))) return true
      const ticket = latest
      // Opening changed the roster identity. Commit the current profile presenters
      // for that binding without admitting the refused session's client generation.
      await context.clientModules.reconciler.reconcileNow()
      if (ticket !== latest || !context.sessionBinding.isCurrent(epoch)) return true
      banner(refusal, scan)
    } catch {
      return false
    }
    context.render()
    context.renderControls()
    return true
  }

  async function loadEarlier(): Promise<void> {
    const state = context.readOnly
    if (!state?.hasEarlier) return
    if (!(await load(state.id, state.maxNodes + PAGE, context.sessionBinding.capture()))) return
    context.render()
  }

  function clearPreview(): void {
    latest++
    reading?.abort()
    reading = undefined
    context.readOnly = undefined
  }

  function clear(): void {
    clearPreview()
    verificationRead++
    clearTimeout(verificationTimer)
    appReadOnly.clear()
  }

  function previewNotice(id: string, failed = false): void {
    appReadOnly.show({
      preview: true,
      sessionId: id,
      actions: [],
      message: failed
        ? { en: 'History verification failed. Session sealed.', 'zh-CN': '历史校验失败，会话已封存。' }
        : { en: 'History preview (not yet verified)', 'zh-CN': '历史预览（尚未验证）' },
    })
  }

  function progress(value: SessionLoadingParams, epoch: SessionBinding): void {
    if (context.sessionBinding.isCurrent(epoch) && value.phase === 'verifying') previewNotice(value.sessionId)
  }

  /** Loading progress covers foreground checks; only the existing integrity fact confirms the full prefix. */
  function verify(id: string, epoch: SessionBinding): void {
    const mine = ++verificationRead
    clearTimeout(verificationTimer)
    const current = () => mine === verificationRead && context.sessionBinding.isCurrent(epoch)
    previewNotice(id)
    const read = async () => {
      if (!current()) return
      try {
        const result = await context.client.session.integrity(id)
        if (!current()) return
        if (result.state === 'verified') {
          appReadOnly.clear()
          return
        }
        if (result.state === 'stopped') return
        if (result.state === 'failed') {
          previewNotice(id, true)
          return
        }
      } catch {
        // A disconnected reader cannot attest the history; retain the note until a successful read.
      }
      if (current()) verificationTimer = setTimeout(() => void read(), 1000)
    }
    void read()
  }

  async function preview(id: string, epoch: SessionBinding): Promise<void> {
    if (!(await load(id, PREVIEW_PAGE, epoch))) return
    const ticket = latest
    // A cold page still needs its profile-level conversation/composer presenters to display the
    // preview. If admission raced this read, reconcile its current generation instead; load()
    // never downgrades an admitted binding to history-only. The first live timeline clears us.
    await context.clientModules.reconciler.reconcileNow()
    if (ticket !== latest || !context.sessionBinding.isCurrent(epoch)) return
    previewNotice(id)
    context.render()
    context.renderControls()
  }

  return { show, preview, progress, verify, loadEarlier, clearPreview, clear }
}
