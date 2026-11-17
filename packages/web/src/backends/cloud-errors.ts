import { cloudErrorCatalog as messages } from './cloud-error-locale.js'
export function cloudFailureCode(value: unknown): keyof typeof messages.en {
  return typeof value === 'string' && Object.hasOwn(messages.en, value)
    ? (value as keyof typeof messages.en)
    : 'CLOUD_SERVICE_UNAVAILABLE'
}
export function cloudFailureText(value: unknown, language = document.documentElement.lang): string {
  return messages[language === 'zh-CN' ? 'zh-CN' : 'en'][cloudFailureCode(value)]
}
