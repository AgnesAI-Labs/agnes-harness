import type { LocaleCatalog } from './index.js'

/** 工具卡状态标签。经 `ConversationToolCardOptions.translate` 注入。 */
export const toolLocaleCatalog: LocaleCatalog = {
  en: {
    'tool.status.planned': 'Planned',
    'tool.status.awaitingApproval': 'Awaiting approval',
    'tool.status.running': 'Running',
    'tool.status.completed': 'Completed',
    'tool.status.failed': 'Failed',
    'tool.status.cancelled': 'Cancelled',
    'tool.card.aria': 'Tool {name}: {status}',
  },
  'zh-CN': {
    'tool.status.planned': '等待执行',
    'tool.status.awaitingApproval': '等待审批',
    'tool.status.running': '正在执行',
    'tool.status.completed': '执行完成',
    'tool.status.failed': '执行失败',
    'tool.status.cancelled': '已取消',
    'tool.card.aria': '工具 {name}：{status}',
  },
}
