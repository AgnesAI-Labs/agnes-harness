import type { LocaleCatalog } from '@agnes/web-ui'
import { candidatesCatalog } from './admin/candidates.js'
import { operationsCatalog } from './admin/operations.js'
import { runtimeCatalog } from './admin/runtime.js'
import { trustCatalog } from './admin/trust.js'
import { pluginAdminShellLocaleCatalog } from './shell.js'

export const PLUGIN_ADMIN_LOCALE_NAMESPACE = '@agnes/web/plugin-admin'

export const pluginAdminLocaleCatalog: LocaleCatalog = {
  en: {
    'ux.examples': 'Official examples',
    'ux.settings': 'Settings',
    'ux.success.enable': 'Enabled {name}',
    'ux.success.disable': 'Disabled {name}',
    'ux.success.install': 'Installed {name}',
    'ux.success.update': 'Updated {name}',
    'ux.success.remove': 'Removed {name}',
    'ux.success.rollback': 'Restored the previous version of {name}',
    'ux.copy': 'Copy',
    'ux.copied': 'Copied',
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
    'ux.examples': '官方示例',
    'ux.settings': '设置',
    'ux.success.enable': '已启用 {name}',
    'ux.success.disable': '已停用 {name}',
    'ux.success.install': '已安装 {name}',
    'ux.success.update': '已更新 {name}',
    'ux.success.remove': '已卸载 {name}',
    'ux.success.rollback': '已恢复 {name} 的上一版本',
    'ux.copy': '复制',
    'ux.copied': '已复制',
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
