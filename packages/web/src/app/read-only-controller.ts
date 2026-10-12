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
  async function load(id: string, maxNodes: number): Promise<void> {
    const view = await context.client.session.view(id, { maxNodes })
    context.readOnly = { id, maxNodes, hasEarlier: view.history.hasEarlier }
    context.projection = view.timeline
    context.windowAtStart = !view.history.hasEarlier
  }

  function banner(notice: SessionViewNotice): void {
    const id = context.readOnly?.id
    if (!id) return
    // Switching to the current version is an administrator operation named per pinned kind
    // (`agh sessions migrate`); the page does not offer it.
    const actions: { id: string; label: string; onSelect(): void }[] = []
    if (notice.actions.includes('upgrade'))
      actions.push({
        id: 'reopen',
        label: context.t('app.readOnly.reopen'),
        onSelect: () => context.run(() => commands.open(id)),
      })
    if (notice.actions.includes('new-session'))
      actions.push({
        id: 'new',
        label: context.t('app.readOnly.new'),
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
      await load(id, PAGE)
      if (epoch !== context.selection) return true
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
    await load(state.id, state.maxNodes + PAGE)
    if (context.readOnly?.id !== state.id) return
    context.render()
  }

  function clear(): void {
    context.readOnly = undefined
    appReadOnly.clear()
  }

  return { show, loadEarlier, clear }
}
