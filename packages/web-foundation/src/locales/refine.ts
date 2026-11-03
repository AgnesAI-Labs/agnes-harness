/** Strings of the composer's /refine command. */
export const refineLocaleCatalog = {
  en: {
    'app.refine.off':
      'Experience refinement (RSI) is not active. Turn it on in Settings; if you just did, restart to apply it.',
    'app.refine.workspace':
      'Saving to the workspace is not available yet. /refine [focus] keeps the lessons for this session.',
    'app.refine.tooLong': 'The focus is too long: 512 characters at most.',
    'app.refine.noSession': 'Open a conversation first, then run /refine.',
    'app.refine.queued':
      'Experience review queued ({id}). It plans in the background; the result shows in the conversation.',
    'app.refine.unsupported': 'This daemon does not support /refine.',
    'app.refine.refused': 'Experience review was not started: {reason}.',
    'app.refine.reason.child-session': 'a forked or child session does not plan experience',
    'app.refine.reason.closing': 'the session is closing',
    'app.refine.reason.invalid': 'the request was not valid',
    'app.refine.reason.unpriced': 'the planning model has no known price',
  },
  'zh-CN': {
    'app.refine.off': 'RSI（经验复盘）尚未生效。请先在设置中开启；如果刚刚开启，请重启后生效。',
    'app.refine.workspace': '保存到工作区暂未提供。/refine [关注点] 会把经验留在本会话里。',
    'app.refine.tooLong': '关注点太长：最多 512 个字符。',
    'app.refine.noSession': '请先打开一个对话，再使用 /refine。',
    'app.refine.queued': '已排队一次经验复盘（{id}）。它在后台规划，结果会显示在对话里。',
    'app.refine.unsupported': '当前的守护进程不支持 /refine。',
    'app.refine.refused': '经验复盘没有开始：{reason}。',
    'app.refine.reason.child-session': '分叉出的子会话不做经验规划',
    'app.refine.reason.closing': '会话正在关闭',
    'app.refine.reason.invalid': '请求无效',
    'app.refine.reason.unpriced': '规划模型没有已知价格',
  },
} as const
