import type { TuiApp } from './app.js'
import { escapeControl } from './component.js'
import { writeComposerMemoryFile } from './composer-memory.js'
import { tt } from './locale-extended.js'
import { nextModel } from './model-cycle.js'
import { accountLabels, modelLabel } from './model-label.js'
import { nextThinkingLevel } from './thinking-cycle.js'
import type { ModelSelection } from './views/model-picker.js'

/**
 * Switching the session's primary model: the picker's choice and Shift+Tab's next thinking level
 * both go through `choose`, so they make the same `setModel` call and leave the same notice.
 */
export class ModelChooser {
  /** The model and thinking level the last projection reported; Shift+Tab steps from here. */
  current: { route: string; id: string; thinking: string } | undefined

  constructor(
    private readonly app: TuiApp,
    private readonly closed: () => boolean,
    private readonly stopped: () => boolean,
  ) {}

  /** True when the daemon applied the choice; false when it did not (the error is shown). */
  async choose(choice: ModelSelection, thinkingOnly = false): Promise<boolean> {
    if (this.closed()) return false
    const { app } = this
    try {
      const result = await app.session.setModel({
        slot: 'primary',
        route: choice.route,
        model: choice.model,
        ...(choice.thinking === undefined ? {} : { thinking: choice.thinking }),
      })
      writeComposerMemoryFile(app.composerSelectionPath, {
        model: {
          route: choice.route,
          id: choice.model,
          ...(choice.thinking ? { thinking: choice.thinking } : {}),
        },
      })
      app.statusBar.setNotice(
        thinkingOnly
          ? tt('thinking.level', app.locale, { level: choice.thinking ?? '', seq: result.effectiveFromSeq })
          : `model ${escapeControl(modelLabel(await accountLabels(app.session.client), choice.route, choice.model))} from seq ${result.effectiveFromSeq}`,
        'success',
      )
      if (!this.stopped()) app.renderer.requestRender()
      return true
    } catch (error) {
      app.showError(error)
      return false
    }
  }

  /** Shift+Tab: the next thinking level of the primary model, or a notice when it has none. */
  cycleThinking(): void {
    if (this.closed()) return
    const { app } = this
    void (async () => {
      try {
        const current = this.current
        const models = (await app.session.client.apis()).profile.models ?? []
        const next = current && nextThinkingLevel(models, current)
        if (!next || !current) {
          app.statusBar.setNotice(tt('thinking.unsupported', app.locale), 'warning')
          if (!this.stopped()) app.renderer.requestRender()
          return
        }
        if (await this.choose({ route: current.route, model: current.id, thinking: next }, true))
          this.current = { ...current, thinking: next }
      } catch (error) {
        app.showError(error)
      }
    })()
  }

  /** Alt+P / Alt+Shift+P: the next or previous model of the /model list, switched through `choose`. */
  cycleModel(step: 1 | -1): void {
    if (this.closed()) return
    const { app } = this
    void (async () => {
      try {
        const next = nextModel((await app.session.client.apis()).profile.models ?? [], this.current, step)
        if (!next) {
          app.statusBar.setNotice(tt('model.noOther', app.locale), 'warning')
          if (!this.stopped()) app.renderer.requestRender()
          return
        }
        // Set before the call so a second press while it is in flight goes on from here.
        const before = this.current
        const set = { route: next.route, id: next.model, thinking: next.thinking ?? '' }
        this.current = set
        // A refused switch leaves the model that is still in use, unless a projection has reported since.
        if (!(await this.choose(next)) && this.current === set) this.current = before
      } catch (error) {
        app.showError(error)
      }
    })()
  }
}
