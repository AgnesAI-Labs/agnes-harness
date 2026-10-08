import type { LocaleCatalog } from '@agnes/web-client'

/** Stable server error codes. The server `message` is the English fallback until a screen calls `t`. */
export const SERVER_ERROR_LOCALE_NAMESPACE = '@agnes/web-errors'

const en = {
  'error.E_ADMIN_ORIGIN': 'The admin request origin is not valid.',
  'error.E_ADMIN_RESPONSE': 'The backend response could not be confirmed.',
  'error.E_ADMIN_BACKEND': 'The operation was not confirmed. Check its status or reconnect to the backend.',
  'error.E_ADMIN_ROUTE': 'The admin operation does not exist.',
  'error.E_ADMIN_REQUEST': 'The admin parameters are not valid.',
  'error.E_ADMIN_SCOPE': 'The admin request does not belong to this profile.',
  'error.E_ADMIN_READ_ONLY': 'The admin surface is in read-only recovery mode.',
  'error.E_RESOURCE_ADMIN_ORIGIN': 'The resource admin request origin is not valid.',
  'error.E_RESOURCE_ADMIN_ROUTE': 'The resource admin operation does not exist.',
  'error.E_RESOURCE_ADMIN_REQUEST': 'The resource admin parameters are not valid.',
  'error.E_RESOURCE_ADMIN_SCOPE': 'The resource admin request does not belong to this profile.',
  'error.E_RESOURCE_ADMIN_READ_ONLY': 'The resource admin surface is in read-only recovery mode.',
  'error.E_RESOURCE_ADMIN_RESPONSE': 'The backend response could not be confirmed.',
  'error.E_RESOURCE_ADMIN_BODY_TOO_LARGE': 'The resource admin request body is too large.',
  'error.E_RESOURCE_UNSUPPORTED': 'This backend version does not support that resource admin capability.',
  'error.E_RESOURCE_ADMIN_BACKEND':
    'The operation was not confirmed. Check its status or reconnect to the backend.',
  'error.SKILL_SOURCE_MANAGED': 'This skill is provided by a plugin. Remove it from plugin management.',
  'error.SKILL_DELETE_PREFLIGHT_FAILED':
    'The delete preflight failed, so the skill was not changed. Check the path, version, and local delete support. Windows network-share paths are not supported yet.',
  'error.SKILL_STALE': 'The skill source has not refreshed successfully. Refresh it and try again.',
  'error.SKILL_REMOVED': 'This skill is being permanently deleted and cannot be enabled again.',
  'error.RESOURCE_BUSY': 'This skill is already handling another operation. Wait for it to finish.',
  'error.SKILL_DELETE_NOT_CANCELLABLE': 'A permanent delete cannot be cancelled after it starts.',
  'error.REVISION_CONFLICT': 'Another operation updated this resource. Refresh and check the latest version.',
  'error.MCP_NOT_FOUND': 'The MCP definition does not exist or has been removed.',
  'error.RESOURCE_OPERATION_UNAVAILABLE': 'The operation does not exist, or this account cannot view it.',
  'error.RESOURCE_OPERATION_OWNER_REQUIRED': 'You can only cancel resource operations that you started.',
  'error.RESOURCE_RECONCILE_FAILED':
    'The backend could not apply the resource state safely. Check the latest status.',
  'error.SKILL_REMOVAL_PENDING':
    'Permanent deletion has not finished. Re-enabling is blocked. Clear any file lock and retry the delete.',
  'error.HELPER_MANAGEMENT_FAILED':
    'The AGH extension operation did not finish. Check its status or policy in Settings.',
  'error.SESSION_TITLE_INVALID': 'A title must be 1–80 characters on one visible line.',
} as const

const zh: Record<keyof typeof en, string> = {
  'error.E_ADMIN_ORIGIN': '管理请求来源无效。',
  'error.E_ADMIN_RESPONSE': '后台返回的数据无法确认。',
  'error.E_ADMIN_BACKEND': '操作未确认，请查询状态或重新连接后台。',
  'error.E_ADMIN_ROUTE': '管理操作不存在。',
  'error.E_ADMIN_REQUEST': '管理参数无效。',
  'error.E_ADMIN_SCOPE': '管理请求不属于当前配置。',
  'error.E_ADMIN_READ_ONLY': '当前为只读恢复模式。',
  'error.E_RESOURCE_ADMIN_ORIGIN': '资源管理请求来源无效。',
  'error.E_RESOURCE_ADMIN_ROUTE': '资源管理操作不存在。',
  'error.E_RESOURCE_ADMIN_REQUEST': '资源管理参数无效。',
  'error.E_RESOURCE_ADMIN_SCOPE': '资源管理请求不属于当前配置。',
  'error.E_RESOURCE_ADMIN_READ_ONLY': '当前为只读恢复模式。',
  'error.E_RESOURCE_ADMIN_RESPONSE': '后台返回的数据无法确认。',
  'error.E_RESOURCE_ADMIN_BODY_TOO_LARGE': '资源管理请求体超过大小限制。',
  'error.E_RESOURCE_UNSUPPORTED': '当前后台版本不支持此资源管理能力。',
  'error.E_RESOURCE_ADMIN_BACKEND': '操作未确认，请查询状态或重新连接后台。',
  'error.SKILL_SOURCE_MANAGED': '此 技能 由插件提供，请通过插件管理移除。',
  'error.SKILL_DELETE_PREFLIGHT_FAILED':
    '删除预检未通过，未更改 技能 状态。请检查路径、版本和本机删除能力；Windows 网络共享路径暂不支持。',
  'error.SKILL_STALE': '技能 来源尚未成功刷新，请先刷新后重试。',
  'error.SKILL_REMOVED': '此 技能 已进入永久删除流程，不能重新启用。',
  'error.RESOURCE_BUSY': '此 技能 正在处理另一项操作，请等待完成。',
  'error.SKILL_DELETE_NOT_CANCELLABLE': '永久删除开始后不能取消。',
  'error.REVISION_CONFLICT': '资源已被另一项操作更新，请刷新后核对最新版本。',
  'error.MCP_NOT_FOUND': 'MCP 定义不存在或已被移除。',
  'error.RESOURCE_OPERATION_UNAVAILABLE': '操作不存在，或当前账户无权查看该操作。',
  'error.RESOURCE_OPERATION_OWNER_REQUIRED': '只能取消自己发起的资源操作。',
  'error.RESOURCE_RECONCILE_FAILED': '后台未能安全应用资源状态，请查看最新状态。',
  'error.SKILL_REMOVAL_PENDING': '永久删除尚未完成；已阻止重新启用，可排除文件占用后重试删除。',
  'error.HELPER_MANAGEMENT_FAILED': 'AGH 扩展操作未完成，请检查设置中的状态或策略。',
  'error.SESSION_TITLE_INVALID': '标题需为 1–80 个字符的单行可见文本。',
}

export const serverErrorCatalog: LocaleCatalog = { en: { ...en }, 'zh-CN': { ...zh } }
