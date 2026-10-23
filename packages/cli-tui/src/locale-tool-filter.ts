import type { Locale } from './locale.js'

/** Strings of /tools, merged by locale-terminal.ts so locale-extended.ts stays under the source-size limit. */
export type ToolFilterKey =
  | 'commands.tools'
  | 'commands.toolsSummary'
  | 'tools.usage'
  | 'tools.header'
  | 'tools.none'
  | 'tools.on'
  | 'tools.off'
  | 'tools.reasonSessionDeny'
  | 'tools.reasonSessionAllow'
  | 'tools.reasonOther'
  | 'tools.confirmDeny'
  | 'tools.confirmOnly'
  | 'tools.noPending'
  | 'tools.cancelled'
  | 'tools.applied'
  | 'tools.unknown'
  | 'tools.nothing'
  | 'tools.unsupported'
  | 'tools.ownerOnly'

export const TOOL_FILTER_DICT: Record<Locale, Record<ToolFilterKey, string>> = {
  en: {
    'commands.tools':
      "List this session's tools, or narrow them: /tools deny <names> turns tools off, /tools only <names> leaves just those on. Narrowing cannot be undone in the session",
    'commands.toolsSummary': 'List or narrow tools',
    'tools.usage': 'usage: /tools [deny <names…> | only <names…> | confirm | cancel]',
    'tools.header': 'Tools: {on} on, {off} off',
    'tools.none': 'This session has no tools',
    'tools.on': 'on',
    'tools.off': 'off',
    'tools.reasonSessionDeny': 'turned off for this session',
    'tools.reasonSessionAllow': 'not on this session’s allow list',
    'tools.reasonOther': 'turned off by {layer} {name} ({rule})',
    'tools.confirmDeny':
      'This turns off {names} for the rest of this session and cannot be undone here. /tools confirm to apply, /tools cancel to drop it.',
    'tools.confirmOnly':
      'This leaves only {names} on for the rest of this session and cannot be undone here. /tools confirm to apply, /tools cancel to drop it.',
    'tools.noPending': 'There is no tool change waiting to be confirmed',
    'tools.cancelled': 'Tool change dropped',
    'tools.applied': 'Tools narrowed from seq {seq}: {on} on, {off} off',
    'tools.unknown': 'No such tool: {names}. /tools lists the names this session has',
    'tools.nothing': 'Nothing to change: name at least one tool',
    'tools.unsupported':
      'This daemon cannot limit a session’s tools (it has no session.setToolFilter); nothing changed',
    'tools.ownerOnly': 'Only the session owner can change its tools',
  },
  'zh-CN': {
    'commands.tools':
      '列出本会话的工具，或收紧它们：/tools deny <名称> 关掉工具，/tools only <名称> 只留这些。收紧后在本会话内无法撤销',
    'commands.toolsSummary': '列出或收紧工具',
    'tools.usage': '用法：/tools [deny <名称…> | only <名称…> | confirm | cancel]',
    'tools.header': '工具：{on} 个开启，{off} 个关闭',
    'tools.none': '本会话没有工具',
    'tools.on': '开',
    'tools.off': '关',
    'tools.reasonSessionDeny': '已在本会话内关闭',
    'tools.reasonSessionAllow': '不在本会话的允许列表内',
    'tools.reasonOther': '被 {layer} {name} 关闭（{rule}）',
    'tools.confirmDeny':
      '这会在本会话余下的时间里关掉 {names}，且在这里无法撤销。/tools confirm 执行，/tools cancel 放弃。',
    'tools.confirmOnly':
      '这会在本会话余下的时间里只留下 {names}，且在这里无法撤销。/tools confirm 执行，/tools cancel 放弃。',
    'tools.noPending': '没有等待确认的工具改动',
    'tools.cancelled': '已放弃这次工具改动',
    'tools.applied': '工具已收紧，自 seq {seq} 起生效：{on} 个开启，{off} 个关闭',
    'tools.unknown': '没有这个工具：{names}。/tools 会列出本会话有的名称',
    'tools.nothing': '没有可改的内容：至少写出一个工具名',
    'tools.unsupported': '当前 daemon 不能限制会话的工具（没有 session.setToolFilter），未做任何改动',
    'tools.ownerOnly': '只有会话属主能改动它的工具',
  },
}
