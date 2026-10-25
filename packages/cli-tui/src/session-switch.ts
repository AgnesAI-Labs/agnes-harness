import type { Session } from '@agnes/sdk'
import type { TuiApp } from './app.js'
import type { SessionChoice } from './commands.js'
import { escapeControl } from './component.js'
import { tt } from './locale-extended.js'
import type { ResourceCommandKind } from './resource-controller.js'
import { worktreeSwitched } from './worktree-command.js'

async function attach(app: TuiApp, session: Session): Promise<void> {
  app.projection = app.makeProjection(session)
  app.offPermission = session.onPermissionRequest((request, context) => app.modal.ask(request, context))
  await app.projection.start()
}

// Stops the old projection's local subscription, swaps the session the app renders, and starts
// a fresh projection against the new one. The old session is left attached at the protocol level
// (its own `Client.close()` cleans that up eventually) -- an explicit detach here is a step this
// task's own interface spec never asks for, and one this method has no test coverage compelling.
export async function applySwitch(app: TuiApp, next: Session): Promise<boolean> {
  // runSlash and chooseSession refuse up front; a prompt submitted while the daemon was still opening
  // `next` is caught here.
  if (app.refuseClosed() || app.refuseSwitch()) return false
  app.themePicker.close()
  app.modelPicker.close()
  app.sessionPicker.close()
  app.usagePanel.close()
  app.editor.resetUndo()
  app.planPanel.reset()
  app.images.reset()
  app.cardFocus.exit(false)
  app.offPermission?.()
  await app.projection.stop()
  // stop() may have run before this switch's session arrived or during the await above. It stops only the
  // projection it finds, so one started from here on would never be stopped: its opening retry timer keeps
  // the process alive after the TUI has quit. A terminal close during the await is the same case:
  // starting the next projection would re-dial the daemon.
  if (app.stopped || app.refuseClosed()) return false
  // A prompt submitted during that await went to the still-current session, whose cancel a swap would
  // misroute: stay on it and re-attach what was just torn down.
  if (app.refuseSwitch()) {
    await attach(app, app.o.session)
    return false
  }
  // `projection.stop()` only unsubscribes from the old session's ledger events; it never
  // synthesizes a closing `opState: null` tick for a turn that was still in flight. Left alone,
  // a mid-turn switch leaves the ticker genuinely running past this point (confirmed reachable:
  // nothing else stops it once the old projection is torn down) and the loader still labelled
  // with the old session's turn/phase, so the new session's first idle tick would otherwise
  // paint a stale, fabricated elapsed time for a turn that belongs to a session no longer even
  // attached. Reset turn-lifecycle state to exactly what a freshly-constructed TuiApp looks like.
  app.clock.reset()
  app.welcome.banner.setModel(undefined)
  app.surfaces.reset()
  app.attachmentController.abort()
  app.attachmentController = new AbortController()
  app.mentions.reset()
  // A fork carries no workspace of its own: it stays in the one it was forked from.
  app.o.cwd = next.cwd ?? app.cwd
  app.o.session = next
  app.o.onSessionSwitch?.(next.id)
  app.previews.reset()
  app.previewEffects.length = 0
  await attach(app, next)
  await worktreeSwitched(app, next.id)
  return true
}

/** What a pick in the session picker does: import a file, resume a session, or fork one at a turn. */
export async function chooseSession(app: TuiApp, choice: SessionChoice): Promise<void> {
  if (app.refuseClosed()) return
  // An import row runs `/import FILE` as if typed, so it reports through the same notice.
  if (choice.importFile !== undefined) return app.runInput(`/import ${choice.importFile}`)
  try {
    // The picker stays open during a turn; picking from it is refused before the daemon loads anything.
    if (app.refuseSwitch()) return app.renderer.requestRender()
    app.statusBar.setNotice(`Loading session ${escapeControl(choice.sessionId)}…`)
    app.renderer.requestRender()
    // A rewind row forks the open session at its completed-turn boundary; any other row resumes.
    const next =
      choice.forkAt === undefined
        ? await app.o.session.client.session.load(choice.sessionId, { cwd: app.cwd })
        : await app.o.session.client.session.fork(choice.sessionId, choice.forkAt)
    if (await applySwitch(app, next)) {
      const turn = choice.title?.match(/^#(\d+)/)?.[1] ?? String(choice.forkAt)
      if (choice.draft) app.editor.setText(choice.draft)
      app.statusBar.setNotice(
        choice.forkAt === undefined
          ? `Resumed ${escapeControl(choice.sessionId)}`
          : tt(choice.draft ? 'session.rewound' : 'session.rewoundNoPrompt', app.locale, { turn }),
        'success',
      )
    }
    if (!app.stopped) app.renderer.requestRender()
  } catch (error) {
    app.showError(error)
  }
}

/** The one resource command waiting for the user's confirmation, if any. */
export class ResourceConfirmations {
  private pending: { kind: ResourceCommandKind; args: readonly string[] } | undefined

  queue = (kind: ResourceCommandKind, args: readonly string[]): void => {
    this.pending = { kind, args: [...args] }
  }

  take = (kind: ResourceCommandKind): readonly string[] | undefined => {
    const pending = this.pending
    if (!pending || pending.kind !== kind) return undefined
    this.pending = undefined
    return pending.args
  }

  cancel = (kind: ResourceCommandKind): boolean => {
    if (!this.pending || this.pending.kind !== kind) return false
    this.pending = undefined
    return true
  }
}
