import type { ReactNode } from 'react'
import { Button } from './ui/button.js'

export function SettingsModelPane({
  beforeAccounts,
  afterAccounts,
}: {
  beforeAccounts: ReactNode
  afterAccounts: ReactNode
}) {
  return (
    <section id="model-settings-pane" className="settings-content" data-agnes-region="settings-pane">
      <header className="config-heading">
        <div>
          <p className="eyebrow">连接设置</p>
          <h2 id="config-title">模型账户</h2>
          <p>管理 Provider 连接和默认模型。保存后，新建任务会使用更新后的配置。</p>
        </div>
      </header>
      <div className="config-workspace">
        {beforeAccounts}
        <section className="config-accounts-section config-card" aria-label="已保存的模型账户">
          <div className="config-accounts-heading">
            <div>
              <h3>我的账户</h3>
              <p>每个账户独立保存地址、密钥和模型。</p>
            </div>
            <Button id="config-add-account" className="secondary-button compact" htmlType="button">
              <svg className="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
              <span>添加账户</span>
            </Button>
          </div>
          <div id="config-accounts" />
          <p className="config-list-note">会话可在已启用账户提供的模型之间切换。</p>
        </section>
        {afterAccounts}
      </div>
    </section>
  )
}
