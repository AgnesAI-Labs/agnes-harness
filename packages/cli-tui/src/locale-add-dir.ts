import type { Locale } from './locale.js'

/** Strings of --add-dir: a locale file of their own so locale-terminal.ts and locale-extended.ts stay small. */
export type AddDirKey = 'adddir.started' | 'adddir.unsupported' | 'adddir.newOnly' | 'adddir.notDirectory'

export const ADD_DIR_DICT: Record<Locale, Record<AddDirKey, string>> = {
  en: {
    'adddir.started':
      'Extra directories for this session ({count}): {dirs}. They are data only: no hooks, plugins, skills, MCP config, memory or instruction files load from them.',
    'adddir.unsupported':
      'This daemon does not support --add-dir. Restart it from a newer build, or start without --add-dir.',
    'adddir.newOnly':
      '--add-dir only applies to a new session: it cannot be combined with --continue or --resume',
    'adddir.notDirectory': '--add-dir {dir}: not an existing directory',
  },
  'zh-CN': {
    'adddir.started':
      '本会话的额外目录（{count} 个）：{dirs}。它们只当数据：里面的钩子、插件、技能、MCP 配置、记忆和说明文件都不会加载。',
    'adddir.unsupported': '当前 daemon 不支持 --add-dir。请用更新的版本重启它，或不带 --add-dir 启动。',
    'adddir.newOnly': '--add-dir 只对新会话有效：不能和 --continue 或 --resume 一起用',
    'adddir.notDirectory': '--add-dir {dir}：不是已存在的目录',
  },
}
