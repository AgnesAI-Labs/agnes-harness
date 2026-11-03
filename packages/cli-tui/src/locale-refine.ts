import type { Locale } from './locale.js'

/** Strings of /refine and the RSI cost line of the usage report. */
export type RefineKey =
  | 'commands.refine'
  | 'commands.refineSummary'
  | 'refine.off'
  | 'refine.workspace'
  | 'refine.tooLong'
  | 'refine.queued'
  | 'refine.unsupported'
  | 'refine.refused'
  | 'refine.reason.child-session'
  | 'refine.reason.closing'
  | 'refine.reason.invalid'
  | 'refine.reason.unpriced'
  | 'usage.rows.rsi'
  | 'usage.rows.rsiTokens'

export const REFINE_DICT: Record<Locale, Record<RefineKey, string>> = {
  en: {
    'commands.refine':
      'Review this session in the background and keep the lessons as experience: /refine [focus]',
    'commands.refineSummary': 'Review session for lessons',
    'refine.off':
      'Experience refinement (RSI) is not active. Turn it on in settings; if you just did, restart to apply it.',
    'refine.workspace':
      'Saving to the workspace is not available yet. /refine [focus] keeps the lessons for this session.',
    'refine.tooLong': 'The focus is too long: 512 characters at most.',
    'refine.queued':
      'Experience review queued ({id}). It plans in the background; the result shows in the timeline.',
    'refine.unsupported': 'This daemon does not support /refine.',
    'refine.refused': 'Experience review was not started: {reason}.',
    'refine.reason.child-session': 'a forked or child session does not plan experience',
    'refine.reason.closing': 'the session is closing',
    'refine.reason.invalid': 'the request was not valid',
    'refine.reason.unpriced': 'the planning model has no known price',
    'usage.rows.rsi': 'RSI cost (background experience review, not in the figures above): {value}',
    'usage.rows.rsiTokens': 'input {input} · output {output}',
  },
  'zh-CN': {
    'commands.refine': '在后台复盘本会话并把经验留下来：/refine [关注点]',
    'commands.refineSummary': '复盘本会话的经验',
    'refine.off': 'RSI（经验复盘）尚未生效。请先在设置中开启；如果刚刚开启，请重启后生效。',
    'refine.workspace': '保存到工作区暂未提供。/refine [关注点] 会把经验留在本会话里。',
    'refine.tooLong': '关注点太长：最多 512 个字符。',
    'refine.queued': '已排队一次经验复盘（{id}）。它在后台规划，结果会显示在时间线里。',
    'refine.unsupported': '当前的守护进程不支持 /refine。',
    'refine.refused': '经验复盘没有开始：{reason}。',
    'refine.reason.child-session': '分叉出的子会话不做经验规划',
    'refine.reason.closing': '会话正在关闭',
    'refine.reason.invalid': '请求无效',
    'refine.reason.unpriced': '规划模型没有已知价格',
    'usage.rows.rsi': 'RSI 费用（后台经验复盘，不含在上面的数字里）：{value}',
    'usage.rows.rsiTokens': '输入 {input} · 输出 {output}',
  },
}
