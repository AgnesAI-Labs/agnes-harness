import type { Component } from './component.js'
import { type PromptArea, promptArea } from './prompt-click.js'
import { TIMELINE_RESERVED_ROWS } from './views/timeline.js'

/** What one frame tells the app about the layout it just drew. */
export type RootLayout = {
  /** Rows below the permission modal, for sizing the timeline viewport. */
  belowModal: number
  /** Rows every child but the timeline took, so the timeline knows how many are left to it. */
  reservedRows: number
  /** Where the draft's text rows sit; absent while no composer is on screen. */
  promptArea: PromptArea | undefined
  /** A picker or panel is on screen and owns the keyboard, so a click must not reach through it. */
  dialogShown: boolean
}

export type RootLayoutHost = {
  /** Called first in every frame. */
  sync(): void
  pager: Component & { readonly open: boolean }
  modal: Component & { readonly pending: boolean }
  timeline: Component
  composer: Component
  /** The pickers and panels; each draws zero rows while closed. */
  dialogs: readonly Component[]
  children(): readonly Component[]
  rows(): number
  noAltScreen: boolean | undefined
  textRows(): number
  frame(rows: string[], width: number, height: number): string[]
  overlay(rows: string[], row: number, width: number): void
  report(layout: RootLayout): void
}

/**
 * The root view: the conversation above, then the input area on the bottom edge. A permission modal
 * hides the dialogs and sits above a visible composer. Any other dialog that is open takes the
 * composer's place and the composer is not drawn, so there is one prompt on screen and one owner of
 * the keyboard.
 */
export function rootRender(host: RootLayoutHost): (width: number) => string[] {
  return (width) => {
    host.sync()
    // The pager, like the dialogs, gives way to a pending approval and returns unchanged.
    if (host.pager.open && !host.modal.pending) return host.pager.render(width)
    const pending = host.modal.pending
    const dialogs = pending ? [] : host.dialogs
    const dialogOpen = dialogs.some((dialog) => dialog.render(width).length > 0)
    const shown = host
      .children()
      .filter(
        (child) => !(pending && host.dialogs.includes(child)) && !(dialogOpen && child === host.composer),
      )
    let belowModal = 0
    let rows = 0
    for (const child of shown.toReversed()) {
      if (child === host.modal) belowModal = rows
      if (child !== host.timeline) rows += child.render(width).length
    }
    const height = host.rows()
    const at = shown.indexOf(host.modal)
    const above = shown.slice(0, at).flatMap((child) => child.render(width))
    const belowParts = shown.slice(at).map((child) => child.render(width))
    const below = belowParts.flat()
    // The input area, from the approval dialog down, sits on the bottom edge; a short
    // conversation leaves its gap above it rather than below.
    const gap =
      Number.isFinite(height) && !host.noAltScreen ? Math.max(0, height - above.length - below.length) : 0
    const screen = [...above, ...Array.from({ length: gap }, () => ''), ...below]
    const composerAt = shown.slice(at).indexOf(host.composer)
    host.report({
      belowModal,
      reservedRows: Math.max(TIMELINE_RESERVED_ROWS, rows),
      promptArea:
        composerAt < 0 || host.pager.open
          ? undefined
          : promptArea({
              screenRows: screen.length,
              belowComposer: belowParts.slice(composerAt + 1).reduce((n, part) => n + part.length, 0),
              width,
              textRows: host.textRows(),
            }),
      dialogShown: belowParts.some(
        (part, i) => part.length > 0 && dialogs.includes(shown[at + i] as Component),
      ),
    })
    host.overlay(screen, above.length + gap - 1, width)
    return host.noAltScreen ? screen : host.frame(screen, width, height)
  }
}
