import { type Translate, webUiLocaleCatalog } from '../src/locales/index.js'

export const zhT: Translate = (key, vars) => {
  const value = webUiLocaleCatalog['zh-CN'][key] ?? key
  return vars ? value.replace(/\{(\w+)\}/g, (match, name: string) => String(vars[name] ?? match)) : value
}
