import type { ApprovalSettle } from './approval-settle.js'
import type { Editor } from './editor.js'
import type { DoubleCtrlC } from './interrupt.js'
import { actionFor } from './keymap.js'
import { parseKey } from './keys.js'
import type { ModelChooser } from './model-chooser.js'
import type { PermissionModal } from './permission-modal.js'
import type { ActionItem } from './slots.js'
import type { TerminalSignals } from './terminal-signals.js'
import type { ToolCards } from './tool-cards.js'
import type { ApprovalCard } from './views/approval-card.js'
import type { Timeline } from './views/timeline.js'

/** A dialog that takes keystrokes while it is open; it is the same set the frame hides during an approval. */
export interface InputDialog {
  handleInput(data: string): boolean
}

export interface RootInputHost {
  signals: () => TerminalSignals
  settle: ApprovalSettle
  modal: PermissionModal
  /** In the order they are offered the keystroke. */
  dialogs: readonly InputDialog[]
  approvalCards: ReadonlyMap<string, ApprovalCard>
  latestApproval: () => string | undefined
  /** After 'closed' the cards are inert: their actions would re-dial the daemon. */
  closed: () => boolean
  cards: ToolCards
  models: ModelChooser
  /** Ctrl-S: pushes the draft onto the stash, or pops the newest back into an empty prompt. */
  stashDraft: () => void
  /** Ctrl-L: a full clear-and-redraw of the screen. */
  redraw: () => void
  hintActions: () => readonly ActionItem[]
  dispatchAction: (actionId: string) => void
  /** Ctrl-T: the full-conversation pager (it is also first among `dialogs`, which closes it). */
  openPager: () => void
  /** Ctrl-X: card focus, which then takes the keys through `dialogs`. */
  openCards: () => void
  timeline: Timeline
  editor: Editor
  kitty: Parameters<typeof parseKey>[1]
  noAltScreen: boolean | undefined
  /** Rows the timeline gives up to everything below it; a page scroll leaves those. */
  pageRows: () => number
  scroll: (rows: number) => void
  busy: () => boolean
  refuseClosed: () => boolean
  /** Sends the draft into the turn in flight. */
  steer: (text: string) => Promise<void>
  runInput: (text: string) => Promise<void>
  interrupts: DoubleCtrlC
  cancel: () => Promise<void>
  onQuit: () => void
  showError: (error: unknown) => void
}

/** The root key dispatcher: pending approvals and dialogs first, then global shortcuts, then `fallback`. */
export function rootInput(
  host: RootInputHost,
  fallback: (data: string) => boolean,
): (data: string) => boolean {
  return (data) => {
    if (host.signals().focus(data)) return true
    const settled = host.settle.press()
    if (host.modal.handleInput(data, settled)) return true
    for (const dialog of host.dialogs) if (dialog.handleInput(data)) return true
    // Digits reach the persisted approval projection next -- the most recently projected
    // ApprovalCard, which is only interactive while its node is genuinely pending-with-a-ticket
    // (the synchronous path's own dialog is the modal above, already tried).
    // After 'closed' both card kinds are inert: their actions would re-dial the daemon (a parked
    // ticket survives a restart) and run where nothing renders; digits fall to the editor instead.
    const inert = host.closed()
    if (!inert && host.approvalCards.get(host.latestApproval() ?? '')?.handleInput(data, settled)) return true
    // Numbered actions inside the most recently projected tool card, tried before the digit
    // reaches anything else. A collapsed card (or one with no matching action) declines, and
    // the keystroke falls through to the editor like any other character.
    if (!inert && host.cards.handleInput(data)) return true
    const key = parseKey(data, host.kitty)
    const action = actionFor('global', key.name)
    if (action === 'thinking-cycle') {
      host.models.cycleThinking()
      return true
    }
    if (action === 'model-next' || action === 'model-prev') {
      host.models.cycleModel(action === 'model-next' ? 1 : -1)
      return true
    }
    if (action === 'redraw') {
      host.redraw()
      return true
    }
    if (action === 'draft-stash') {
      host.stashDraft()
      return true
    }
    if (action === 'card-toggle') {
      host.cards.toggleLatest()
      return true
    }
    if (action === 'hint-1' || action === 'hint-2' || action === 'hint-3' || action === 'hint-4') {
      const hint = host.hintActions()[Number(action.slice(-1)) - 1]
      if (hint && !hint.disabled) host.dispatchAction(hint.id)
      return true
    }
    // The pager needs the fullscreen display; with the split footer the conversation is in the terminal's own scrollback.
    if (action === 'pager-open') {
      if (!host.noAltScreen) host.openPager()
      return true
    }
    if (action === 'cards-focus') {
      if (!host.noAltScreen) host.openCards()
      return true
    }
    if (host.timeline.jumpKey(key.name, host.editor.text !== '')) return true
    if (!host.noAltScreen && (action === 'timeline-page-up' || action === 'timeline-page-down')) {
      const page = host.pageRows()
      host.scroll(action === 'timeline-page-up' ? -page : page)
      return true
    }
    // Idle Alt+Enter inserts a newline (the editor's own default, reached via `fallback(data)`
    // below). Busy, it steers the draft into the turn in flight, where Enter queues it behind.
    if (action === 'steer' && host.busy()) {
      const text = host.editor.expanded()
      if (text.trim() && !host.refuseClosed()) {
        host.editor.clear()
        void host.steer(text).catch(host.showError)
      }
      return true
    }
    // Alt+Up takes the newest queued message back into an empty editor.
    if (action === 'queue-recall' && !host.editor.text) {
      void host.runInput('/queue edit last')
      return true
    }
    if (action === 'interrupt') {
      host.interrupts.press(() => host.cancel(), host.onQuit, host.showError)
      return true
    }
    if (action === 'quit' && !host.editor.text && !host.busy()) {
      host.onQuit()
      return true
    }
    return fallback(data)
  }
}
