import type { Locale } from './locale.js'

/** Strings of /provider: a locale file of their own so locale-extended.ts stays small. */
export type ProviderKey =
  | 'commands.provider'
  | 'commands.providerSummary'
  | 'provider.remote'
  | 'provider.loadFailed'
  | 'provider.none'
  | 'provider.title'
  | 'provider.configured'
  | 'provider.keyTitle'
  | 'provider.keyLabel'
  | 'provider.keyHint'
  | 'provider.keyEmpty'
  | 'provider.keyInvalid'
  | 'provider.testing'
  | 'provider.saving'
  | 'provider.unverified'
  | 'provider.noModels'
  | 'provider.catalogue.network'
  | 'provider.catalogue.timeout'
  | 'provider.catalogue.redirect'
  | 'provider.catalogue.http'
  | 'provider.catalogue.not-json'
  | 'provider.catalogue.empty'
  | 'provider.catalogue.invalid'
  | 'provider.modelTitle'
  | 'provider.savedUsable'
  | 'provider.savedNewSessions'
  | 'provider.savedRestart'
  | 'provider.conflict'

export const PROVIDER_DICT: Record<Locale, Record<ProviderKey, string>> = {
  en: {
    'commands.provider':
      'Add a model provider: pick one, enter its API key, test it and choose the default model (this machine only)',
    'commands.providerSummary': 'Add a model provider',
    'provider.remote':
      'Model accounts can only be configured on this machine. Use the Web settings page instead.',
    'provider.loadFailed': 'Could not read the provider list. {error}',
    'provider.none': 'No provider here can be set up with an API key.',
    'provider.title': 'Add a model provider',
    'provider.configured': 'configured',
    'provider.keyTitle': '{provider} API key',
    'provider.keyLabel': 'API key:',
    'provider.keyHint': 'sent to the local daemon only',
    'provider.keyEmpty': 'Enter the API key first.',
    'provider.keyInvalid': 'An API key is printable ASCII without spaces.',
    'provider.testing': 'Testing the connection…',
    'provider.saving': 'Saving…',
    'provider.unverified': 'The key could not be verified. Check it and try again.',
    'provider.noModels': 'This provider has no usable models.',
    'provider.catalogue.network': 'Could not reach the provider (network error).',
    'provider.catalogue.timeout': 'The provider did not answer in time.',
    'provider.catalogue.redirect': 'The provider redirected the request, which is refused.',
    'provider.catalogue.http': 'The provider refused the request (HTTP {status}).',
    'provider.catalogue.not-json': 'The provider answered with something that is not a model list.',
    'provider.catalogue.empty': 'The provider returned no models.',
    'provider.catalogue.invalid': 'The provider returned an invalid model list.',
    'provider.modelTitle': '{provider}: default model',
    'provider.savedUsable': 'Saved {provider} / {model}. Switch to it with /model.',
    'provider.savedNewSessions': 'Saved {provider} / {model}. It applies to new sessions.',
    'provider.savedRestart': 'Saved {provider} / {model}. Restart the daemon for it to apply.',
    'provider.conflict': 'The configuration was changed elsewhere. Run /provider again.',
  },
  'zh-CN': {
    'commands.provider': '添加模型供应商：选择供应商、输入 API key、测试连接并选定默认模型（仅限本机）',
    'commands.providerSummary': '添加模型供应商',
    'provider.remote': '只能在本机配置模型账号，请用 Web 设置页。',
    'provider.loadFailed': '无法读取供应商列表。{error}',
    'provider.none': '这里没有可以用 API key 配置的供应商。',
    'provider.title': '添加模型供应商',
    'provider.configured': '已配置',
    'provider.keyTitle': '{provider} API key',
    'provider.keyLabel': 'API key：',
    'provider.keyHint': '只发给本机 daemon',
    'provider.keyEmpty': '请先输入 API key。',
    'provider.keyInvalid': 'API key 只能是不含空格的可打印 ASCII 字符。',
    'provider.testing': '正在测试连接…',
    'provider.saving': '正在保存…',
    'provider.unverified': '无法验证 key，请检查后重试。',
    'provider.noModels': '该供应商没有可用模型。',
    'provider.catalogue.network': '无法连接供应商（网络错误）。',
    'provider.catalogue.timeout': '供应商响应超时。',
    'provider.catalogue.redirect': '供应商返回了重定向，已拒绝。',
    'provider.catalogue.http': '供应商拒绝了请求（HTTP {status}）。',
    'provider.catalogue.not-json': '供应商返回的不是模型列表。',
    'provider.catalogue.empty': '供应商没有返回任何模型。',
    'provider.catalogue.invalid': '供应商返回的模型列表无效。',
    'provider.modelTitle': '{provider}：默认模型',
    'provider.savedUsable': '已保存 {provider} / {model}，用 /model 切换。',
    'provider.savedNewSessions': '已保存 {provider} / {model}，新会话生效。',
    'provider.savedRestart': '已保存 {provider} / {model}，重启 daemon 后生效。',
    'provider.conflict': '配置在别处被修改，请重新运行 /provider。',
  },
}
