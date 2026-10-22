import type { Translate } from './locales/index.js'

export const resourceFailureCatalog = {
  en: {
    'resource.error.denied': 'This action is not permitted. Check trust and permissions.',
    'resource.error.conflict': 'The resource changed. Refresh it before trying again.',
    'resource.error.connection': 'The connection failed. Check its configuration and try again.',
    'resource.error.removeBlocked':
      'It is still enabled or has an unfinished operation. Disable it and wait for the operation to finish, then remove it.',
    'resource.error.operation': 'The resource action failed. Check its state and try again.',
    'resource.error.skillLimit':
      'Skill attachment count, size or traversal budget exceeded. Reduce attachments and reload.',
    'resource.error.skillAttachments':
      'A supported Skill attachment could not be read or validated. Repair it and reload.',
    'resource.error.skillDocument': 'Skill document metadata or body is invalid. Fix SKILL.md and reload.',
    'resource.error.skillLoad':
      'Skill document could not be loaded or exceeds its size limit. Repair it and reload.',
  },
  'zh-CN': {
    'resource.error.denied': '当前操作未获允许。请检查信任状态和权限。',
    'resource.error.conflict': '资源已变更。请刷新后重试。',
    'resource.error.connection': '连接失败。请检查配置后重试。',
    'resource.error.removeBlocked': '它仍处于启用状态，或还有未完成的操作。请先停用并等待操作结束，再移除。',
    'resource.error.operation': '资源操作失败。请检查当前状态后重试。',
    'resource.error.skillLimit': 'Skill 附件数量、大小或目录扫描量超过限制。请减少附件后重新加载。',
    'resource.error.skillAttachments': 'Skill 支持的附件读取或校验失败。请修复附件后重新加载。',
    'resource.error.skillDocument': 'Skill 文档元数据或正文无效。请修复 SKILL.md 后重新加载。',
    'resource.error.skillLoad': 'Skill 文档无法加载或大小超过限制。请修复后重新加载。',
  },
}

export function resourceFailureKey(code: string): string {
  if (code === 'SKILL_ATTACHMENTS_LIMIT') return 'resource.error.skillLimit'
  if (code === 'SKILL_ATTACHMENTS_UNREADABLE') return 'resource.error.skillAttachments'
  if (code === 'SKILL_DOCUMENT_INVALID') return 'resource.error.skillDocument'
  if (code === 'SKILL_LOAD_FAILED') return 'resource.error.skillLoad'
  if (code === 'RESOURCE_REMOVE_BLOCKED') return 'resource.error.removeBlocked'
  if (/DENIED|FORBIDDEN|UNAUTHORIZED|TRUST/.test(code)) return 'resource.error.denied'
  if (/CONFLICT|REVISION|STALE/.test(code)) return 'resource.error.conflict'
  if (/MCP|CONNECTION|TRANSPORT/.test(code)) return 'resource.error.connection'
  return 'resource.error.operation'
}

export const resourceFailureLabel = (code: string, t: Translate): string => t(resourceFailureKey(code))
