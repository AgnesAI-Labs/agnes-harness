import type { Locale } from './locale.js'

/** Strings of `/permissions`, merged into the key dictionary by locale-keys.ts so locale-extended.ts does not grow. */
export type PermissionsKey =
  | 'commands.permissions'
  | 'commands.permissionsSummary'
  | 'permissions.usage'
  | 'permissions.permissions'
  | 'permissions.level'
  | 'permissions.readOnly'
  | 'permissions.workspaceWrite'
  | 'permissions.fullAccess'
  | 'permissions.yolo'
  | 'permissions.approvalMode'
  | 'permissions.sandbox'
  | 'permissions.unloaded'
  | 'permissions.noIsolation'
  | 'permissions.tools'
  | 'permissions.allAvailable'
  | 'permissions.disabled'
  | 'permissions.allowOnly'
  | 'permissions.dirs'
  | 'permissions.grants'
  | 'permissions.none'
  | 'permissions.footer'

export const PERMISSIONS_DICT: Record<Locale, Record<PermissionsKey, string>> = {
  en: {
    'commands.permissions':
      'Show what this session may do in one place: permission level, sandbox, tools, extra directories and approval grants; /permissions revoke <n|id> withdraws a grant',
    'commands.permissionsSummary': 'Show what the session may do',
    'permissions.usage': 'usage: /permissions [revoke <n|grantId>]',
    'permissions.permissions': 'Permissions',
    'permissions.level': 'Level',
    'permissions.readOnly': 'read only',
    'permissions.workspaceWrite': 'can edit the workspace',
    'permissions.fullAccess': 'full access',
    'permissions.yolo': 'yolo',
    'permissions.approvalMode': 'Approval mode',
    'permissions.sandbox': 'Sandbox',
    'permissions.unloaded': 'session not loaded',
    'permissions.noIsolation': '⚠ no OS-level process isolation',
    'permissions.tools': 'Tools',
    'permissions.allAvailable': 'all available',
    'permissions.disabled': 'disabled: {names}',
    'permissions.allowOnly': 'only allowed: {names}',
    'permissions.dirs': 'Extra directories',
    'permissions.grants': 'Approval grants',
    'permissions.none': 'none',
    'permissions.footer':
      'Revoke: /permissions revoke <n>; suggest rules from past approvals: run `agh approvals suggest` in a shell',
  },
  'zh-CN': {
    'commands.permissions':
      '一处查看本会话能做什么：权限级别、沙箱、工具、额外目录和审批授权；/permissions revoke <序号|id> 撤销一条授权',
    'commands.permissionsSummary': '查看会话权限总览',
    'permissions.usage': '用法：/permissions [revoke <序号|grantId>]',
    'permissions.permissions': '权限',
    'permissions.level': '级别',
    'permissions.readOnly': '只读',
    'permissions.workspaceWrite': '可改工作区',
    'permissions.fullAccess': '完全访问',
    'permissions.yolo': 'yolo',
    'permissions.approvalMode': '审批模式',
    'permissions.sandbox': '沙箱',
    'permissions.unloaded': '会话未加载',
    'permissions.noIsolation': '⚠ 没有系统级进程隔离',
    'permissions.tools': '工具',
    'permissions.allAvailable': '全部可用',
    'permissions.disabled': '已禁用：{names}',
    'permissions.allowOnly': '仅允许：{names}',
    'permissions.dirs': '额外目录',
    'permissions.grants': '放行规则',
    'permissions.none': '无',
    'permissions.footer':
      '撤销：`/permissions revoke <序号>`；按历史审批推荐规则：在 shell 里运行 `agh approvals suggest`',
  },
}
