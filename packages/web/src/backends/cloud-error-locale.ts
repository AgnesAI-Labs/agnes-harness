export const cloudErrorCatalog = {
  en: {
    CLOUD_BROKER_REQUIRED:
      'The cloud connection service is not configured. Contact your deployment administrator.',
    CLOUD_CONNECTION_INVALID:
      'Reconnect to retrieve the instance bound to your credential. If this continues, contact your deployment administrator.',
    CLOUD_SANDBOX_NOT_READY:
      'The sandbox is stopped, changing state or unavailable. Check its status before reconnecting.',
    CLOUD_RATE_LIMITED: 'Cloud connection requests are rate limited. Wait before reconnecting.',
    CLOUD_CREDENTIAL_REQUIRED: 'Select a local credential in Settings → Advanced → Cloud connection.',
    CLOUD_CREDENTIAL_REJECTED: 'The cloud service rejected the selected credential.',
    CLOUD_CREDENTIAL_NOT_FOUND: 'The selected credential was removed. Select another local credential.',
    CLOUD_AUTH_UNAVAILABLE: 'Cloud authorization is unavailable. Try reconnecting.',
    CLOUD_INVALID_AUTHORIZATION: 'The cloud service returned an invalid authorization response.',
    CLOUD_ORIGIN_DENIED: 'This cloud connection is not authorized.',
    CLOUD_SERVICE_UNAVAILABLE: 'The cloud service is unavailable or incompatible. Try reconnecting.',
  },
  'zh-CN': {
    CLOUD_BROKER_REQUIRED: '云端连接服务尚未配置，请联系部署方或查看连接文档。',
    CLOUD_CONNECTION_INVALID: '请重新连接以获取凭证绑定的实例；仍失败时请联系部署方核对实例绑定。',
    CLOUD_SANDBOX_NOT_READY: '沙箱已停机、正在操作或暂不可用，请确认实例状态后重连。',
    CLOUD_RATE_LIMITED: '云端连接请求过于频繁，请稍后再重连。',
    CLOUD_CREDENTIAL_REQUIRED: '请在“设置 → 高级 → 云端连接”选择本地凭证。',
    CLOUD_CREDENTIAL_REJECTED: '云端服务拒绝了所选凭证，请检查凭证。',
    CLOUD_CREDENTIAL_NOT_FOUND: '所选凭证已删除，请重新选择本地凭证。',
    CLOUD_AUTH_UNAVAILABLE: '云端授权服务暂不可用，请重新连接。',
    CLOUD_INVALID_AUTHORIZATION: '云端服务返回的授权响应无效。',
    CLOUD_ORIGIN_DENIED: '此云端连接未获授权。',
    CLOUD_SERVICE_UNAVAILABLE: '云端服务不可用或版本不兼容，请重新连接。',
  },
}
