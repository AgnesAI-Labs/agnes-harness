import {
  SESSION_VERSION_CODES,
  type SessionVersionAction,
  type SessionViewNotice,
  sessionVersionNotice,
} from '@agnes/protocol'
import type { AppSessionContext } from '../app.js'
import { appReadOnly } from '../app-notices.js'

const PAGE = 200
const CODES: readonly string[] = Object.values(SESSION_VERSION_CODES)

/** What the refusal to open a session said, when it was one of the three version directions. */
function refusalNotice(error: unknown, sessionId: string): SessionViewNotice | undefined {
  const data = (error as { data?: Record<string, unknown> } | null)?.data
  const code = data?.code
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
    code: fallback.code,
    issue,
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

  /** Fetches a view and commits it in one step; false when a newer request or selection superseded it. */
  async function load(id: string, maxNodes: number, epoch: number): Promise<boolean> {
    const ticket = ++latest
    const view = await context.client.session.view(id, { maxNodes })
    if (ticket !== latest || epoch !== context.selection) return false
    context.readOnly = { id, maxNodes, hasEarlier: view.history.hasEarlier }
    context.projection = view.timeline
    context.windowAtStart = !view.history.hasEarlier
    return true
  }

  function banner(notice: SessionViewNotice): void {
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
    appReadOnly.show({ message: notice.localized, actions })
  }

  /**
   * Shows a session that refused to open as a read-only conversation. Returns false when the
   * refusal is not a version one, or the record itself cannot be read; the caller then offers the
   * usual recovery.
   */
  async function show(id: string, error: unknown, epoch: number): Promise<boolean> {
    const refusal = refusalNotice(error, id)
    if (!refusal) return false
    try {
      if (!(await load(id, PAGE, epoch))) return true
      banner(refusal)
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
    appReadOnly.clear()
  }

  return { show, loadEarlier, clear }
}
