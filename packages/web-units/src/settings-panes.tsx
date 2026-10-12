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
              <p className="eyebrow">{text('settings-shell.modelKicker', '连接设置')}</p>
              <h2 id="config-title">{text('settings-shell.modelTitle', '模型账户')}</h2>
              <p>
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
            >
              <div className="config-accounts-heading">
                <div>
                  <h3>{text('settings-shell.accountsTitle', '我的账户')}</h3>
                  <p>{text('settings-shell.accountsIntro', '每个账户独立保存地址、密钥和模型。')}</p>
                </div>
                <Button
                  id="config-add-account"
                  aria-label={text('settings-shell.addAccount', '添加账户')}
                  htmlType="button"
                  appearance="primary"
                >
                  <svg className="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  <span>{text('settings-shell.addAccount', '添加账户')}</span>
                </Button>
              </div>
              <div id="config-accounts" />
              <p className="config-list-note">
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
            title={<span>{text('shell.embedded.heading', '插件')}</span>}
            description={
              <span>{text('shell.embedded.description', '安装、启用和检查 Agnes 的本地插件。')}</span>
            }
          />
          <div className="admin-pane-body">
            <section
              id="recovery-notice"
              className="recovery-notice"
              hidden
              aria-label={text('shell.recovery.aria', '恢复模式')}
            >
              <strong>{text('shell.recovery.title', '只读恢复模式')}</strong>
              <p>
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
            >
              <div className="orphan-pins-heading">
                <strong>{text('shell.orphan.title', '存在未释放的遗留占用')}</strong>
                <Button id="orphan-pins-release-all" htmlType="button" appearance="secondary" size="small">
                  <span>{text('shell.orphan.release-all', '全部释放')}</span>
                </Button>
              </div>
              <p id="orphan-pins-status" className="orphan-pins-status" hidden />
              <ul id="orphan-pins-list" className="orphan-pins-list" />
            </section>
            <p id="admin-notice" className="admin-notice" role="status" aria-live="polite" />
            <p id="plugin-tree-status" className="plugin-tree-status" role="status" aria-live="polite" />
            <div className="plugin-toolbar">
              <div className="plugin-tabs" role="tablist" aria-label={text('shell.tabs.aria', '插件视图')}>
                <Button
                  id="installed-tab"
                  role="tab"
                  aria-selected="true"
                  aria-controls="plugin-list"
                  htmlType="button"
                  appearance="ghost"
                >
                  <span>{text('shell.tab.installed', '已安装')}</span>
                </Button>
                <Button
                  id="discover-tab"
                  role="tab"
                  aria-selected="false"
                  aria-controls="plugin-list"
                  htmlType="button"
                  appearance="ghost"
                >
                  <span>{text('shell.tab.discover', '发现')}</span>
                </Button>
                <SettingsDshHost name="settings.plugins.tab" />
              </div>
              <div className="admin-toolbar-actions">
                <label className="plugin-search-field" htmlFor="plugin-search">
                  <span className="visually-hidden">{text('shell.search.aria', '搜索插件')}</span>
                  <SettingsInput
                    id="plugin-search"
                    type="search"
                    autoComplete="off"
                    placeholder={text('search.installed', '筛选当前已安装列表')}
                  />
                </label>
                <Button id="install-source" htmlType="button" appearance="primary" size="small">
                  <span>{text('shell.install', '从来源安装')}</span>
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
            title={<span>{text('shell.heading', '技能与 MCP')}</span>}
            description={
              <>
                <span>
                  {text(
                    'shell.embedded.description',
                    '查看来源、信任和运行状态；凭据只以 SecretRef 引用保存。',
                  )}
                </span>
                <br />
                <span data-testid="resource-add-hint">
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
                  <span>{text('button.refresh', '刷新技能目录')}</span>
                </Button>
                <Button id="mcp-create" hidden htmlType="button" appearance="primary">
                  <span>{text('button.create', '添加 MCP')}</span>
                </Button>
              </div>
            </div>
            <div id="resource-layout" className="plugin-layout resource-layout">
              <section
                id="resource-list"
                className="plugin-list"
                aria-live="polite"
                aria-label={text('shell.list.aria', '资源目录')}
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
            title={<span>{text('settings-shell.archivedTitle', '已归档会话')}</span>}
            className="archived-heading"
            description={
              <span>
                {text('settings-shell.archivedIntro', '查看已暂时收起的会话，需要时可以恢复到工作区。')}
              </span>
            }
            actions={
              <Button id="archived-refresh" htmlType="button" appearance="secondary" size="small">
                <span>{text('settings-shell.refreshList', '刷新列表')}</span>
              </Button>
            }
          />
          <div className="archived-pane-body">
            <div className="archived-toolbar agnes-settings-toolbar">
              <Field
                className="archived-search-field"
                htmlFor="archived-search"
                label={<span>{text('settings-shell.searchLabel', '搜索名称或工作区')}</span>}
              >
                <SettingsInput
                  id="archived-search"
                  type="search"
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
            title={<span>{text('settings-shell.computerUseNav', 'Computer Use')}</span>}
            description={
              <span>
                {text('computerUse.intro', '让 Agnes 查看屏幕并操作应用。需要使用支持图片的模型。')}
              </span>
            }
            actions={
              <Button id="computer-use-refresh" htmlType="button" appearance="secondary" size="small">
                <span>{text('computerUse.action.refresh', '刷新状态')}</span>
              </Button>
            }
          />
          <div className="config-workspace">
            <section className="config-card" aria-labelledby="computer-use-state">
              <p className="eyebrow">{text('computerUse.status.eyebrow', '使用状态')}</p>
              <strong id="computer-use-state" role="status">
                {text('settings-shell.computerUseWaiting', '等待检查')}
              </strong>
              <p id="computer-use-summary">
                {text('settings-shell.computerUseWaitingSummary', '正在等待连接本地后台。')}
              </p>
              <p id="computer-use-runtime" />
              <ul id="computer-use-blockers" />
            </section>
            <section className="config-card" aria-labelledby="computer-use-permission-state">
              <p className="eyebrow">{text('computerUse.permissions.eyebrow', '系统权限')}</p>
              <strong id="computer-use-permission-state">
                {text('settings-shell.computerUseWaiting', '等待检查')}
              </strong>
              <p id="computer-use-permission-summary">
                {text('settings-shell.computerUsePermissionsSummary', '驱动就绪后显示当前系统所需的权限。')}
              </p>
              <Button
                id="computer-use-permission-grant"
                hidden
                htmlType="button"
                appearance="primary"
                size="small"
              >
                <span>{text('computerUse.permissions.grant', '打开 macOS 授权')}</span>
              </Button>
            </section>
            <section className="config-card" aria-labelledby="computer-use-doctor-state">
              <p className="eyebrow">{text('computerUse.doctor.eyebrow', '驱动诊断')}</p>
              <strong id="computer-use-doctor-state">
                {text('settings-shell.computerUseWaiting', '等待检查')}
              </strong>
              <p id="computer-use-doctor-summary">
                {text('settings-shell.computerUseDoctorSummary', '检查本机驱动是否正常。')}
              </p>
              <Button id="computer-use-doctor-run" htmlType="button" appearance="secondary" size="small">
                <span>{text('computerUse.doctor.run', '运行诊断')}</span>
              </Button>
            </section>
            <section className="config-card" aria-labelledby="computer-use-operation-state">
              <p className="eyebrow">{text('computerUse.operation.eyebrow', '安装与维护')}</p>
              <strong id="computer-use-operation-state">
                {text('settings-shell.computerUseNoRecord', '没有记录')}
              </strong>
              <p id="computer-use-operation-summary">
                {text(
                  'settings-shell.computerUsePrepareSummary',
                  '首次使用会自动准备驱动；已有安装会先验证并复用。',
                )}
              </p>
              <div className="config-actions">
                <Button id="computer-use-install" htmlType="button" appearance="secondary" size="small">
                  <span>{text('computerUse.action.install', '准备驱动')}</span>
                </Button>
                <Button id="computer-use-update" htmlType="button" appearance="secondary" size="small">
                  <span>{text('computerUse.action.update', '更新驱动')}</span>
                </Button>
                <Button id="computer-use-restart" htmlType="button" appearance="secondary" size="small">
                  <span>{text('computerUse.action.restart', '重启驱动')}</span>
                </Button>
                <Button
                  id="computer-use-operation-refresh"
                  htmlType="button"
                  appearance="secondary"
                  size="small"
                >
                  <span>{text('computerUse.action.operationRefresh', '刷新进度')}</span>
                </Button>
                <Button
                  id="computer-use-operation-cancel"
                  hidden
                  htmlType="button"
                  appearance="secondary"
                  size="small"
                >
                  <span>{text('computerUse.action.cancel', '取消操作')}</span>
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
            title={<span>{text('settings-shell.appearanceTitle', '通用设置')}</span>}
            description={
              <span>
                {text('settings-shell.appearanceIntro', '调整界面配色与字号。设置只保存在本机浏览器中。')}
              </span>
            }
          />
          <div className="config-workspace">
            <SettingsDshHost name="settings.general.item" />
            <section
              className="config-card appearance-card"
              aria-label={text('settings-shell.palette', '配色')}
            >
              <fieldset className="appearance-options">
                <legend>{text('settings-shell.palette', '配色')}</legend>
                <SettingsChoice
                  type="radio"
                  name="agnes-theme"
                  value="system"
                  label={<span>{text('settings-shell.paletteSystem', '跟随系统')}</span>}
                  hint={
                    <span>{text('settings-shell.paletteSystemHint', '随操作系统的深浅色设置自动切换')}</span>
                  }
                />
                <SettingsChoice
                  type="radio"
                  name="agnes-theme"
                  value="light"
                  label={<span>{text('settings-shell.paletteLight', '浅色')}</span>}
                  hint={<span>{text('settings-shell.paletteLightHint', '始终使用浅色界面')}</span>}
                />
                <SettingsChoice
                  type="radio"
                  name="agnes-theme"
                  value="dark"
                  label={<span>{text('settings-shell.paletteDark', '深色')}</span>}
                  hint={<span>{text('settings-shell.paletteDarkHint', '始终使用深色界面')}</span>}
                />
              </fieldset>
            </section>
            <section className="config-card appearance-card" aria-label={text('settings-shell.skin', '皮肤')}>
              <fieldset className="appearance-options">
                <legend>{text('settings-shell.skin', '皮肤')}</legend>
                <div id="skin-option-items" />
              </fieldset>
            </section>
            <section
              className="config-card appearance-card"
              aria-label={text('settings-shell.fontScale', '字号')}
            >
              <fieldset className="appearance-options">
                <legend>{text('settings-shell.fontScale', '字号')}</legend>
                <SettingsChoice
                  type="radio"
                  name="agnes-font-scale"
                  value="small"
                  label={<span>{text('settings-shell.fontSmall', '小')}</span>}
                  hint={<span>{text('settings-shell.fontSmallHint', '界面整体缩小一档')}</span>}
                />
                <SettingsChoice
                  type="radio"
                  name="agnes-font-scale"
                  value="normal"
                  label={<span>{text('settings-shell.fontNormal', '标准')}</span>}
                  hint={<span>{text('settings-shell.fontNormalHint', '默认字号')}</span>}
                />
                <SettingsChoice
                  type="radio"
                  name="agnes-font-scale"
                  value="large"
                  label={<span>{text('settings-shell.fontLarge', '大')}</span>}
                  hint={<span>{text('settings-shell.fontLargeHint', '界面整体放大一档')}</span>}
                />
              </fieldset>
            </section>
            <section
              className="config-card appearance-card"
              aria-label={text('settings.appearance.language', '语言')}
            >
              <fieldset className="appearance-options">
                <legend>{text('settings.appearance.language', '语言')}</legend>
                <SettingsChoice
                  type="radio"
                  name="agnes-locale"
                  value="en"
                  defaultChecked
                  label={<span>{text('settings.appearance.language.en', 'English')}</span>}
                  hint={<span>{text('settings.appearance.language.en.hint', '使用英文界面')}</span>}
                />
                <SettingsChoice
                  type="radio"
                  name="agnes-locale"
                  value="zh-CN"
                  label={<span>{text('settings.appearance.language.zh-CN', '简体中文')}</span>}
                  hint={<span>{text('settings.appearance.language.zh-CN.hint', '使用简体中文界面')}</span>}
                />
              </fieldset>
            </section>
          </div>
        </section>
      )
  }
}
