import type { LocaleCatalog } from './index.js'

/** 组件内置可访问性文案（W1）。经 `ComposerDependencies.translate` 注入，命名空间 `@agnes/web-units`。 */
export const composerLocaleCatalog: LocaleCatalog = {
  en: {
    'composer.input.label': 'Task content',
    'composer.permission.accessible': 'Choose permission for this session',
    'composer.permission.workspace': 'Changes apply within the workspace',
    'composer.usage.label': 'Context usage',
    'composer.queue.label': 'Queued messages',
    'composer.queue.count': 'Queued · {count}',
    'composer.queue.attachment': 'Message with attachments',
    'composer.queue.send': 'Send now',
    'composer.queue.sending': 'Stopping and sending…',
    'composer.queue.sendAccessible': 'Send queued message {index} now',
    'composer.queue.sendTitle': 'Stop the current turn and run this message first',
  },
  'zh-CN': {
    'composer.input.label': '任务内容',
    'composer.permission.accessible': '选择本会话权限',
    'composer.permission.workspace': '工作区内修改',
    'composer.usage.label': '上下文用量',
    'composer.queue.label': '待执行消息',
    'composer.queue.count': '待执行 · {count}',
    'composer.queue.attachment': '含附件的消息',
    'composer.queue.send': '立即发送',
    'composer.queue.sending': '正在停止并发送…',
    'composer.queue.sendAccessible': '立即发送第 {index} 条待执行消息',
    'composer.queue.sendTitle': '停止当前轮，优先执行这条消息',
  },
}
