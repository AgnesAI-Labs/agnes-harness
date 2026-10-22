import type { TuiApp } from './app.js'
import { tt } from './locale-extended.js'

/** `/btw`: asks in the background so the turn keeps streaming; the answer lives only in the usage panel. */
export function startBtw(app: TuiApp, question: string): void {
  const { session, locale, usagePanel: panel } = app
  const title = tt('btw.title', locale)
  app.statusBar.setNotice(undefined)
  panel.show(tt('btw.thinking', locale), title)
  const shown = panel.version
  // Esc, another panel or a session switch changes the version: the answer is then dropped.
  void session.client.session.btw(session.id, question).then(
    (answer) => {
      if (panel.version === shown) panel.show(answer.text, title)
    },
    (error: unknown) => {
      if (panel.version !== shown) return
      if ((error as { code?: unknown }).code === -32601)
        app.statusBar.setNotice(tt('btw.unsupported', locale), 'error')
      else app.showError(error)
      panel.close()
    },
  )
}
