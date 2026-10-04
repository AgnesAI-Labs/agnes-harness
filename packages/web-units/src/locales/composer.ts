import type { LocaleCatalog } from './index.js'

/** 组件内置可访问性文案（W1）。经 `ComposerDependencies.translate` 注入，命名空间 `@agnes/web-units`。 */
export const composerLocaleCatalog: LocaleCatalog = {
  en: {
    'composer.input.label': 'Task content',
    'composer.permission.accessible': 'Choose permission for this session',
    'composer.permission.workspace': 'Changes apply within the workspace',
    'composer.usage.label': 'Context usage',
    'composer.image.limit': 'PNG and JPEG, up to 4 images and 1 MiB in total.',
    'composer.image.reading': 'Reading image…',
    'composer.image.invalid': 'The file is not a valid PNG or JPEG image.',
    'composer.image.invalidType': 'Only PNG and JPEG images are supported.',
    'composer.image.readFailed': 'The image could not be read.',
    'composer.image.alt': 'Attached image {index}',
    'composer.image.remove': 'Remove image {index}',
    'composer.image.tooMany': 'A message can hold at most 4 images.',
    'composer.image.tooLarge': 'Images in one message must total no more than 1 MiB.',
  },
  'zh-CN': {
    'composer.input.label': '任务内容',
    'composer.permission.accessible': '选择本会话权限',
    'composer.permission.workspace': '工作区内修改',
    'composer.usage.label': '上下文用量',
    'composer.image.limit': '支持 PNG 和 JPEG，最多 4 张，合计不超过 1 MiB。',
    'composer.image.reading': '正在读取图片…',
    'composer.image.invalid': '文件内容不是有效的 PNG 或 JPEG 图片。',
    'composer.image.invalidType': '目前只支持 PNG 和 JPEG 图片。',
    'composer.image.readFailed': '无法读取图片文件。',
    'composer.image.alt': '附件图片 {index}',
    'composer.image.remove': '移除图片 {index}',
    'composer.image.tooMany': '一条消息最多添加 4 张图片。',
    'composer.image.tooLarge': '单条消息中的图片合计不能超过 1 MiB。',
  },
}
