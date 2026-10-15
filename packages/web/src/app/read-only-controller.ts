import {
  SESSION_VERSION_CODES,
  type SessionVersionAction,
  type SessionViewNotice,
  sessionVersionNotice,
} from '@agnes/protocol'
import { appServerErrorMessage } from '@agnes/web-ui'
import type { AppSessionContext } from '../app.js'
import { appReadOnly } from '../app-notices.js'

type ViewScan = { fromSeq: number; throughSeq: number } | undefined
type ReadOnlyNotice = Pick<SessionViewNotice, 'actions' | 'localized'>

const PAGE = 200
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
    | 'projection'
    | 'readOnly'
    | 'render'
    | 'renderControls'
    | 'run'
    | 'selection'
    | 't'
    | 'windowAtStart'
  >,
  commands: { open(id: string): Promise<void>; beginNewDraft(): Promise<void> },
) {
  // Bumped by every request and by clear(), so only the newest request of the current selection
  // may write shared state.
  let latest = 0
  // The scan marker of the view on screen; the banner states it next to the refusal.
  let scan: ViewScan
  let openingProgress:
    | { id: string; phase: 'verifying' | 'replaying'; done: number; total: number }
    | undefined

  /** Fetches a view and commits it in one step; false when a newer request or selection superseded it. */
  async function load(id: string, maxNodes: number, epoch: number): Promise<boolean> {
    const ticket = ++latest
    try {
      const view = await context.client.session.view(id, { maxNodes })
      if (ticket !== latest || epoch !== context.selection) return false
      scan = view.history.scan
      context.readOnly = { id, maxNodes, hasEarlier: view.history.hasEarlier }
      context.projection = view.timeline
      context.windowAtStart = !view.history.hasEarlier
      return true
    } catch (error) {
      // An obsolete failure must not replace the current selection with recovery UI either.
      if (ticket !== latest || epoch !== context.selection) return false
      throw error
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
    appReadOnly.show({ message: notice.localized, actions, ...(scan ? { scan } : {}) })
  }

  /**
   * Shows a session that refused to open as a read-only conversation. Returns false when the
   * refusal does not support read-only recovery, or the record cannot be read; the caller offers the
   * usual recovery.
   */
  async function show(id: string, error: unknown, epoch: number): Promise<boolean> {
    const refusal = refusalNotice(error, id)
    if (!refusal) return false
    try {
      if (!(await load(id, PAGE, epoch))) return true
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
    if (!(await load(state.id, state.maxNodes + PAGE, context.selection))) return
    context.render()
  }

  function clear(): void {
    latest++
    context.readOnly = undefined
    openingProgress = undefined
    appReadOnly.clear()
  }

  function progress(id: string, phase: 'verifying' | 'replaying', done: number, total: number): void {
    openingProgress = { id, phase, done, total }
    if (context.readOnly?.id !== id) return
    const counts = total > 0 ? ` ${done}/${total}` : ''
    const en = phase === 'verifying' ? 'Verifying before execution' : 'Loading verified history'
    const zh = phase === 'verifying' ? '正在验证，完成后才能执行' : '正在加载已验证历史'
    appReadOnly.show({
      message: {
        en: `Unverified history preview · ${en}${counts}`,
        'zh-CN': `未经验证的历史预览 · ${zh}${counts}`,
      },
      actions: [],
    })
  }

  async function preview(id: string, epoch: number): Promise<void> {
    if (!(await load(id, PAGE, epoch))) return
    const current = openingProgress?.id === id ? openingProgress : undefined
    progress(id, current?.phase ?? 'verifying', current?.done ?? 0, current?.total ?? 0)
    context.render()
    context.renderControls()
  }

  return { show, preview, progress, loadEarlier, clear }
}
