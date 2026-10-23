import type { Editor } from './editor.js'
import { tt } from './locale-extended.js'
import type { NoticeTone } from './views/status-bar.js'

/** Drafts the stash keeps; pushing one more drops the oldest. */
export const STASH_MAX = 10

/**
 * Ctrl-S: a draft you are not ready to send, put aside. With text in the prompt the key pushes it (paste
 * chips expanded) and clears the prompt; with an empty prompt it pops the newest back. The stack lives in
 * this process only, never on disk, and restoring is one undoable step like any other draft swap.
 */
export class DraftStash {
  private readonly drafts: string[] = []

  constructor(
    private readonly editor: Editor,
    private readonly say: (text: string, tone: NoticeTone) => void,
    private readonly locale: () => string,
  ) {}

  get size(): number {
    return this.drafts.length
  }

  press(): void {
    const editor = this.editor
    const drafts = this.drafts
    // Ctrl-R search owns the prompt while it is open; swapping the draft under it would leave it stale.
    if (editor.inSearch) return
    const locale = this.locale()
    if (editor.text === '') {
      const back = drafts.pop()
      if (back === undefined) this.say(tt('stash.empty', locale), 'warning')
      else {
        editor.replaceDraft(back)
        this.say(tt('stash.restored', locale, { n: drafts.length }), 'success')
      }
      return
    }
    drafts.push(editor.expanded())
    const dropped = drafts.length > STASH_MAX
    if (dropped) drafts.shift()
    editor.replaceDraft('')
    this.say(tt(dropped ? 'stash.savedFull' : 'stash.saved', locale, { n: drafts.length }), 'success')
  }
}
