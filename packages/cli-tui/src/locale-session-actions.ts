import type { Locale } from './locale.js'

/** Strings of /paste, Ctrl-V and other session actions: kept beside the other locale files so locale-extended.ts stays small. */
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
  | 'paste.drop.attached'
  | 'paste.drop.failed'
  | 'commands.schedule'
  | 'commands.scheduleSummary'
  | 'commands.loop'
  | 'commands.loopSummary'
  | 'schedule.usage'
  | 'schedule.loopUsage'
  | 'schedule.badInterval'
  | 'schedule.tooLong'
  | 'schedule.card'
  | 'schedule.noPending'
  | 'schedule.cancelled'
  | 'schedule.created'
  | 'schedule.refused'
  | 'schedule.none'
  | 'schedule.unknown'
  | 'schedule.deleted'
  | 'export.unavailable'
  | 'export.usage'
  | 'export.done'
  | 'export.failed'
  | 'commands.rate'
  | 'commands.rateSummary'
  | 'rate.usage'
  | 'rate.tooLong'
  | 'rate.none'
  | 'rate.unsupported'
  | 'rate.done'
  | 'commands.clear'
  | 'commands.clearSummary'

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
    'paste.drop.attached': 'Attached {name} as {chip}; it is sent with your next message',
    'paste.drop.failed': 'Attaching {name} failed: {reason}; its path was left in the prompt',
    'commands.schedule':
      "Schedule a prompt for this session: every <interval> or daily <HH:MM>; list or delete the session's schedules",
    'commands.scheduleSummary': 'Schedule prompts',
    'commands.loop': 'Run a prompt in this session at a fixed interval (shorthand for /schedule every)',
    'commands.loopSummary': 'Repeat a prompt on a timer',
    'schedule.usage':
      'usage: /schedule [list] | every <interval> <prompt> | daily <HH:MM> <prompt> | delete <n|id> | confirm | cancel',
    'schedule.loopUsage':
      'usage: /loop <interval> <prompt> (an interval such as 90s, 30m, 2h or 1d, from 60s to 366d), then /loop confirm or /loop cancel',
    'schedule.badInterval':
      'Not a valid interval: {value}. Use a period such as 90s, 30m, 2h or 1d, from 60s to 366d',
    'schedule.tooLong': 'The prompt is longer than {max} characters',
    'schedule.card':
      'Create this scheduled prompt?\n  when     {when}\n  prompt   {prompt}\n  session  {session}\nRun /schedule confirm to create it, or /schedule cancel.',
    'schedule.noPending': 'Nothing to confirm; start with /loop or /schedule',
    'schedule.cancelled': 'schedule cancelled',
    'schedule.created': 'Scheduled {id} ({when}); /schedule lists it and /schedule delete removes it',
    'schedule.refused': 'Schedule refused: {code}',
    'schedule.none': 'No scheduled prompts for this session',
    'schedule.unknown': 'No schedule {key} in this session',
    'schedule.deleted': 'Deleted schedule {id}',
    'export.unavailable':
      'Export needs the shared local daemon connection; it is not available with --connect, --standalone or --ephemeral',
    'export.usage': 'usage: /export [agnes|html|sharegpt|claude-code] [path]',
    'export.done': 'Exported ({format}, redacted) to {path}',
    'export.failed': 'Export failed: {reason}',
    'commands.rate': 'Rate the latest finished reply up or down, with an optional reason (the Web thumbs)',
    'commands.rateSummary': 'Rate the latest reply',
    'rate.usage': 'usage: /rate up|down [reason]',
    'rate.tooLong': 'The reason is longer than {max} characters',
    'rate.none': 'No finished reply to rate yet',
    'rate.unsupported': 'This daemon does not support ratings',
    'rate.done': 'Rated the reply of turn {turn} {rating}',
    'commands.clear':
      'Clear the conversation: start a new session in this workspace with an empty context (the old one stays in /resume)',
    'commands.clearSummary': 'Clear the conversation',
  },
  'zh-CN': {
    'commands.paste': '把剪贴板里的图片作为下一条消息的附件（等同于 Ctrl-V）',
    'commands.pasteSummary': '附上剪贴板图片',
    'paste.image.chip': '[图片 #{n}]',
    'paste.image.attached': '已把剪贴板图片附为 {chip}，随下一条消息发送',
    'paste.drop.attached': '已把 {name} 附为 {chip}，随下一条消息发送',
    'paste.drop.failed': '附加 {name} 失败：{reason}；路径已留在输入框里',
    'paste.image.empty': '剪贴板里没有图片',
    'paste.image.unavailable': '这里读不了剪贴板：缺少 {tool}',
    'paste.image.timeout': '读取剪贴板超时',
    'paste.image.tooLarge': '剪贴板里的图片超过 {mb} MB',
    'paste.image.failed': '没能从剪贴板读到图片',
    'paste.image.uploadFailed': '附加剪贴板图片失败：{reason}',
    'commands.schedule': '给当前会话定时发提示：every <间隔> 或 daily <HH:MM>；列出或删除本会话的定时任务',
    'commands.scheduleSummary': '定时发送提示',
    'commands.loop': '按固定间隔向当前会话重复发一条提示（/schedule every 的简写）',
    'commands.loopSummary': '按间隔重复发提示',
    'schedule.usage':
      '用法：/schedule [list] | every <间隔> <提示> | daily <HH:MM> <提示> | delete <序号|id> | confirm | cancel',
    'schedule.loopUsage':
      '用法：/loop <间隔> <提示>（间隔如 90s、30m、2h、1d，范围 60 秒到 366 天），然后 /loop confirm 或 /loop cancel',
    'schedule.badInterval': '间隔无效：{value}。请用 90s、30m、2h、1d 这样的写法，范围 60 秒到 366 天',
    'schedule.tooLong': '提示超过 {max} 个字符',
    'schedule.card':
      '创建这条定时提示？\n  时间     {when}\n  提示     {prompt}\n  会话     {session}\n运行 /schedule confirm 创建，或 /schedule cancel 放弃。',
    'schedule.noPending': '没有待确认的定时任务；请先用 /loop 或 /schedule',
    'schedule.cancelled': '已取消定时任务',
    'schedule.created': '已创建定时任务 {id}（{when}）；/schedule 列出，/schedule delete 删除',
    'schedule.refused': '定时任务被拒绝：{code}',
    'schedule.none': '本会话没有定时提示',
    'schedule.unknown': '本会话没有定时任务 {key}',
    'schedule.deleted': '已删除定时任务 {id}',
    'export.unavailable':
      '导出需要共享的本机 daemon 连接；使用 --connect、--standalone 或 --ephemeral 时不可用',
    'export.usage': '用法：/export [agnes|html|sharegpt|claude-code] [路径]',
    'export.done': '已导出（{format}，已脱敏）到 {path}',
    'export.failed': '导出失败：{reason}',
    'commands.rate': '给最近一条已完成的回复点赞或点踩，可附理由（与 Web 的拇指相同）',
    'commands.rateSummary': '给最近回复打分',
    'rate.usage': '用法：/rate up|down [理由]',
    'rate.tooLong': '理由超过 {max} 个字符',
    'rate.none': '还没有可打分的已完成回复',
    'rate.unsupported': '这个 daemon 不支持打分',
    'rate.done': '已给第 {turn} 轮的回复打分：{rating}',
    'commands.clear': '清空对话：在当前工作区新开一个上下文为空的会话（旧会话仍可用 /resume 找回）',
    'commands.clearSummary': '清空对话',
  },
}
