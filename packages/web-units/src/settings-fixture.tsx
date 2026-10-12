import {
  Button,
  createAntdRoot,
  mountSettingsSelectOptions,
  SettingsInput,
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
        {(['model', 'plugin', 'resources', 'archived', 'computer-use', 'appearance'] as const).map((pane) => (
          <SettingsStaticPane key={pane} pane={pane} />
        ))}
      </form>
      <dialog data-agnes-region="dialog" id="account-dialog" aria-labelledby="config-detail-title">
        <Button
          id="account-dialog-close"
          className="account-dialog-close"
          aria-label={text('settings-shell.close', '关闭账户详情')}
          data-i18n-aria="settings-shell.close"
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
              <h3 id="config-detail-title" data-i18n="settings-shell.accountTitle">
                {text('settings-shell.accountTitle', '账户详情')}
              </h3>
            </div>
            <p id="config-account-context" data-i18n="settings-shell.accountContext">
              {text('settings-shell.accountContext', '编辑连接与默认模型')}
            </p>
          </div>
          <div className="config-detail-grid">
            <fieldset className="config-section account-provider-step">
              <legend data-i18n="settings-shell.connectionLegend">
                {text('settings-shell.connectionLegend', '连接信息')}
              </legend>
              <label className="form-field" htmlFor="config-provider">
                <span data-i18n="settings-shell.providerLabel">
                  {text('settings-shell.providerLabel', 'Provider')}
                </span>
                <SettingsSelect id="config-provider" />
              </label>
            </fieldset>
            <div id="config-provider-choices" />
            <div className="account-connection-step">
              <fieldset className="config-section">
                <label className="form-field form-field-wide" htmlFor="config-api-key">
                  <span data-i18n="settings-shell.apiKeyLabel">
                    {text('settings-shell.apiKeyLabel', 'API Key')}
                  </span>
                  <SettingsInput
                    id="config-api-key"
                    type="password"
                    autoComplete="new-password"
                    placeholder={text('settings-shell.keyPlaceholder', '输入新密钥或保留当前密钥')}
                    data-i18n-placeholder="settings-shell.keyPlaceholder"
                    aria-describedby="config-key-hint"
                  />
                </label>
                <details className="account-key-help">
                  <summary data-i18n="accounts.keyHelp">
                    {text('accounts.keyHelp', '在哪里获取密钥？')}
                  </summary>
                  <p data-i18n="accounts.keyHelpText">
                    {text('accounts.keyHelpText', '在提供商的账户控制台创建 API Key，然后粘贴到这里。')}
                  </p>
                </details>
                <p id="config-key-hint" className="field-hint form-field-wide" />
                <div id="config-oauth-controls" className="form-field-wide" />
              </fieldset>
              <details id="config-account-advanced">
                <summary data-i18n="accounts.advanced">{text('accounts.advanced', '高级选项')}</summary>
                <fieldset className="config-section">
                  <label className="form-field" htmlFor="config-account-name">
                    <span data-i18n="settings-shell.accountNameLabel">
                      {text('settings-shell.accountNameLabel', '账户名称')}
                    </span>
                    <SettingsInput
                      id="config-account-name"
                      maxLength={128}
                      autoComplete="off"
                      placeholder={text('settings-shell.accountNamePlaceholder', '例如：工作账户、本地模型')}
                      data-i18n-placeholder="settings-shell.accountNamePlaceholder"
                    />
                  </label>
                  <label
                    className="form-field form-field-wide"
                    id="config-auth-method-field"
                    htmlFor="config-auth-method"
                  >
                    <span data-i18n="settings-shell.authMethodLabel">
                      {text('settings-shell.authMethodLabel', '认证方式')}
                    </span>
                    <SettingsSelect id="config-auth-method" />
                  </label>
                  <label className="form-field form-field-wide" htmlFor="config-base-url">
                    <span data-i18n="settings-shell.baseUrlLabel">
                      {text('settings-shell.baseUrlLabel', 'Base URL')}
                    </span>
                    <SettingsInput id="config-base-url" autoComplete="url" />
                  </label>
                </fieldset>
                <fieldset className="config-section config-validation-section">
                  <legend data-i18n="settings-shell.validationLegend">
                    {text('settings-shell.validationLegend', '验证与默认模型')}
                  </legend>
                  <div className="config-validation-controls">
                    <label className="form-field" htmlFor="config-model">
                      <span data-i18n="settings-shell.defaultModelLabel">
                        {text('settings-shell.defaultModelLabel', '默认模型')}
                      </span>
                      <SettingsSelect id="config-model" />
                    </label>
                    <Button id="config-test" htmlType="button" appearance="secondary">
                      <svg className="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
                      </svg>
                      <span data-i18n="settings-shell.testConnection">
                        {text('settings-shell.testConnection', '测试连接')}
                      </span>
                    </Button>
                  </div>
                  <label className="form-field" htmlFor="config-thinking">
                    <span data-i18n="settings-shell.defaultThinkingLabel">
                      {text('settings-shell.defaultThinkingLabel', '默认思考强度')}
                    </span>
                    <SettingsSelect id="config-thinking" />
                  </label>
                  <label className="form-field" htmlFor="config-context-window">
                    <span data-i18n="settings-shell.contextBudgetLabel">
                      {text('settings-shell.contextBudgetLabel', '默认上下文预算（Token）')}
                    </span>
                    <SettingsInput
                      id="config-context-window"
                      type="text"
                      maxLength={32}
                      placeholder={text('settings-shell.contextBudgetPlaceholder', '自动（模型目录默认值）')}
                      data-i18n-placeholder="settings-shell.contextBudgetPlaceholder"
                      aria-describedby="config-model-settings-hint config-error"
                    />
                  </label>
                  <p
                    id="config-model-settings-hint"
                    className="field-hint"
                    data-i18n="settings-shell.modelSettingsHint"
                  >
                    {text(
                      'settings-shell.modelSettingsHint',
                      '支持 K/M 单位，如 100K 表示 100,000 Token。新会话继承这些默认值；已有会话保留自己的配置。',
                    )}
                  </p>
                </fieldset>
                <div id="config-account-network" />
                <p id="config-account-guard" data-i18n="settings-shell.accountGuard">
                  {text(
                    'settings-shell.accountGuard',
                    '默认账户不可停用或删除；如需调整，请先将其他已启用账户设为默认。',
                  )}
                </p>
              </details>
              <p id="config-state" aria-live="polite" />
              <Button id="config-retry" hidden htmlType="button" appearance="secondary" size="small">
                <span data-i18n="settings-shell.retryRead">
                  {text('settings-shell.retryRead', '重试读取配置')}
                </span>
              </Button>
              <p id="config-error" role="alert" />
            </div>
          </div>
          <div className="config-detail-footer">
            <div id="config-account-discard" hidden role="alert">
              <p data-i18n="accounts.discard">{text('accounts.discard', '放弃未保存的更改？')}</p>
              <Button id="config-account-keep" htmlType="button" appearance="secondary">
                <span data-i18n="accounts.keepEditing">{text('accounts.keepEditing', '继续编辑')}</span>
              </Button>
              <Button id="config-account-discard-confirm" htmlType="button" appearance="ghost">
                <span data-i18n="accounts.discardAction">{text('accounts.discardAction', '放弃更改')}</span>
              </Button>
            </div>
            <div id="config-account-footer-actions" className="agnes-settings-actions">
              <Button id="config-account-back" htmlType="button" appearance="ghost">
                <span data-i18n="accounts.back">{text('accounts.back', '上一步')}</span>
              </Button>
              <Button id="config-account-cancel" htmlType="button" appearance="secondary">
                <span data-i18n="accounts.cancel">{text('accounts.cancel', '取消')}</span>
              </Button>
              <Button id="config-save" form="config-form" disabled htmlType="submit" appearance="primary">
                <span data-i18n="settings-shell.saveAccount">
                  {text('settings-shell.saveAccount', '保存账户')}
                </span>
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
  const root = createAntdRoot(container)
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
