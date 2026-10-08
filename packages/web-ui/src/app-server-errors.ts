// Public message keys are safe identifiers, never server-provided prose or exception payloads.
const messages: Record<string, readonly [string, string]> = {
  internal: [
    'The operation could not be confirmed. Use the diagnostic ID to inspect it.',
    '无法确认操作结果，请使用诊断 ID 检查。',
  ],
  invalidRequest: ['The request is not valid.', '请求无效。'],
  invalidParams: ['Check the request parameters.', '请检查请求参数。'],
  methodNotFound: ['This operation is unavailable.', '此操作不可用。'],
  forbidden: ['You do not have permission for this operation.', '你没有执行此操作的权限。'],
  auth: ['Reconnect to authenticate again.', '请重新连接并认证。'],
  busy: ['The session is busy. Try again after its turn completes.', '会话正在运行，请在本轮结束后重试。'],
  notFound: ['The session or resource is unavailable.', '会话或资源不可用。'],
  conflict: ['Settings changed. Reload before retrying.', '设置已变更，请刷新后重试。'],
  timeout: ['The operation timed out. Inspect its status before retrying.', '操作超时，请检查状态后再重试。'],
  unavailable: [
    'The required backend is unavailable. Check its configuration.',
    '所需后端不可用，请检查配置。',
  ],
  credentialRequired: ['Add a credential for this provider.', '请为此提供方添加凭据。'],
  credentialRejected: ['The credential was rejected. Check it and try again.', '凭据被拒绝，请检查后重试。'],
  credentialStore: [
    'The credential could not be stored. Check storage access.',
    '无法保存凭据，请检查存储权限。',
  ],
  provider: [
    'The selected provider cannot serve this request. Check plugin state and compatibility.',
    '所选提供方无法处理请求，请检查插件状态和兼容性。',
  ],
  generation: [
    'The pinned plugin generation is unavailable or incompatible.',
    '固定的插件代际不可用或不兼容。',
  ],
  rejected: [
    'The operation was refused. Check its configuration and current state.',
    '操作被拒绝，请检查配置和当前状态。',
  ],
}
export function appServerErrorMessage(value: unknown, locale: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const data = (value as { data?: { messageKey?: unknown } }).data
  const key = data?.messageKey
  if (typeof key !== 'string' || !key.startsWith('appServer.errors.')) return undefined
  const name = key.slice('appServer.errors.'.length)
  if (!Object.hasOwn(messages, name)) return undefined
  const pair = messages[name]
  return pair?.[locale.toLowerCase().startsWith('zh') ? 1 : 0]
}
