import type { LocaleCatalog } from './services.js'

/** Fallback copy for hosts that have not attached their locale service yet. */
export const slotLocaleCatalog = {
  en: { 'slot.notReady': 'Plugin for this card is not ready' },
  'zh-CN': { 'slot.notReady': '此卡片的插件尚未就绪' },
} satisfies LocaleCatalog
