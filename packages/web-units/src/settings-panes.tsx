import { Button, Field, SettingsChoice, SettingsInput, SettingsPageHeader } from '@agnes/web-ui'
import type { SettingsPane } from './settings.js'
import { SettingsDshHost } from './settings-shell.js'

/** Fixed compatibility surfaces; controllers continue to own field values and page state. */
export function SettingsStaticPane({
  pane,
  translate,
}: {
  pane: SettingsPane
  translate?: (key: string) => string
}) {
  const text = (key: string, fallback: string) => {
    const value = translate?.(key) ?? key
    return value === key ? fallback : value
  }
  switch (pane) {
    case 'model':
      return (
        <section
          id="model-settings-pane"
          className="settings-content agnes-settings-page"
          data-agnes-region="settings-pane"
        >
          <header className="config-heading agnes-settings-page-heading">
            <div>
              <p className="eyebrow" data-i18n="settings-shell.modelKicker">
                {text('settings-shell.modelKicker', '连接设置')}
              </p>
              <h2 id="config-title" data-i18n="settings-shell.modelTitle">
                {text('settings-shell.modelTitle', '模型账户')}
              </h2>
              <p data-i18n="settings-shell.modelIntro">
                {text(
                  'settings-shell.modelIntro',
                  '管理 Provider 连接和默认模型。保存后，新建任务会使用更新后的配置。',
                )}
              </p>
            </div>
          </header>
          <div className="config-workspace">
            <SettingsDshHost name="settings.models.provider-card" />
            <section
              className="config-accounts-section config-card"
              aria-label={text('settings-shell.accountsAria', '已保存的模型账户')}
              data-i18n-aria="settings-shell.accountsAria"
            >
              <div className="config-accounts-heading">
                <div>
                  <h3 data-i18n="settings-shell.accountsTitle">
                    {text('settings-shell.accountsTitle', '我的账户')}
                  </h3>
                  <p data-i18n="settings-shell.accountsIntro">
                    {text('settings-shell.accountsIntro', '每个账户独立保存地址、密钥和模型。')}
                  </p>
                </div>
                <Button
                  id="config-add-account"
                  aria-label={text('settings-shell.addAccount', '添加账户')}
                  data-i18n-aria="settings-shell.addAccount"
                  htmlType="button"
                  appearance="primary"
                >
                  <svg className="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  <span data-i18n="settings-shell.addAccount">
                    {text('settings-shell.addAccount', '添加账户')}
                  </span>
                </Button>
              </div>
              <div id="config-accounts" />
              <p className="config-list-note" data-i18n="settings-shell.accountsNote">
                {text('settings-shell.accountsNote', '会话可在已启用账户提供的模型之间切换。')}
              </p>
            </section>
            <SettingsDshHost name="settings.models.footer" />
          </div>
        </section>
      )
    case 'plugin':
      return (
        <section
          id="plugin-settings-pane"
          className="settings-content admin-pane"
          data-agnes-region="settings-pane"
          hidden
        >
          <SettingsPageHeader
            title={<span data-i18n="shell.embedded.heading">{text('shell.embedded.heading', '插件')}</span>}
            description={
              <span data-i18n="shell.embedded.description">
                {text('shell.embedded.description', '安装、启用和检查 Agnes 的本地插件。')}
              </span>
            }
          />
          <div className="admin-pane-body">
            <section
              id="recovery-notice"
              className="recovery-notice"
              hidden
              aria-label={text('shell.recovery.aria', '恢复模式')}
              data-i18n-aria="shell.recovery.aria"
            >
              <strong data-i18n="shell.recovery.title">{text('shell.recovery.title', '只读恢复模式')}</strong>
              <p data-i18n="shell.recovery.description">
                {text(
                  'shell.recovery.description',
                  '管理页仍可显示安全状态；恢复完成前，所有检查和变更操作均已停用。',
                )}
              </p>
            </section>
            <section
              id="orphan-pins"
              className="orphan-pins"
              hidden
              aria-label={text('shell.orphan.aria', '遗留占用')}
              data-i18n-aria="shell.orphan.aria"
            >
              <div className="orphan-pins-heading">
                <strong data-i18n="shell.orphan.title">
                  {text('shell.orphan.title', '存在未释放的遗留占用')}
                </strong>
                <Button id="orphan-pins-release-all" htmlType="button" appearance="secondary" size="small">
                  <span data-i18n="shell.orphan.release-all">
                    {text('shell.orphan.release-all', '全部释放')}
                  </span>
                </Button>
              </div>
              <p id="orphan-pins-status" className="orphan-pins-status" hidden />
              <ul id="orphan-pins-list" className="orphan-pins-list" />
            </section>
            <p id="admin-notice" className="admin-notice" role="status" aria-live="polite" />
            <p id="plugin-tree-status" className="plugin-tree-status" role="status" aria-live="polite" />
            <div className="plugin-toolbar">
              <div
                className="plugin-tabs"
                role="tablist"
                aria-label={text('shell.tabs.aria', '插件视图')}
                data-i18n-aria="shell.tabs.aria"
              >
                <Button
                  id="installed-tab"
                  role="tab"
                  aria-selected="true"
                  aria-controls="plugin-list"
                  htmlType="button"
                  appearance="ghost"
                >
                  <span data-i18n="shell.tab.installed">{text('shell.tab.installed', '已安装')}</span>
                </Button>
                <Button
                  id="discover-tab"
                  role="tab"
                  aria-selected="false"
                  aria-controls="plugin-list"
                  htmlType="button"
                  appearance="ghost"
                >
                  <span data-i18n="shell.tab.discover">{text('shell.tab.discover', '发现')}</span>
                </Button>
                <SettingsDshHost name="settings.plugins.tab" />
              </div>
              <div className="admin-toolbar-actions">
                <label className="plugin-search-field" htmlFor="plugin-search">
                  <span className="visually-hidden" data-i18n="shell.search.aria">
                    {text('shell.search.aria', '搜索插件')}
                  </span>
                  <SettingsInput
                    id="plugin-search"
                    type="search"
                    autoComplete="off"
                    placeholder={text('search.installed', '筛选当前已安装列表')}
                    data-i18n-placeholder="search.installed"
                  />
                </label>
                <Button id="install-source" htmlType="button" appearance="primary" size="small">
                  <span data-i18n="shell.install">{text('shell.install', '从来源安装')}</span>
                </Button>
              </div>
            </div>
            <div id="plugin-layout" className="plugin-layout">
              <section id="plugin-list" className="plugin-list" role="tabpanel" aria-live="polite">
                <SettingsDshHost name="settings.plugin.item" />
              </section>
            </div>
          </div>
        </section>
      )
    case 'resources':
      return (
        <section
          id="resource-settings-pane"
          className="settings-content admin-pane agnes-settings-page"
          data-agnes-region="settings-pane"
          hidden
        >
          <SettingsPageHeader
            title={<span data-i18n="shell.heading">{text('shell.heading', '技能与 MCP')}</span>}
            description={
              <>
                <span data-i18n="shell.embedded.description">
                  {text(
                    'shell.embedded.description',
                    '查看来源、信任和运行状态；凭据只以 SecretRef 引用保存。',
                  )}
                </span>
                <br />
                <span data-i18n="shell.embedded.add-description">
                  {text(
                    'shell.embedded.add-description',
                    '想添加 MCP？在聊天中说“帮我接入这个 MCP”，并提供服务地址或连接信息。',
                  )}
                </span>
              </>
            }
          />
          <div className="admin-pane-body">
            <p id="resource-notice" className="admin-notice" role="status" aria-live="polite" />
            <div className="resource-toolbar">
              <div className="resource-toolbar-actions">
                <Button id="skill-refresh" htmlType="button" appearance="secondary" size="small">
                  <span data-i18n="button.refresh">{text('button.refresh', '刷新技能目录')}</span>
                </Button>
                <Button id="mcp-create" hidden htmlType="button" appearance="primary">
                  <span data-i18n="button.create">{text('button.create', '添加 MCP')}</span>
                </Button>
              </div>
            </div>
            <div id="resource-layout" className="plugin-layout resource-layout">
              <section
                id="resource-list"
                className="plugin-list"
                aria-live="polite"
                aria-label={text('shell.list.aria', '资源目录')}
                data-i18n-aria="shell.list.aria"
              />
            </div>
          </div>
        </section>
      )
    case 'archived':
      return (
        <section
          id="archived-settings-pane"
          className="settings-content agnes-settings-page"
          data-agnes-region="settings-pane"
          hidden
        >
          <SettingsPageHeader
            title={
              <span data-i18n="settings-shell.archivedTitle">
                {text('settings-shell.archivedTitle', '已归档会话')}
              </span>
            }
            className="archived-heading"
            description={
              <span data-i18n="settings-shell.archivedIntro">
                {text('settings-shell.archivedIntro', '查看已暂时收起的会话，需要时可以恢复到工作区。')}
              </span>
            }
            actions={
              <Button id="archived-refresh" htmlType="button" appearance="secondary" size="small">
                <span data-i18n="settings-shell.refreshList">
                  {text('settings-shell.refreshList', '刷新列表')}
                </span>
              </Button>
            }
          />
          <div className="archived-pane-body">
            <div className="archived-toolbar agnes-settings-toolbar">
              <Field
                className="archived-search-field"
                htmlFor="archived-search"
                label={
                  <span data-i18n="settings-shell.searchLabel">
                    {text('settings-shell.searchLabel', '搜索名称或工作区')}
                  </span>
                }
              >
                <SettingsInput
                  id="archived-search"
                  type="search"
                  data-i18n-placeholder="settings-shell.searchPlaceholder"
                  placeholder={text('settings-shell.searchPlaceholder', '搜索已归档会话')}
                />
              </Field>
            </div>
            <p
              id="archived-message"
              className="archived-message agnes-settings-state"
              data-tone="error"
              role="alert"
            />
            <div className="archived-list-shell">
              <p
                id="archived-empty"
                className="archived-empty agnes-settings-state"
                data-tone="empty"
                role="status"
              />
              <ul id="archived-list" className="archived-sessions" />
            </div>
          </div>
        </section>
      )
    case 'computer-use':
      return (
        <section
          id="computer-use-settings-pane"
          className="settings-content agnes-settings-page"
          data-agnes-region="settings-pane"
          hidden
        >
          <SettingsPageHeader
            title={
              <span data-i18n="settings-shell.computerUseNav">
                {text('settings-shell.computerUseNav', 'Computer Use')}
              </span>
            }
            description={
              <span data-i18n="computerUse.intro">
                {text('computerUse.intro', '让 Agnes 查看屏幕并操作应用。需要使用支持图片的模型。')}
              </span>
            }
            actions={
              <Button id="computer-use-refresh" htmlType="button" appearance="secondary" size="small">
                <span data-i18n="computerUse.action.refresh">
                  {text('computerUse.action.refresh', '刷新状态')}
                </span>
              </Button>
            }
          />
          <div className="config-workspace">
            <section className="config-card" aria-labelledby="computer-use-state">
              <p className="eyebrow" data-i18n="computerUse.status.eyebrow">
                {text('computerUse.status.eyebrow', '使用状态')}
              </p>
              <strong id="computer-use-state" role="status" data-i18n="settings-shell.computerUseWaiting">
                {text('settings-shell.computerUseWaiting', '等待检查')}
              </strong>
              <p id="computer-use-summary" data-i18n="settings-shell.computerUseWaitingSummary">
                {text('settings-shell.computerUseWaitingSummary', '正在等待连接本地后台。')}
              </p>
              <p id="computer-use-runtime" />
              <ul id="computer-use-blockers" />
            </section>
            <section className="config-card" aria-labelledby="computer-use-permission-state">
              <p className="eyebrow" data-i18n="computerUse.permissions.eyebrow">
                {text('computerUse.permissions.eyebrow', '系统权限')}
              </p>
              <strong id="computer-use-permission-state" data-i18n="settings-shell.computerUseWaiting">
                {text('settings-shell.computerUseWaiting', '等待检查')}
              </strong>
              <p
                id="computer-use-permission-summary"
                data-i18n="settings-shell.computerUsePermissionsSummary"
              >
                {text('settings-shell.computerUsePermissionsSummary', '驱动就绪后显示当前系统所需的权限。')}
              </p>
              <Button
                id="computer-use-permission-grant"
                hidden
                htmlType="button"
                appearance="primary"
                size="small"
              >
                <span data-i18n="computerUse.permissions.grant">
                  {text('computerUse.permissions.grant', '打开 macOS 授权')}
                </span>
              </Button>
            </section>
            <section className="config-card" aria-labelledby="computer-use-doctor-state">
              <p className="eyebrow" data-i18n="computerUse.doctor.eyebrow">
                {text('computerUse.doctor.eyebrow', '驱动诊断')}
              </p>
              <strong id="computer-use-doctor-state" data-i18n="settings-shell.computerUseWaiting">
                {text('settings-shell.computerUseWaiting', '等待检查')}
              </strong>
              <p id="computer-use-doctor-summary" data-i18n="settings-shell.computerUseDoctorSummary">
                {text('settings-shell.computerUseDoctorSummary', '检查本机驱动是否正常。')}
              </p>
              <Button id="computer-use-doctor-run" htmlType="button" appearance="secondary" size="small">
                <span data-i18n="computerUse.doctor.run">{text('computerUse.doctor.run', '运行诊断')}</span>
              </Button>
            </section>
            <section className="config-card" aria-labelledby="computer-use-operation-state">
              <p className="eyebrow" data-i18n="computerUse.operation.eyebrow">
                {text('computerUse.operation.eyebrow', '安装与维护')}
              </p>
              <strong id="computer-use-operation-state" data-i18n="settings-shell.computerUseNoRecord">
                {text('settings-shell.computerUseNoRecord', '没有记录')}
              </strong>
              <p id="computer-use-operation-summary" data-i18n="settings-shell.computerUsePrepareSummary">
                {text(
                  'settings-shell.computerUsePrepareSummary',
                  '首次使用会自动准备驱动；已有安装会先验证并复用。',
                )}
              </p>
              <div className="config-actions">
                <Button id="computer-use-install" htmlType="button" appearance="secondary" size="small">
                  <span data-i18n="computerUse.action.install">
                    {text('computerUse.action.install', '准备驱动')}
                  </span>
                </Button>
                <Button id="computer-use-update" htmlType="button" appearance="secondary" size="small">
                  <span data-i18n="computerUse.action.update">
                    {text('computerUse.action.update', '更新驱动')}
                  </span>
                </Button>
                <Button id="computer-use-restart" htmlType="button" appearance="secondary" size="small">
                  <span data-i18n="computerUse.action.restart">
                    {text('computerUse.action.restart', '重启驱动')}
                  </span>
                </Button>
                <Button
                  id="computer-use-operation-refresh"
                  htmlType="button"
                  appearance="secondary"
                  size="small"
                >
                  <span data-i18n="computerUse.action.operationRefresh">
                    {text('computerUse.action.operationRefresh', '刷新进度')}
                  </span>
                </Button>
                <Button
                  id="computer-use-operation-cancel"
                  hidden
                  htmlType="button"
                  appearance="secondary"
                  size="small"
                >
                  <span data-i18n="computerUse.action.cancel">
                    {text('computerUse.action.cancel', '取消操作')}
                  </span>
                </Button>
              </div>
            </section>
          </div>
        </section>
      )
    case 'appearance':
      return (
        <section
          id="appearance-settings-pane"
          className="settings-content agnes-settings-page"
          data-agnes-region="settings-pane"
          hidden
        >
          <SettingsPageHeader
            title={
              <span data-i18n="settings-shell.appearanceTitle">
                {text('settings-shell.appearanceTitle', '通用设置')}
              </span>
            }
            description={
              <span data-i18n="settings-shell.appearanceIntro">
                {text('settings-shell.appearanceIntro', '调整界面配色与字号。设置只保存在本机浏览器中。')}
              </span>
            }
          />
          <div className="config-workspace">
            <SettingsDshHost name="settings.general.item" />
            <section
              className="config-card appearance-card"
              aria-label={text('settings-shell.palette', '配色')}
              data-i18n-aria="settings-shell.palette"
            >
              <fieldset className="appearance-options">
                <legend data-i18n="settings-shell.palette">{text('settings-shell.palette', '配色')}</legend>
                <SettingsChoice
                  type="radio"
                  name="agnes-theme"
                  value="system"
                  label={
                    <span data-i18n="settings-shell.paletteSystem">
                      {text('settings-shell.paletteSystem', '跟随系统')}
                    </span>
                  }
                  hint={
                    <span data-i18n="settings-shell.paletteSystemHint">
                      {text('settings-shell.paletteSystemHint', '随操作系统的深浅色设置自动切换')}
                    </span>
                  }
                />
                <SettingsChoice
                  type="radio"
                  name="agnes-theme"
                  value="light"
                  label={
                    <span data-i18n="settings-shell.paletteLight">
                      {text('settings-shell.paletteLight', '浅色')}
                    </span>
                  }
                  hint={
                    <span data-i18n="settings-shell.paletteLightHint">
                      {text('settings-shell.paletteLightHint', '始终使用浅色界面')}
                    </span>
                  }
                />
                <SettingsChoice
                  type="radio"
                  name="agnes-theme"
                  value="dark"
                  label={
                    <span data-i18n="settings-shell.paletteDark">
                      {text('settings-shell.paletteDark', '深色')}
                    </span>
                  }
                  hint={
                    <span data-i18n="settings-shell.paletteDarkHint">
                      {text('settings-shell.paletteDarkHint', '始终使用深色界面')}
                    </span>
                  }
                />
              </fieldset>
            </section>
            <section
              className="config-card appearance-card"
              aria-label={text('settings-shell.skin', '皮肤')}
              data-i18n-aria="settings-shell.skin"
            >
              <fieldset className="appearance-options">
                <legend data-i18n="settings-shell.skin">{text('settings-shell.skin', '皮肤')}</legend>
                <div id="skin-option-items" />
              </fieldset>
            </section>
            <section
              className="config-card appearance-card"
              aria-label={text('settings-shell.fontScale', '字号')}
              data-i18n-aria="settings-shell.fontScale"
            >
              <fieldset className="appearance-options">
                <legend data-i18n="settings-shell.fontScale">
                  {text('settings-shell.fontScale', '字号')}
                </legend>
                <SettingsChoice
                  type="radio"
                  name="agnes-font-scale"
                  value="small"
                  label={
                    <span data-i18n="settings-shell.fontSmall">{text('settings-shell.fontSmall', '小')}</span>
                  }
                  hint={
                    <span data-i18n="settings-shell.fontSmallHint">
                      {text('settings-shell.fontSmallHint', '界面整体缩小一档')}
                    </span>
                  }
                />
                <SettingsChoice
                  type="radio"
                  name="agnes-font-scale"
                  value="normal"
                  label={
                    <span data-i18n="settings-shell.fontNormal">
                      {text('settings-shell.fontNormal', '标准')}
                    </span>
                  }
                  hint={
                    <span data-i18n="settings-shell.fontNormalHint">
                      {text('settings-shell.fontNormalHint', '默认字号')}
                    </span>
                  }
                />
                <SettingsChoice
                  type="radio"
                  name="agnes-font-scale"
                  value="large"
                  label={
                    <span data-i18n="settings-shell.fontLarge">{text('settings-shell.fontLarge', '大')}</span>
                  }
                  hint={
                    <span data-i18n="settings-shell.fontLargeHint">
                      {text('settings-shell.fontLargeHint', '界面整体放大一档')}
                    </span>
                  }
                />
              </fieldset>
            </section>
            <section
              className="config-card appearance-card"
              data-i18n-aria="settings.appearance.language"
              aria-label={text('settings.appearance.language', '语言')}
            >
              <fieldset className="appearance-options">
                <legend data-i18n="settings.appearance.language">
                  {text('settings.appearance.language', '语言')}
                </legend>
                <SettingsChoice
                  type="radio"
                  name="agnes-locale"
                  value="en"
                  defaultChecked
                  label={
                    <span data-i18n="settings.appearance.language.en">
                      {text('settings.appearance.language.en', 'English')}
                    </span>
                  }
                  hint={
                    <span data-i18n="settings.appearance.language.en.hint">
                      {text('settings.appearance.language.en.hint', '使用英文界面')}
                    </span>
                  }
                />
                <SettingsChoice
                  type="radio"
                  name="agnes-locale"
                  value="zh-CN"
                  label={
                    <span data-i18n="settings.appearance.language.zh-CN">
                      {text('settings.appearance.language.zh-CN', '简体中文')}
                    </span>
                  }
                  hint={
                    <span data-i18n="settings.appearance.language.zh-CN.hint">
                      {text('settings.appearance.language.zh-CN.hint', '使用简体中文界面')}
                    </span>
                  }
                />
              </fieldset>
            </section>
          </div>
        </section>
      )
  }
}
