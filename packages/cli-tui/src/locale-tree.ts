import type { Locale } from './locale.js'

/** Strings of /tree: kept beside the other locale files so locale-extended.ts stays small. */
export type TreeKey =
  | 'commands.tree'
  | 'commands.treeSummary'
  | 'picker.treeTitle'
  | 'tree.none'
  | 'tree.untitled'
  | 'tree.forkTurn'
  | 'tree.forkSeq'

export const TREE_DICT: Record<Locale, Record<TreeKey, string>> = {
  en: {
    'commands.tree': "Browse this workspace's sessions as a tree of forks and resume one",
    'commands.treeSummary': 'Browse forks as a tree',
    'picker.treeTitle': 'Session Tree',
    'tree.none': 'no sessions in this workspace',
    'tree.untitled': 'untitled',
    'tree.forkTurn': 'fork of turn {turn}',
    'tree.forkSeq': 'fork @{seq}',
  },
  'zh-CN': {
    'commands.tree': '把当前工作区的会话按分叉关系显示成树，并恢复其中一个',
    'commands.treeSummary': '以树形浏览分叉会话',
    'picker.treeTitle': '会话树',
    'tree.none': '当前工作区没有会话',
    'tree.untitled': '未命名',
    'tree.forkTurn': '分叉自第 {turn} 回合',
    'tree.forkSeq': '分叉 @{seq}',
  },
}
