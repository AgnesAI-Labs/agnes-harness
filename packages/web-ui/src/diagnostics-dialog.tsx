import type { JSX } from 'react'

export type DiagnosticsStep = 'menu' | 'share' | 'ready' | 'saved'
export type DiagnosticsInclude = { conversation: boolean; logs: boolean; system: boolean }

export type DiagnosticsDialogSnapshot = {
  step: DiagnosticsStep
  title: string
  hasSession: boolean
  include: DiagnosticsInclude
  generating: boolean
  saving: boolean
  summary: string
  hasWarnings: boolean
  savedName: string
  error: string
}

export type DiagnosticsDialogActions = {
  close(): void
  share(): void
  back(step: 'menu' | 'share'): void
  setInclude(name: keyof DiagnosticsInclude, checked: boolean): void
  generate(): void
  save(): void
}

/** The view receives display-only data; collected ZIP bytes stay with the dialog controller. */
export function DiagnosticsDialogView({
  snapshot,
  actions,
  text,
}: {
  snapshot: DiagnosticsDialogSnapshot
  actions: DiagnosticsDialogActions
  text?: (key: string) => string
}): JSX.Element {
  const { step, include } = snapshot
  const label = (key: string, fallback: string) => text?.(key) ?? fallback
  return (
    <div className="diagnostics-body">
      <div className="dialog-heading">
        <h2 id="diagnostics-heading">{snapshot.title}</h2>
      </div>
      <section data-step="menu" hidden={step !== 'menu'}>
        <p className="dialog-intro">
          {label(
            'diagnostics.intro',
            'Create a diagnostics ZIP you can share with support. It can include this session’s conversation and trace, logs, and system information.',
          )}
        </p>
        <p className="diagnostics-badge">
          {label('diagnostics.redaction', 'Secrets are redacted before sharing.')}
        </p>
        <div className="dialog-actions">
          <button className="secondary-button" type="button" data-action="cancel" onClick={actions.close}>
            {label('diagnostics.cancel', 'Cancel')}
          </button>
          <button className="primary-button" type="button" data-action="share" onClick={actions.share}>
            {label('diagnostics.share', 'Share diagnostics')}
          </button>
        </div>
      </section>
      <section data-step="share" hidden={step !== 'share'}>
        <fieldset className="diagnostics-include" aria-labelledby="diagnostics-heading">
          <label>
            <input
              type="checkbox"
              name="conversation"
              checked={include.conversation}
              disabled={!snapshot.hasSession}
              onChange={(event) => actions.setInclude('conversation', event.currentTarget.checked)}
            />{' '}
            {label('diagnostics.include.conversation', 'Conversation and trace')}
          </label>
          <label>
            <input
              type="checkbox"
              name="logs"
              checked={include.logs}
              onChange={(event) => actions.setInclude('logs', event.currentTarget.checked)}
            />{' '}
            {label('diagnostics.include.logs', 'Logs')}
          </label>
          <label>
            <input
              type="checkbox"
              name="system"
              checked={include.system}
              onChange={(event) => actions.setInclude('system', event.currentTarget.checked)}
            />{' '}
            {label('diagnostics.include.system', 'System information')}
          </label>
        </fieldset>
        <div className="dialog-actions">
          <button
            className="secondary-button"
            type="button"
            data-back="menu"
            disabled={snapshot.generating}
            onClick={() => actions.back('menu')}
          >
            {label('diagnostics.back', 'Back')}
          </button>
          <button
            className="primary-button"
            type="button"
            data-action="generate"
            disabled={snapshot.generating}
            onClick={actions.generate}
          >
            {snapshot.generating
              ? label('diagnostics.generating', 'Generating…')
              : label('diagnostics.generate', 'Generate package')}
          </button>
        </div>
      </section>
      <section data-step="ready" hidden={step !== 'ready'}>
        <p className="dialog-intro" data-ready-summary>
          {snapshot.summary}
        </p>
        <p className="dialog-intro" data-ready-warning hidden={!snapshot.hasWarnings}>
          {label(
            'diagnostics.warning',
            'Some diagnostics were unavailable or over the export limit. See diagnostic-export-warnings.json in the package.',
          )}
        </p>
        <div className="dialog-actions">
          <button
            className="secondary-button"
            type="button"
            data-back="share"
            onClick={() => actions.back('share')}
          >
            {label('diagnostics.back', 'Back')}
          </button>
          <button
            className="primary-button"
            type="button"
            data-action="save"
            disabled={snapshot.saving}
            onClick={actions.save}
          >
            {label('diagnostics.save', 'Save ZIP')}
          </button>
        </div>
      </section>
      <section data-step="saved" hidden={step !== 'saved'}>
        <p className="dialog-intro">
          {label(
            'diagnostics.savedIntro',
            'Share this ZIP with support or engineering. Unzip it and open index.html.',
          )}
        </p>
        <p className="diagnostics-file" data-saved-name>
          {snapshot.savedName}
        </p>
        <div className="dialog-actions">
          <button className="primary-button" type="button" data-action="close" onClick={actions.close}>
            {label('diagnostics.close', 'Close')}
          </button>
        </div>
      </section>
      <p className="dialog-error" role="alert">
        {snapshot.error}
      </p>
    </div>
  )
}
