import type { LocaleCatalog } from '@agnes/web-ui'

/**
 * What remains of the activity-record vocabulary now that the trace is the one full timeline: the
 * conversation's links into it, the reviewer line under a tool, and the change details fold.
 */
export const factChainCatalog: LocaleCatalog = {
  en: {
    'facts.requestLink': 'View in trace',
    'facts.toolLink': 'View in trace',
    'facts.artifactLink': 'View in trace',
    'facts.details': 'Technical details',
    'facts.reviewHumanRule': 'Explicit human rule applied',
    'facts.reviewAllowed': 'Auto-allowed by reviewer',
    'facts.reviewDenied': 'Denied by reviewer',
    'facts.reviewEscalated': 'Reviewer asks for human approval',
  },
  'zh-CN': {
    'facts.requestLink': '在轨迹中查看',
    'facts.toolLink': '在轨迹中查看',
    'facts.artifactLink': '在轨迹中查看',
    'facts.details': '技术详情',
    'facts.reviewHumanRule': '已应用显式人工规则',
    'facts.reviewAllowed': '审查模型自动放行',
    'facts.reviewDenied': '审查模型拒绝',
    'facts.reviewEscalated': '审查模型请求人工批准',
  },
}
