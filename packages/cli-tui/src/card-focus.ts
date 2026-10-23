import type { Component } from './component.js'
import { fitLine } from './components/line.js'
import { actionFor } from './keymap.js'
import { parseKey } from './keys.js'
import { tt } from './locale-extended.js'
import type { ThemedAnsi } from './theme.js'
import type { ToolCards } from './tool-cards.js'
import type { Timeline } from './views/timeline.js'

type Position = ReturnType<Timeline['position']>

/**
 * Ctrl-X: keys move between the tool cards of the conversation instead of typing. The card in focus
 * is marked with a bar down its left side; up and down step to the neighbour (and stop at the ends),
 * Enter or space opens and folds it, `a` and `z` open and fold every card, and Esc or Ctrl-X leaves
 * with the conversation back where it was. The mode takes every key, so the draft is never touched;
 * a card that arrives meanwhile does not move the focus, which is kept by the card's key.
 */
export class CardFocus implements Component {
  private key: string | undefined
  private saved: Position | undefined

  constructor(
    private readonly o: {
      timeline: Pick<Timeline, 'cardKeys' | 'setFocus' | 'toggleCard' | 'position' | 'restore'>
      cards: Pick<ToolCards, 'setAll'>
      ansi: ThemedAnsi
      locale: string
      /** A one-line notice, for when there is no card to focus. */
      notice(text: string): void
      changed(): void
    },
  ) {}

  get open(): boolean {
    return this.saved !== undefined
  }

  /** Focus on the newest card, remembering where the conversation was. */
  enter(): void {
    const last = this.o.timeline.cardKeys().at(-1)
    if (last === undefined) {
      this.o.notice(tt('cards.none', this.o.locale))
      return
    }
    this.saved = this.o.timeline.position()
    this.focus(last)
  }

  /** Leaves the mode; without `restore` the viewport stays where the focus left it (a session switch). */
  exit(restore = true): void {
    if (this.saved === undefined) return
    if (restore) this.o.timeline.restore(this.saved)
    this.saved = undefined
    this.key = undefined
    this.o.timeline.setFocus(undefined)
    this.o.changed()
  }

  private focus(key: string): void {
    this.key = key
    const { ansi } = this.o
    // Each row's leading space becomes the bar; a row without one is left as it is.
    this.o.timeline.setFocus({
      key,
      mark: (row) => (row.startsWith(' ') ? `${ansi.fg('accent', '▌')}${row.slice(1)}` : row),
    })
    this.o.changed()
  }

  handleInput(data: string): boolean {
    if (!this.open) return false
    const key = parseKey(data, false)
    const action = actionFor(
      'cards',
      key.name === 'char' ? (key.ch === ' ' ? 'space' : (key.ch ?? '')) : key.name,
    )
    // A card that left the projection (or a session switch) moves the focus to the newest one left.
    const keys = this.o.timeline.cardKeys()
    const current = keys.find((k) => k === this.key) ?? keys.at(-1)
    // Whatever key opened the mode also closes it, rebound or not.
    if (current === undefined || action === 'cards-exit' || actionFor('global', key.name) === 'cards-focus') {
      this.exit()
      // Ctrl-C also stops the turn: it carries on to the interrupt once the mode is gone.
      return key.name !== 'ctrl-c'
    }
    const at = keys.indexOf(current)
    let next = current
    if (action === 'cards-prev') next = keys[Math.max(0, at - 1)] ?? current
    else if (action === 'cards-next') next = keys[Math.min(keys.length - 1, at + 1)] ?? current
    else if (action === 'cards-toggle') this.o.timeline.toggleCard(current)
    else if (action === 'cards-expand-all' || action === 'cards-collapse-all')
      this.o.cards.setAll(action === 'cards-expand-all')
    this.focus(next)
    return true
  }

  invalidate(): void {}

  render(width: number): string[] {
    return this.open ? [fitLine(this.o.ansi.fg('faint', ` ${tt('cards.hint', this.o.locale)}`), width)] : []
  }
}
