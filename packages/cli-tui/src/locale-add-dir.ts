import type { Locale } from './locale.js'

/** Strings of --add-dir: a locale file of their own so locale-terminal.ts and locale-extended.ts stay small. */
export type AddDirKey =
  | 'adddir.started'
  | 'adddir.unsupported'
  | 'adddir.newOnly'
  | 'adddir.notDirectory'
  | 'commands.addDir'
  | 'commands.addDirSummary'
  | 'adddir.usage'
  | 'adddir.remote'
  | 'adddir.noTurn'
  | 'adddir.forked'

export const ADD_DIR_DICT: Record<Locale, Record<AddDirKey, string>> = {
  en: {
    'adddir.started':
      'Extra directories for this session ({count}): {dirs}. They are data only: no hooks, plugins, skills, MCP config, memory or instruction files load from them.',
    'adddir.unsupported':
      'This daemon does not support --add-dir. Restart it from a newer build, or start without --add-dir.',
    'adddir.newOnly':
      '--add-dir only applies to a new session: it cannot be combined with --continue or --resume',
    'adddir.notDirectory': '--add-dir {dir}: not an existing directory',
    'commands.addDir':
      'Let the session reach another directory: registers it and forks this session into a new one that has it (this machine only)',
    'commands.addDirSummary': 'Add a dir (forks session)',
    'adddir.usage': 'Usage: /add-dir <dir> (~ and paths relative to the workspace work)',
    'adddir.remote': '/add-dir only works on this machine: the directory is checked on the local disk',
    'adddir.noTurn':
      'Nothing to fork yet: send a message first, or start a new session with `agh --add-dir`.',
    'adddir.forked':
      'New session {id} can also use {dir}. The previous session {old} stays unchanged: back with /resume {old}. The directory is data only: no hooks, plugins, skills, MCP config, memory or instruction files load from it.',
  },
  'zh-CN': {
    'adddir.started':
      '本会话的额外目录（{count} 个）：{dirs}。它们只当数据：里面的钩子、插件、技能、MCP 配置、记忆和说明文件都不会加载。',
    'adddir.unsupported': '当前 daemon 不支持 --add-dir。请用更新的版本重启它，或不带 --add-dir 启动。',
    'adddir.newOnly': '--add-dir 只对新会话有效：不能和 --continue 或 --resume 一起用',
    'adddir.notDirectory': '--add-dir {dir}：不是已存在的目录',
    'commands.addDir': '让会话能访问另一个目录：登记该目录，并把当前会话分叉成带上它的新会话（仅限本机）',
    'commands.addDirSummary': '添加目录（分叉会话）',
    'adddir.usage': '用法：/add-dir <目录>（支持 ~，相对路径按当前工作区解析）',
    'adddir.remote': '/add-dir 只能在本机使用：目录要在本机磁盘上检查',
    'adddir.noTurn': '还没有可分叉的内容：先发一条消息，或用 `agh --add-dir` 新开会话。',
    'adddir.forked':
      '新会话 {id} 还可以使用 {dir}。原会话 {old} 保持不变，可用 /resume {old} 回去。该目录只当数据：里面的钩子、插件、技能、MCP 配置、记忆和说明文件都不会加载。',
  },
}
