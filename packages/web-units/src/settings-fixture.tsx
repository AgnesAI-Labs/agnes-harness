import {
  Button,
  createRegionRenderer,
  Disclosure,
  mountSettingsSelectOptions,
  SettingsInput,
  SettingsModelPane,
  SettingsSelect,
} from '@agnes/web-ui'
import { flushSync } from 'react-dom'
import { SettingsStaticPane } from './settings-panes.js'
import { SettingsLegacyRail } from './settings-shell.js'

function SettingsFixture() {
  const text = (_key: string, fallback: string) => {
    return fallback
  }
  return (
    <>
      <form id="config-form" className="settings-shell" data-settings-view="list">
        <SettingsLegacyRail />
        <SettingsModelPane beforeAccounts={null} afterAccounts={null} />
        <SettingsStaticPane pane="appearance" />
      </form>
      <dialog data-agnes-region="dialog" id="account-dialog" aria-labelledby="config-detail-title">
        <Button
          id="account-dialog-close"
          className="account-dialog-close"
          aria-label={text('settings-shell.close', '关闭账户详情')}
          htmlType="button"
          appearance="ghost"
        >
          <svg className="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </Button>
        <section className="account-dialog-body" aria-labelledby="config-detail-title">
          <div className="config-detail-heading">
            <div>
              <h3 id="config-detail-title">{text('settings-shell.accountTitle', '账户详情')}</h3>
            </div>
            <p id="config-account-context">{text('settings-shell.accountContext', '编辑连接与默认模型')}</p>
          </div>
          <div className="config-detail-grid">
            <fieldset className="config-section account-provider-step">
              <legend>{text('settings-shell.connectionLegend', '连接信息')}</legend>
              <label className="form-field" htmlFor="config-provider">
                <span>{text('settings-shell.providerLabel', 'Provider')}</span>
                <SettingsSelect id="config-provider" />
              </label>
            </fieldset>
            <div id="config-provider-choices" />
            <div className="account-connection-step">
              <div className="account-provider-card" id="config-provider-card">
                <span className="agnes-settings-logo" id="config-provider-logo" aria-hidden="true" />
                <span className="account-provider-card-copy">
                  <strong id="config-provider-name" />
                  <span id="config-provider-host" />
                </span>
                <Button id="config-provider-change" htmlType="button" appearance="link" size="small">
                  <span>{text('accounts.changeProvider', '换一个服务商')}</span>
                </Button>
              </div>
              <fieldset className="config-section account-connection">
                <legend>{text('accounts.connectionLegend', '连接')}</legend>
                <div id="config-auth-method-field" className="account-auth-method">
                  <span hidden>
                    <SettingsSelect id="config-auth-method" />
                  </span>
                  <div id="config-auth-choice" />
                </div>
                <div className="account-field account-key-field">
                  <div className="account-field-head">
                    <label className="form-field" htmlFor="config-api-key">
                      <span>{text('settings-shell.apiKeyLabel', 'API Key')}</span>
                    </label>
                    <Button htmlType="button" appearance="link" size="small" aria-controls="config-key-help">
                      <span>{text('accounts.keyHelp', '在哪里获取？')}</span>
                    </Button>
                  </div>
                  <p id="config-key-help" className="account-help" hidden>
                    {text('accounts.keyHelpText', '在服务商的账户控制台创建 API Key，复制后粘贴到这里。')}
                  </p>
                  <span className="account-input">
                    <SettingsInput
                      id="config-api-key"
                      type="password"
                      autoComplete="new-password"
                      placeholder={text('accounts.keyPlaceholderNew', '粘贴 API Key')}
                      aria-describedby="config-key-hint"
                    />
                  </span>
                </div>
                <p id="config-key-hint" className="field-hint form-field-wide" />
                <div id="config-oauth-controls" className="form-field-wide" />
                <div id="config-compatible-models" className="form-field-wide" hidden />
                <div className="account-status" id="config-account-status">
                  <p id="config-state" aria-live="polite" />
                  <p id="config-error" role="alert" />
                  <Button id="config-test" htmlType="button" appearance="link" size="small">
                    <span>{text('settings-shell.testConnection', '重新测试')}</span>
                  </Button>
                  <Button id="config-retry" hidden htmlType="button" appearance="secondary" size="small">
                    <span>{text('settings-shell.retryRead', '重试读取配置')}</span>
                  </Button>
                </div>
              </fieldset>
              <fieldset className="config-section config-validation-section" id="config-model-fields">
                <legend>{text('settings-shell.validationLegend', '默认模型')}</legend>
                <p id="config-model-lock" className="account-lock-note">
                  <span id="config-model-lock-text" />
                  <Button id="config-model-lock-test" htmlType="button" appearance="link" size="small" hidden>
                    <span>{text('accounts.testNow', '测试连接')}</span>
                  </Button>
                </p>
                <div className="account-field-pair">
                  <div className="account-field">
                    <label className="form-field" htmlFor="config-model">
                      <span>{text('settings-shell.defaultModelLabel', '模型')}</span>
                      <SettingsSelect id="config-model" />
                    </label>
                  </div>
                  <div className="account-field">
                    <label className="form-field" htmlFor="config-thinking">
                      <span>{text('settings-shell.defaultThinkingLabel', '思考强度')}</span>
                      <SettingsSelect id="config-thinking" />
                    </label>
                    <p id="config-thinking-error" className="account-field-error" />
                  </div>
                </div>
                <div className="account-field account-budget-field">
                  <label className="form-field" htmlFor="config-context-window">
                    <span>
                      {text('settings-shell.contextBudgetLabel', '上下文预算')}
                      <span id="config-model-capacity" className="account-field-aside" />
                    </span>
                    <span className="account-input">
                      <SettingsInput
                        id="config-context-window"
                        type="text"
                        maxLength={32}
                        placeholder={text('settings-shell.contextBudgetPlaceholder', '自动')}
                        aria-describedby="config-model-settings-hint"
                      />
                      <span className="account-input-suffix">{text('accounts.tokensUnit', 'tokens')}</span>
                    </span>
                  </label>
                  <p id="config-model-settings-hint" className="field-hint">
                    {text(
                      'settings-shell.modelSettingsHint',
                      '留空即自动。可写 128K、1M，最少 2K，不超过模型容量。',
                    )}
                  </p>
                  <p id="config-context-window-error" className="account-field-error" />
                </div>
              </fieldset>
              <Disclosure
                variant="plain"
                id="config-account-advanced"
                summary={text('accounts.advanced', '高级选项')}
                meta={<span id="config-account-advanced-meta" className="account-advanced-meta" />}
              >
                <div className="account-advanced">
                  <div className="account-field">
                    <label className="form-field" htmlFor="config-account-name">
                      <span>{text('settings-shell.accountNameLabel', '账户名称')}</span>
                      <SettingsInput
                        id="config-account-name"
                        maxLength={128}
                        autoComplete="off"
                        placeholder={text(
                          'settings-shell.accountNamePlaceholder',
                          '例如：工作账户、本地模型',
                        )}
                        aria-describedby="config-account-name-hint"
                      />
                    </label>
                    <p id="config-account-name-hint" className="field-hint" />
                    <p id="config-account-name-error" className="account-field-error" />
                  </div>
                  <div className="account-field">
                    <div className="account-field-head">
                      <label className="form-field" htmlFor="config-base-url">
                        <span>{text('settings-shell.baseUrlLabel', 'Base URL')}</span>
                      </label>
                      <Button
                        id="config-base-url-reset"
                        htmlType="button"
                        appearance="link"
                        size="small"
                        hidden
                      >
                        <span>{text('accounts.resetBaseUrl', '恢复默认')}</span>
                      </Button>
                    </div>
                    <SettingsInput
                      id="config-base-url"
                      autoComplete="url"
                      aria-describedby="config-base-url-hint"
                    />
                    <p id="config-base-url-hint" className="field-hint" />
                    <p id="config-base-url-error" className="account-field-error" />
                  </div>
                  <div className="account-field">
                    <div id="config-account-network" />
                    <p id="config-account-network-error" className="account-field-error" />
                  </div>
                </div>
              </Disclosure>
              <p id="config-account-guard">
                {text(
                  'settings-shell.accountGuard',
                  '默认账户不可停用或删除；如需调整，请先将其他已启用账户设为默认。',
                )}
              </p>
            </div>
          </div>
          <div className="config-detail-footer">
            <div id="config-account-discard" hidden role="alert">
              <p>{text('accounts.discard', '放弃未保存的更改？')}</p>
              <Button id="config-account-keep" htmlType="button" appearance="secondary">
                <span>{text('accounts.keepEditing', '继续编辑')}</span>
              </Button>
              <Button id="config-account-discard-confirm" htmlType="button" appearance="ghost">
                <span>{text('accounts.discardAction', '放弃更改')}</span>
              </Button>
            </div>
            <div id="config-account-footer-actions" className="agnes-settings-actions">
              <Button id="config-account-back" htmlType="button" appearance="ghost">
                <span>{text('accounts.back', '上一步')}</span>
              </Button>
              <Button id="config-account-cancel" htmlType="button" appearance="secondary">
                <span>{text('accounts.cancel', '取消')}</span>
              </Button>
              <Button id="config-save" form="config-form" disabled htmlType="submit" appearance="primary">
                <span>{text('settings-shell.saveAccount', '保存账户')}</span>
              </Button>
            </div>
          </div>
        </section>
      </dialog>
    </>
  )
}

/** Mount the same React controls for DOM-contract tests and compatibility consumers. */
export function renderSettingsMarkup(container: HTMLElement): () => void {
  const root = createRegionRenderer(container)
  flushSync(() => root.render(<SettingsFixture />))
  const dispose: (() => void)[] = []
  for (const id of ['config-provider', 'config-auth-method', 'config-model', 'config-thinking']) {
    const select = container.querySelector<HTMLSelectElement>(`#${id}`)
    if (!select) throw new Error(`missing settings select #${id}`)
    dispose.push(mountSettingsSelectOptions(select))
  }
  return () => {
    for (const unmount of dispose) unmount()
    root.unmount()
  }
}
