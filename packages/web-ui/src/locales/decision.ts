import type { LocaleCatalog } from './index.js'

/** Timeline approval outcomes and prefix-approval choices, split from the conversation catalog for shared host/standalone use. */
export const decisionLocaleCatalog = {
  en: {
    'timeline.decision.allowedOnce': 'Allowed once',
    'timeline.decision.allowedSession': 'Allowed for this session',
    'timeline.decision.allowedPrefixSession': 'Allowed matching commands for this session',
    'timeline.decision.allowPrefix': 'Allow commands starting with {prefix} for this session',
    'timeline.decision.allowedPermanent': 'Always allowed for this profile',
    'timeline.decision.rejected': 'Rejected',
    'timeline.decision.cancelled': 'Cancelled',
    'timeline.decision.unavailable': 'Unanswered, not run',
  },
  'zh-CN': {
    'timeline.decision.allowedOnce': '仅允许这次',
    'timeline.decision.allowedSession': '本会话允许',
    'timeline.decision.allowedPrefixSession': '本会话允许同前缀命令',
    'timeline.decision.allowPrefix': '本会话内以 {prefix} 开头的命令不再询问',
    'timeline.decision.allowedPermanent': '对此配置始终允许',
    'timeline.decision.rejected': '已拒绝',
    'timeline.decision.cancelled': '已取消',
    'timeline.decision.unavailable': '未获回答，未执行',
  },
} satisfies LocaleCatalog
