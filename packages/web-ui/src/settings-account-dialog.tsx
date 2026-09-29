import { SettingsOptionSelect } from './settings-option-select.js'
import { Button } from './ui/button.js'
import { Field } from './ui/field.js'

export function SettingsAccountDialog() {
  return (
    <dialog data-agnes-region="dialog" id="account-dialog" aria-labelledby="config-detail-title">
      <Button
        id="account-dialog-close"
        type="text"
        htmlType="button"
        className="icon-button account-dialog-close"
        aria-label="关闭账户详情"
      >
        <svg className="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      </Button>
      <section className="account-dialog-body" aria-labelledby="config-detail-title">
        <div className="config-detail-heading">
          <div>
            <p className="eyebrow">账户配置</p>
            <h3 id="config-detail-title">账户详情</h3>
          </div>
          <p id="config-account-context">编辑连接与默认模型</p>
        </div>
        <div className="config-detail-grid">
          <fieldset className="config-section">
            <legend>连接信息</legend>
            <Field className="form-field" label="账户名称">
              <input
                id="config-account-name"
                maxLength={128}
                autoComplete="off"
                placeholder="例如：工作账户、本地模型"
              />
            </Field>
            <Field className="form-field" label="Provider">
              <SettingsOptionSelect id="config-provider" />
            </Field>
            <Field className="form-field form-field-wide" id="config-auth-method-field" label="认证方式">
              <SettingsOptionSelect id="config-auth-method" />
            </Field>
            <Field className="form-field form-field-wide" label="Base URL">
              <input id="config-base-url" autoComplete="url" />
            </Field>
            <Field className="form-field form-field-wide" label="API Key">
              <input
                id="config-api-key"
                type="password"
                autoComplete="new-password"
                placeholder="输入新密钥或保留当前密钥"
                aria-describedby="config-key-hint"
              />
            </Field>
            <p id="config-key-hint" className="field-hint form-field-wide" />
            <div id="config-oauth-controls" className="form-field-wide" />
          </fieldset>
          <fieldset className="config-section config-validation-section">
            <legend>验证与默认模型</legend>
            <div className="config-validation-controls">
              <Field className="form-field" label="默认模型">
                <SettingsOptionSelect id="config-model" />
              </Field>
              <Button id="config-test" className="secondary-button" htmlType="button">
                <svg className="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
                </svg>
                <span>测试连接</span>
              </Button>
            </div>
            <p id="config-state" aria-live="polite" />
            <Button id="config-retry" className="secondary-button compact" htmlType="button" hidden>
              重试读取配置
            </Button>
            <p id="config-error" role="alert" />
          </fieldset>
        </div>
        <div className="config-detail-footer">
          <p id="config-account-guard">默认账户不可停用或删除；如需调整，请先将其他已启用账户设为默认。</p>
          <Button id="config-save" className="primary-button" htmlType="submit" form="config-form" disabled>
            保存账户
          </Button>
        </div>
      </section>
    </dialog>
  )
}
