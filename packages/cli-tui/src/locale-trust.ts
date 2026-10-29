import type { Locale } from './locale.js'

/** Strings of `/trust`, merged into the key dictionary by locale-keys.ts so locale-extended.ts does not grow. */
export type TrustKey =
  | 'commands.trust'
  | 'commands.trustSummary'
  | 'trust.usage'
  | 'trust.unavailable'
  | 'trust.none'
  | 'trust.workspace'
  | 'trust.state'
  | 'trust.state.untrusted'
  | 'trust.state.trusted'
  | 'trust.state.changed'
  | 'trust.plugins'
  | 'trust.hooks'
  | 'trust.hooksUnreadable'
  | 'trust.hooksMore'
  | 'trust.noRoot'
  | 'trust.pluginsMismatch'
  | 'trust.pluginsFailed'
  | 'trust.changedDuring'
  | 'trust.elsewhere'
  | 'trust.noHash'
  | 'trust.hint'
  | 'trust.noPending'
  | 'trust.alreadyTrusted'
  | 'trust.stale'
  | 'trust.done'
  | 'trust.doneHooks'
  | 'trust.donePlugins'

export const TRUST_DICT: Record<Locale, Record<TrustKey, string>> = {
  en: {
    'commands.trust':
      'Review the hooks and local plugins of this workspace and their trust state; /trust confirm trusts exactly what was shown',
    'commands.trustSummary': 'Review workspace trust',
    'trust.usage': 'usage: /trust [confirm]',
    'trust.unavailable': 'Trust review is unavailable on this connection.',
    'trust.none': 'This workspace has no hooks or local plugins that need trust.',
    'trust.workspace': 'Workspace',
    'trust.state': 'State',
    'trust.state.untrusted': 'not trusted',
    'trust.state.trusted': 'trusted',
    'trust.state.changed': 'changed since it was trusted, trust again',
    'trust.plugins': 'Local plugins',
    'trust.hooks': 'Hooks',
    'trust.hooksUnreadable': 'The hooks content could not be read.',
    'trust.hooksMore': '{n} more hooks are not shown.',
    'trust.noRoot':
      "The daemon did not report this session's workspace root, so its trust cannot be reviewed.",
    'trust.pluginsMismatch': 'The plugin list does not match the count, so it cannot be shown in full.',
    'trust.pluginsFailed': 'The plugin list could not be read.',
    'trust.changedDuring': 'What was shown does not match what the daemon will trust. Run /trust again.',
    'trust.elsewhere':
      'Not offering /trust confirm because not everything could be shown. Review it yourself and trust it in the Web settings (Runtime details > Local plugins) or with: agh profile trust {dir}',
    'trust.noHash': 'The daemon gave no hash to check.',
    'trust.hint':
      'To trust it: /trust confirm. After that these hooks and plugins run with your user rights.',
    'trust.noPending': 'Nothing is waiting for confirmation. Run /trust to review first.',
    'trust.alreadyTrusted': 'Already trusted; nothing to confirm.',
    'trust.stale': 'The workspace changed since it was shown. Run /trust to review it again.',
    'trust.done': 'Trusted {path}.',
    'trust.doneHooks':
      'Hooks take effect in this session from the next hook run, because trust is checked each time.',
    'trust.donePlugins':
      'Local plugins load in new sessions; sessions that are already open keep what they loaded. If they do not appear, rescan local plugins in the Web settings (Runtime details > Local plugins).',
  },
  'zh-CN': {
    'commands.trust': '查看本工作区的 hooks 和本地插件及其信任状态；/trust confirm 只信任刚才显示的内容',
    'commands.trustSummary': '查看并确认工作区信任',
    'trust.usage': '用法：/trust [confirm]',
    'trust.unavailable': '这个连接不能查看信任状态。',
    'trust.none': '这个工作区没有需要信任的 hooks 或本地插件。',
    'trust.workspace': '工作区',
    'trust.state': '状态',
    'trust.state.untrusted': '未信任',
    'trust.state.trusted': '已信任',
    'trust.state.changed': '已变更，需要重新信任',
    'trust.plugins': '本地插件',
    'trust.hooks': 'Hooks',
    'trust.hooksUnreadable': 'hooks 内容读取失败。',
    'trust.hooksMore': '还有 {n} 条 hook 没有显示。',
    'trust.noRoot': 'daemon 没有报告本会话的工作区根目录，无法查看信任状态。',
    'trust.pluginsMismatch': '插件清单与数量对不上，无法完整显示。',
    'trust.pluginsFailed': '读不到插件清单。',
    'trust.changedDuring': '显示的内容与 daemon 将要信任的内容对不上，请重新运行 /trust。',
    'trust.elsewhere':
      '因为没能完整显示，不提供 /trust confirm。请自行核对后到 Web 设置（运行时详情 > 本地插件）确认，或运行：agh profile trust {dir}',
    'trust.noHash': 'daemon 没有给出用于核对的摘要。',
    'trust.hint': '确认信任：/trust confirm。信任后这些 hooks 和插件会以你的权限运行。',
    'trust.noPending': '没有等待确认的内容，请先运行 /trust 查看。',
    'trust.alreadyTrusted': '已经是已信任，无需确认。',
    'trust.stale': '工作区内容变了，请重新运行 /trust 查看。',
    'trust.done': '已信任 {path}。',
    'trust.doneHooks': 'hooks 在本会话里从下一次 hook 运行起生效，因为每次运行前都会检查信任。',
    'trust.donePlugins':
      '本地插件只在新会话里加载，已打开的会话保持原样。如果没出现，请到 Web 设置（运行时详情 > 本地插件）重新扫描本地插件。',
  },
}
