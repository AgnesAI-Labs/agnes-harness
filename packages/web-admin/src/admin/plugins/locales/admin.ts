import type { LocaleCatalog } from '@agnes/web-ui'
import { candidatesCatalog } from './admin/candidates.js'
import { operationsCatalog } from './admin/operations.js'
import { runtimeCatalog } from './admin/runtime.js'
import { trustCatalog } from './admin/trust.js'
import { pluginAdminShellLocaleCatalog } from './shell.js'

export const PLUGIN_ADMIN_LOCALE_NAMESPACE = '@agnes/web/plugin-admin'

export const pluginAdminLocaleCatalog: LocaleCatalog = {
  en: {
    'example.parent.title': 'Managed by the parent plugin',
    'example.parent.missing':
      'This example requires {parent}, which is not installed. Review, install and enable the parent first, then manage this example on its Examples page.',
    'example.parent.disabled':
      'This example is unavailable because {parent} is disabled or not ready. Review and enable the parent first, then use its Examples page.',
    'example.parent.managed': 'This example is managed on the Examples page of {parent}.',
    'example.parent.open': 'Open parent Examples',
    'example.parent.review': 'Review parent first',
    'ux.examples': 'Official examples',
    'ux.settings': 'Settings',
    'ux.success.enable': 'Plugin {name} enabled.',
    'ux.success.disable': 'Plugin {name} disabled.',
    'ux.success.install': 'Plugin {name} installed.',
    'ux.success.update': 'Plugin {name} updated.',
    'ux.success.remove': 'Plugin {name} removed.',
    'ux.success.rollback': 'Plugin {name} rolled back.',
    'ux.copy': 'Copy',
    'ux.copied': 'Content copied.',
    'review.enableRequired': 'Enable the plugin to use it.',
    'ux.copyFailed': 'Could not copy. Select the details and copy them manually.',
    'ux.plugins': 'Plugins',
    'ux.discover': 'Discover',
    'ux.description': 'Give Agnes new tools, views and ways to work.',
    'ux.add': 'Add plugin',
    'ux.browse': 'Browse examples',
    'ux.installed': 'Installed',
    'ux.moreFilters': 'More filters',
    'ux.filter': 'Filter',
    'ux.activeFilters': 'Active filters',
    'ux.details': 'Details',

    ...candidatesCatalog.en,
    ...runtimeCatalog.en,
    ...trustCatalog.en,
    ...operationsCatalog.en,
    ...pluginAdminShellLocaleCatalog.en,
  },
  'zh-CN': {
    'example.parent.title': '由所属插件管理',
    'example.parent.missing':
      '此示例需要尚未安装的 {parent}。请先审核、安装并启用所属插件，再到其示例页面管理此示例。',
    'example.parent.disabled':
      '所属插件 {parent} 已停用或尚未就绪，此示例不可用。请先审核并启用所属插件，再进入其示例页面。',
    'example.parent.managed': '此示例由 {parent} 的示例页面管理。',
    'example.parent.open': '打开所属插件的示例',
    'example.parent.review': '先审核所属插件',
    'ux.examples': '官方示例',
    'ux.settings': '设置',
    'ux.success.enable': '插件「{name}」已启用。',
    'ux.success.disable': '插件「{name}」已停用。',
    'ux.success.install': '插件「{name}」已安装。',
    'ux.success.update': '插件「{name}」已更新。',
    'ux.success.remove': '插件「{name}」已移除。',
    'ux.success.rollback': '插件「{name}」已回滚。',
    'ux.copy': '复制',
    'ux.copied': '内容已复制。',
    'review.enableRequired': '启用插件后可使用。',
    'ux.copyFailed': '复制失败，请选择详情并手动复制。',
    'ux.plugins': '插件',
    'ux.discover': '发现',
    'ux.description': '扩展 Agnes 的能力：工具、界面、安全规则。',
    'ux.add': '添加插件',
    'ux.browse': '浏览官方示例',
    'ux.installed': '已安装',
    'ux.moreFilters': '更多筛选',
    'ux.filter': '筛选',
    'ux.activeFilters': '已启用的筛选',
    'ux.details': '详情',

    ...candidatesCatalog['zh-CN'],
    ...runtimeCatalog['zh-CN'],
    ...trustCatalog['zh-CN'],
    ...operationsCatalog['zh-CN'],
    ...pluginAdminShellLocaleCatalog['zh-CN'],
  },
}
