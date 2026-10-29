import { Button, SettingsInput, SettingsPageHeader } from '@agnes/web-ui'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { mountRenderedIndex } from './web-dom-fixture.js'

/**
 * The plugin and Skill / MCP controllers were first written against panes of the settings dialog,
 * and their tests still mount them that way. The dialog no longer has those panes (the plugins page
 * hosts the controllers through a page surface), so this fixture supplies the markup the
 * controllers bind to and the open-then-sync sequence the settings rail used to drive.
 * Remove it once those tests mount the controllers through the page surface.
 */
type Tab = 'skills' | 'mcp'
export type MountedAdminPane = Readonly<{
  reload(): Promise<void>
  ready?: Promise<void>
  sync?(scope: { tab: Tab; workspaceId?: string }, options?: { refresh?: boolean }): Promise<void>
}>

const text = (_key: string, fallback: string) => fallback

function AdminPaneHosts() {
  return (
    <>
      <Button id="plugin-management" htmlType="button" appearance="ghost" />
      <div role="tablist">
        <Button id="skills-tab" role="tab" aria-selected="true" htmlType="button" appearance="ghost" />
        <Button id="mcp-tab" role="tab" aria-selected="false" htmlType="button" appearance="ghost" />
      </div>
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
            <section id="plugin-list" className="plugin-list" role="tabpanel" aria-live="polite"></section>
          </div>
        </div>
      </section>

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
          actions={
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
          }
        />
        <div className="admin-pane-body">
          <p id="resource-notice" className="admin-notice" role="status" aria-live="polite" />
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
    </>
  )
}

let installed: { root: Root; host: HTMLElement } | undefined

/** Put the admin pane markup in the document, with the named pane on screen. */
export function installAdminPaneHosts(shown: 'plugin' | 'resources' = 'plugin'): () => void {
  installed?.root.unmount()
  installed?.host.remove()
  const host = document.createElement('div')
  ;(document.getElementById('settings-content-slots') ?? document.body).append(host)
  const root = createRoot(host)
  flushSync(() => root.render(<AdminPaneHosts />))
  installed = { root, host }
  showAdminPane(shown)
  return () => {
    root.unmount()
    host.remove()
    if (installed?.root === root) installed = undefined
  }
}

function showAdminPane(pane: 'plugin' | 'resources'): void {
  document.getElementById('plugin-settings-pane')?.toggleAttribute('hidden', pane !== 'plugin')
  document.getElementById('resource-settings-pane')?.toggleAttribute('hidden', pane !== 'resources')
}

/** The workbench with the admin panes in the document and one controller mounted per pane on demand. */
export async function mountAdminWorkbench(mounts: {
  mountPlugin?: () => Promise<MountedAdminPane>
  mountResources?: (scope: { tab: Tab; workspaceId?: string }) => Promise<MountedAdminPane>
  workspaceId?: () => string | undefined
}) {
  const runtime = await mountRenderedIndex()
  const uninstall = installAdminPaneHosts()
  const mounted = new Map<'plugin' | 'resources', MountedAdminPane>()
  const opened: Promise<void>[] = []
  const selectTab = (tab: Tab) => {
    for (const id of ['skills', 'mcp'] as const)
      document.getElementById(`${id}-tab`)?.setAttribute('aria-selected', String(id === tab))
  }
  async function open(pane: 'plugin' | 'resources', tab: Tab = 'skills'): Promise<void> {
    showAdminPane(pane)
    const existing = mounted.get(pane)
    if (pane === 'plugin') {
      if (existing) await existing.reload()
      else if (mounts.mountPlugin) mounted.set(pane, await mounts.mountPlugin())
      return
    }
    selectTab(tab)
    const workspaceId = mounts.workspaceId?.()
    const scope = workspaceId ? { tab, workspaceId } : { tab }
    if (existing) return existing.sync?.(scope, { refresh: true })
    if (!mounts.mountResources) throw new Error('this fixture does not mount that admin pane')
    const resources = await mounts.mountResources(scope)
    mounted.set(pane, resources)
    await resources.ready
  }
  for (const tab of ['skills', 'mcp'] as const)
    document
      .getElementById(`${tab}-tab`)
      ?.addEventListener('click', () => opened.push(open('resources', tab)))
  const dispose = runtime.dispose.bind(runtime)
  runtime.dispose = async () => {
    uninstall()
    await dispose()
  }
  return { runtime, open, opened }
}
