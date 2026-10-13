import type { LocaleCatalog } from '@agnes/web-client'

/** The home shell: sidebar entries, the full pages they open, session search and the archived filter. */
export const homeLocaleCatalog: LocaleCatalog = {
  en: {
    'home.entries.nav': 'Home',
    'home.entry.agents': 'Business agents',
    'home.entry.agents.sub': 'FDE',
    'home.entry.plugins': 'Plugins',
    'home.entry.plugins.pending': '{count} to review',
    'home.entry.automation': 'Automation',
    'home.entry.more': 'More',
    'home.agents.description': 'Pick a business agent and start in one step.',
    'home.plugins.description': 'Add capabilities to Agnes, or adjust the built-in ones.',
    'home.plugins.manage': 'Manage plugins',
    'home.plugins.manageHelp': 'Installed plugins, skills and MCP servers.',
    'home.plugins.open': 'Open',
    'home.automation.description': 'Run tasks on a schedule or when an event arrives.',
    'home.automation.schedules': 'Scheduled tasks',
    'home.automation.triggers': 'Triggers',
  },
  'zh-CN': {
    'home.entries.nav': '主页',
    'home.entry.agents': '业务 Agent',
    'home.entry.agents.sub': 'FDE',
    'home.entry.plugins': '插件',
    'home.entry.plugins.pending': '{count} 项待审阅',
    'home.entry.automation': '自动化',
    'home.entry.more': '更多',
    'home.agents.description': '选一个业务 Agent，一键开始。',
    'home.plugins.description': '给 Agnes 添加能力，或调整内置能力。',
    'home.plugins.manage': '管理插件',
    'home.plugins.manageHelp': '已安装的插件、技能和 MCP 服务。',
    'home.plugins.open': '打开',
    'home.automation.description': '让任务到点或由事件自动运行。',
    'home.automation.schedules': '定时任务',
    'home.automation.triggers': '触发器',
  },
}
