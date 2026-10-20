import { attachmentErrorCode, publicErrorHelp } from '@agnes/protocol'

/** Render only schema-owned public copy. Opaque messages, reasons and codes never become prose. */
export function formatTuiErrorNotice(error?: unknown, locale = 'en'): string {
  const zh = locale.toLowerCase().startsWith('zh')
  const generic = zh ? '请求失败，请检查状态后重试。' : 'Request failed. Try again.'
  try {
    if (error === null || typeof error !== 'object') return generic
    const attachment = attachmentErrorCode(error)
    if (attachment)
      return zh
        ? `请求失败 (${attachment})：请重新选择原始文件，或在当前会话中上传。`
        : `Request failed (${attachment}). Select the original again or upload it in the current session.`
    const help = publicErrorHelp(error, locale)
    if (help)
      return zh
        ? `请求失败 (${help.code})：${help.reason}${help.action}`
        : `Request failed (${help.code}): ${help.reason} ${help.action}`
    const envelope = (error as { data?: { code?: unknown } }).data?.code
    if (envelope === 'TURN_ERROR') return zh ? '请求失败 (TURN_ERROR)。' : 'Request failed (TURN_ERROR).'
    return generic
  } catch {
    // Getters and Proxies are untrusted presentation input.
    return generic
  }
}
