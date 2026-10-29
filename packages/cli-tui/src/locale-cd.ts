import type { Locale } from './locale.js'

/** Strings of /cd, merged by locale-terminal.ts so locale-extended.ts stays under the source-size limit. */
export type CdKey =
  | 'commands.cd'
  | 'commands.cdSummary'
  | 'cd.usage'
  | 'cd.remote'
  | 'cd.notDir'
  | 'cd.same'
  | 'cd.switched'

export const CD_DICT: Record<Locale, Record<CdKey, string>> = {
  en: {
    'commands.cd':
      'Continue in another directory: registers it and opens a new session there (this machine only; the conversation does not follow, use /handoff for that)',
    'commands.cdSummary': 'New session in a dir',
    'cd.usage': 'Usage: /cd <dir> (~ and paths relative to the workspace work)',
    'cd.remote': '/cd only works on this machine: the directory is checked on the local disk',
    'cd.notDir': '{path} is not an existing directory',
    'cd.same': 'Already in {dir}',
    'cd.switched':
      'New session in {dir}. The previous session {old} stays: back with /resume {old}. A newly registered directory is its own workspace and trust is not copied: repo hooks and local plugins need separate confirmation.',
  },
  'zh-CN': {
    'commands.cd':
      '换到另一个目录继续：登记该目录并在其中新开会话（仅限本机；对话不会跟过去，需要上下文用 /handoff）',
    'commands.cdSummary': '在另一个目录新开会话',
    'cd.usage': '用法：/cd <目录>（支持 ~，相对路径按当前工作区解析）',
    'cd.remote': '/cd 只能在本机使用：目录要在本机磁盘上检查',
    'cd.notDir': '{path} 不是已存在的目录',
    'cd.same': '已在 {dir}',
    'cd.switched':
      '新会话在 {dir}。原会话 {old} 保留，可用 /resume {old} 回去。新登记的目录是独立的工作区，信任不会复制：仓库的 hooks 和本地插件要单独确认。',
  },
}
