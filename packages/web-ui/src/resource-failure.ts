import type { Translate } from './locales/index.js'

export const resourceFailureCatalog = {
  en: {
    'resource.error.denied': 'This action is not permitted. Check trust and permissions.',
    'resource.error.conflict': 'The resource changed. Refresh it before trying again.',
    'resource.error.connection': 'The connection failed. Check its configuration and try again.',
    'resource.error.operation': 'The resource action failed. Check its state and try again.',
  },
  'zh-CN': {
    'resource.error.denied': '当前操作未获允许。请检查信任状态和权限。',
    'resource.error.conflict': '资源已变更。请刷新后重试。',
    'resource.error.connection': '连接失败。请检查配置后重试。',
    'resource.error.operation': '资源操作失败。请检查当前状态后重试。',
  },
}

export function resourceFailureKey(code: string): string {
  if (/DENIED|FORBIDDEN|UNAUTHORIZED|TRUST/.test(code)) return 'resource.error.denied'
  if (/CONFLICT|REVISION|STALE/.test(code)) return 'resource.error.conflict'
  if (/MCP|CONNECTION|TRANSPORT/.test(code)) return 'resource.error.connection'
  return 'resource.error.operation'
}

export const resourceFailureLabel = (code: string, t: Translate): string => t(resourceFailureKey(code))
