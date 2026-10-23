import type { Locale } from './locale.js'

/** Picker labels of the colour-blind friendly themes. */
export type DaltonizedKey = 'theme.darkDaltonized' | 'theme.lightDaltonized'

export const DALTONIZED_DICT: Record<Locale, Record<DaltonizedKey, string>> = {
  en: {
    'theme.darkDaltonized': 'Dark colour-blind · blue / orange / yellow states',
    'theme.lightDaltonized': 'Light colour-blind · blue / orange / yellow states',
  },
  'zh-CN': {
    'theme.darkDaltonized': '深色色盲友好 · 蓝 / 橙 / 黄状态色',
    'theme.lightDaltonized': '明亮色盲友好 · 蓝 / 橙 / 黄状态色',
  },
}
