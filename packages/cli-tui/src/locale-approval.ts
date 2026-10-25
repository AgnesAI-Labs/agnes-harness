import type { Locale } from './locale.js'

/**
 * Strings the approval card and the permission modal share (headline, outcome lines, key hints).
 * locale-keys.ts merges them into its dictionary, so locale-extended.ts (at the source-size limit) does not change.
 */
export type ApprovalKey =
  | 'approval.needs'
  | 'approval.expires'
  | 'approval.by'
  | 'approval.did.allowedOnce'
  | 'approval.did.allowedSession'
  | 'approval.did.allowedPermanent'
  | 'approval.did.allowedPrefix'
  | 'approval.did.rejected'
  | 'approval.did.expired'
  | 'approval.did.failed'
  | 'approval.reasonLabel'
  | 'approval.inDialog'
  | 'approval.argsUnseen'
  | 'approval.hint.reject'
  | 'approval.hint.back'
  | 'permission.hint.select'
  | 'permission.hint.confirm'
  | 'permission.hint.details'
  | 'permission.hint.close'
  | 'approval.rejectAlways'

export const APPROVAL_DICT: Record<Locale, Record<ApprovalKey, string>> = {
  en: {
    'approval.needs': 'Needs approval',
    'approval.expires': 'expires {time}',
    'approval.by': 'by {name}',
    'approval.did.allowedOnce': 'Allowed once',
    'approval.did.allowedSession': 'Allowed for this session',
    'approval.did.allowedPermanent': 'Always allowed for this profile',
    'approval.did.allowedPrefix': 'Allowed commands with this prefix for this session',
    'approval.did.rejected': 'Rejected',
    'approval.did.expired': 'Expired',
    'approval.did.failed': 'Decision not applied',
    'approval.reasonLabel': 'Reason for the model',
    'approval.inDialog': 'Answer in the dialog below',
    'approval.argsUnseen':
      'The input is too large to show here. Allowing runs input this card does not show; the line above is the model’s own description.',
    'approval.hint.reject': 'reject',
    'approval.hint.back': 'back',
    'permission.hint.select': 'select',
    'permission.hint.confirm': 'confirm',
    'permission.hint.details': 'details {start}-{end}/{total}',
    'permission.hint.close': 'close',
    'approval.rejectAlways': 'Always reject',
  },
  'zh-CN': {
    'approval.needs': '需要审批',
    'approval.expires': '到期 {time}',
    'approval.by': '由 {name}',
    'approval.did.allowedOnce': '已允许一次',
    'approval.did.allowedSession': '本会话已允许',
    'approval.did.allowedPermanent': '对此配置已始终允许',
    'approval.did.allowedPrefix': '本会话已允许此前缀的命令',
    'approval.did.rejected': '已拒绝',
    'approval.did.expired': '已过期',
    'approval.did.failed': '决定未生效',
    'approval.reasonLabel': '给模型的理由',
    'approval.inDialog': '请在下方对话框中作答',
    'approval.argsUnseen':
      '输入过大，此处无法显示。允许将运行本卡片未显示的输入；上面一行是模型自己写的描述。',
    'approval.hint.reject': '拒绝',
    'approval.hint.back': '返回',
    'permission.hint.select': '选择',
    'permission.hint.confirm': '确认',
    'permission.hint.details': '详情 {start}-{end}/{total}',
    'permission.hint.close': '关闭',
    'approval.rejectAlways': '总是拒绝',
  },
}
