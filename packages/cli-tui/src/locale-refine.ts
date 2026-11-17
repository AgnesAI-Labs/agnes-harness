import type { Locale } from './locale.js'

/** Strings of /refine and the RSI cost line of the usage report. */
export type RefineKey =
  | 'commands.refine'
  | 'commands.refineSummary'
  | 'refine.off'
  | 'refine.workspace'
  | 'refine.user'
  | 'refine.both'
  | 'refine.unpriced'
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
  | 'usage.rows.rsiUnknown'

export const REFINE_DICT: Record<Locale, Record<RefineKey, string>> = {
  en: {
    'commands.refine':
      'Review this session in the background and keep the lessons as experience: /refine [--workspace|--user] [--unpriced] [focus]',
    'commands.refineSummary': 'Review session for lessons',
    'refine.off':
      'Experience refinement (RSI) is not active in this session. Turn it on in settings; it applies to sessions opened after that, so start a new session.',
    'refine.workspace':
      'Experience review queued ({id}). What it keeps is also saved to this workspace, as your own save; each save shows in the timeline.',
    'refine.user':
      'Experience review queued ({id}). What it keeps is also saved to user memory, read in every workspace, as your own save; each save shows in the timeline.',
    'refine.both': 'Use either --workspace or --user, not both.',
    'refine.unpriced':
      'The planning model has no known price, so what this review costs is unknown and no price bounds it (the token budget still does). To run it anyway, ask again with /refine --unpriced [focus].',
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
    'usage.rows.rsiUnknown': 'price unknown',
  },
  'zh-CN': {
    'commands.refine': '在后台复盘本会话并把经验留下来：/refine [--workspace|--user] [--unpriced] [关注点]',
    'commands.refineSummary': '复盘本会话的经验',
    'refine.off':
      'RSI（经验复盘）在本会话中未生效。请先在设置中开启；开启后对之后新开的会话生效，请新开一个会话。',
    'refine.workspace':
      '已排队一次经验复盘（{id}）。留下的经验也会作为你自己的保存存到这个工作区；每次保存都会显示在时间线里。',
    'refine.user':
      '已排队一次经验复盘（{id}）。留下的经验也会作为你自己的保存存到用户记忆（所有工作区都会读取）；每次保存都会显示在时间线里。',
    'refine.both': '--workspace 和 --user 只能选一个。',
    'refine.unpriced':
      '规划模型没有已知价格，这次复盘的费用未知，也没有价格为它设限（token 预算仍然有效）。如仍要运行，请用 /refine --unpriced [关注点] 再请求一次。',
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
    'usage.rows.rsiUnknown': '价格未知',
  },
}
