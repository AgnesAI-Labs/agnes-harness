import type { Locale } from './locale.js'

/** Strings of --worktree and /worktree: a locale file of their own so locale-extended.ts stays small. */
export type WorktreeKey =
  | 'commands.worktree'
  | 'commands.worktreeSummary'
  | 'worktree.started'
  | 'worktree.unignored'
  | 'worktree.untrusted'
  | 'worktree.removed'
  | 'worktree.kept'
  | 'worktree.remote'
  | 'worktree.badName'
  | 'worktree.notRepo'
  | 'worktree.exists'
  | 'worktree.gitFailed'
  | 'worktree.badParent'

export const WORKTREE_DICT: Record<Locale, Record<WorktreeKey, string>> = {
  en: {
    'commands.worktree':
      'Create a git worktree on a new agh/<name> branch and continue in a new session there (this machine only)',
    'commands.worktreeSummary': 'Session in a git worktree',
    'worktree.started': 'Worktree {name} on branch {branch}: {path}',
    'worktree.unignored':
      '.worktrees/ is not in .gitignore: add it so the worktree is not committed by accident.',
    'worktree.untrusted':
      'This new workspace is not trusted: the repo .agh/hooks.json and local plugins do not load here. Confirm trust separately in the Web workbench: Settings > Runtime details > Local plugins.',
    'worktree.removed': 'Worktree {name} had no changes and was removed; branch {branch} is kept.',
    'worktree.kept': 'Worktree {name} has changes and is kept: {path} (branch {branch})',
    'worktree.remote': 'worktrees can only be created on this machine',
    'worktree.badName': 'worktree name must match [a-z0-9-]{1,32}',
    'worktree.notRepo': 'worktrees need a git repository: {cwd} is not inside one',
    'worktree.exists':
      'worktree {name} already exists (branch {branch} or directory {path}); pick another name',
    'worktree.gitFailed': 'git worktree add failed: {detail}',
    'worktree.badParent': '{path} is a symlink or not a directory; refusing to create a worktree through it',
  },
  'zh-CN': {
    'commands.worktree': '在新分支 agh/<名字> 上创建 git worktree，并在其中新开会话（仅限本机）',
    'commands.worktreeSummary': 'worktree 里开会话',
    'worktree.started': 'Worktree {name}，分支 {branch}：{path}',
    'worktree.unignored': '.worktrees/ 不在 .gitignore 里：请加进去，避免误提交 worktree。',
    'worktree.untrusted':
      '这个新工作区未受信任：仓库的 .agh/hooks.json 和本地插件在这里不会加载。请到 Web 工作台单独确认信任：设置 > 运行时详情 > 本地插件。',
    'worktree.removed': 'Worktree {name} 没有改动，已删除；分支 {branch} 保留。',
    'worktree.kept': 'Worktree {name} 有改动，已保留：{path}（分支 {branch}）',
    'worktree.remote': 'worktree 只能在本机创建',
    'worktree.badName': 'worktree 名字只能是 [a-z0-9-]{1,32}',
    'worktree.notRepo': 'worktree 需要 git 仓库：{cwd} 不在仓库里',
    'worktree.exists': 'worktree {name} 已存在（分支 {branch} 或目录 {path}）；请换个名字',
    'worktree.gitFailed': 'git worktree add 失败：{detail}',
    'worktree.badParent': '{path} 是符号链接或不是目录；拒绝通过它创建 worktree',
  },
}
