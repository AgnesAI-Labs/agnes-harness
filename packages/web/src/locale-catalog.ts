import type { LocaleCatalog } from '@agnes/web-client'

/** 宿主内置文案的命名空间。分支期只覆盖插槽回退与语言开关自身。 */
export const WEB_LOCALE_NAMESPACE = '@agnes/web'

export const webLocaleCatalog: LocaleCatalog = {
  en: {
    'slot.notReady': 'Plugin for this slot is not ready',
    'slot.entryFailed': 'Plugin render failed',
  },
  'zh-CN': {
    'slot.notReady': '此槽位的插件未就绪',
    'slot.entryFailed': '插件渲染失败',
  },
}
