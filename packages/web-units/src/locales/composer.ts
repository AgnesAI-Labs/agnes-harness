import type { LocaleCatalog } from './index.js'

/** 组件内置可访问性文案（W1）。经 `ComposerDependencies.translate` 注入，命名空间 `@agnes/web-units`。 */
export const composerLocaleCatalog: LocaleCatalog = {
  en: {
    'composer.input.label': 'Task content',
    'composer.permission.accessible': 'Choose permission for this session',
    'composer.permission.workspace': 'Changes apply within the workspace',
    'composer.usage.label': 'Context usage',
  },
  'zh-CN': {
    'composer.input.label': '任务内容',
    'composer.permission.accessible': '选择本会话权限',
    'composer.permission.workspace': '工作区内修改',
    'composer.usage.label': '上下文用量',
  },
}
