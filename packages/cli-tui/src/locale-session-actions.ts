import type { Locale } from './locale.js'

/** Strings of /paste and Ctrl-V: kept beside the other locale files so locale-extended.ts stays small. */
export type SessionActionKey =
  | 'commands.paste'
  | 'commands.pasteSummary'
  | 'paste.image.chip'
  | 'paste.image.attached'
  | 'paste.image.empty'
  | 'paste.image.unavailable'
  | 'paste.image.timeout'
  | 'paste.image.tooLarge'
  | 'paste.image.failed'
  | 'paste.image.uploadFailed'

export const SESSION_ACTION_DICT: Record<Locale, Record<SessionActionKey, string>> = {
  en: {
    'commands.paste': 'Attach the image on the clipboard to the next message (same as Ctrl-V)',
    'commands.pasteSummary': 'Attach the clipboard image',
    'paste.image.chip': '[Image #{n}]',
    'paste.image.attached': 'Attached the clipboard image as {chip}; it is sent with your next message',
    'paste.image.empty': 'There is no image on the clipboard',
    'paste.image.unavailable': 'Cannot read the clipboard here: {tool} is not available',
    'paste.image.timeout': 'Reading the clipboard timed out',
    'paste.image.tooLarge': 'The clipboard image is larger than {mb} MB',
    'paste.image.failed': 'Could not read an image from the clipboard',
    'paste.image.uploadFailed': 'Attaching the clipboard image failed: {reason}',
  },
  'zh-CN': {
    'commands.paste': '把剪贴板里的图片作为下一条消息的附件（等同于 Ctrl-V）',
    'commands.pasteSummary': '附上剪贴板图片',
    'paste.image.chip': '[图片 #{n}]',
    'paste.image.attached': '已把剪贴板图片附为 {chip}，随下一条消息发送',
    'paste.image.empty': '剪贴板里没有图片',
    'paste.image.unavailable': '这里读不了剪贴板：缺少 {tool}',
    'paste.image.timeout': '读取剪贴板超时',
    'paste.image.tooLarge': '剪贴板里的图片超过 {mb} MB',
    'paste.image.failed': '没能从剪贴板读到图片',
    'paste.image.uploadFailed': '附加剪贴板图片失败：{reason}',
  },
}
