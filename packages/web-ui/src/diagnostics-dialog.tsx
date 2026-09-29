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
}: {
  snapshot: DiagnosticsDialogSnapshot
  actions: DiagnosticsDialogActions
}): JSX.Element {
  const { step, include } = snapshot
  return (
    <div className="diagnostics-body">
      <div className="dialog-heading">
        <h2 id="diagnostics-heading">{snapshot.title}</h2>
      </div>
      <section data-step="menu" hidden={step !== 'menu'}>
        <p className="dialog-intro">
          创建一个可分享给支持人员的诊断 ZIP 包，包含当前会话的对话与轨迹、日志和系统信息。
        </p>
        <p className="diagnostics-badge">分享前会先对密钥脱敏。</p>
        <div className="dialog-actions">
          <button className="secondary-button" type="button" data-action="cancel" onClick={actions.close}>
            取消
          </button>
          <button className="primary-button" type="button" data-action="share" onClick={actions.share}>
            分享诊断
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
            对话与轨迹
          </label>
          <label>
            <input
              type="checkbox"
              name="logs"
              checked={include.logs}
              onChange={(event) => actions.setInclude('logs', event.currentTarget.checked)}
            />{' '}
            日志
          </label>
          <label>
            <input
              type="checkbox"
              name="system"
              checked={include.system}
              onChange={(event) => actions.setInclude('system', event.currentTarget.checked)}
            />{' '}
            系统信息
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
            返回
          </button>
          <button
            className="primary-button"
            type="button"
            data-action="generate"
            disabled={snapshot.generating}
            onClick={actions.generate}
          >
            {snapshot.generating ? '正在生成…' : '生成诊断包'}
          </button>
        </div>
      </section>
      <section data-step="ready" hidden={step !== 'ready'}>
        <p className="dialog-intro" data-ready-summary>
          {snapshot.summary}
        </p>
        <p className="dialog-intro" data-ready-warning hidden={!snapshot.hasWarnings}>
          部分诊断资料不可用或超出导出上限，详见包内 diagnostic-export-warnings.json。
        </p>
        <div className="dialog-actions">
          <button
            className="secondary-button"
            type="button"
            data-back="share"
            onClick={() => actions.back('share')}
          >
            返回
          </button>
          <button
            className="primary-button"
            type="button"
            data-action="save"
            disabled={snapshot.saving}
            onClick={actions.save}
          >
            保存 ZIP 包
          </button>
        </div>
      </section>
      <section data-step="saved" hidden={step !== 'saved'}>
        <p className="dialog-intro">把这个 ZIP 包分享给支持或研发人员。解压后打开 index.html 查看。</p>
        <p className="diagnostics-file" data-saved-name>
          {snapshot.savedName}
        </p>
        <div className="dialog-actions">
          <button className="primary-button" type="button" data-action="close" onClick={actions.close}>
            关闭
          </button>
        </div>
      </section>
      <p className="dialog-error" role="alert">
        {snapshot.error}
      </p>
    </div>
  )
}
