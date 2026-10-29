/**
 * A session that cannot continue on this build is refused in one of three directions, each with its
 * own code, so a client can say what actually happened instead of a generic format failure.
 *
 * - `newer`: written by a newer AGH; upgrade AGH.
 * - `older`: created with an older AGH, or its pinned generation, provider, version or snapshot is
 *   no longer available; start a new session, or (administrators) switch it to the current version.
 * - `corrupt`: a real integrity failure; nothing is changed and the raw record is left in place.
 */
export type SessionVersionIssue = 'newer' | 'older' | 'corrupt'

export const SESSION_VERSION_CODES = Object.freeze({
  newer: 'E_SESSION_VERSION_NEWER',
  older: 'E_SESSION_VERSION_OLDER',
  corrupt: 'E_SESSION_CORRUPT',
} as const)
export type SessionVersionCode = (typeof SESSION_VERSION_CODES)[SessionVersionIssue]

/** What the person can do next. `repin` is an explicit, audited administrator action. */
export type SessionVersionAction = 'upgrade' | 'new-session' | 'repin'

export type SessionVersionFacts = Readonly<{
  sessionId: string
  /** Where the raw ledger lives, when the caller knows. */
  ledgerPath?: string
  /** What no longer matches, in plain words (build changed, provider gone, snapshot missing). */
  reason?: string
  /** True when an administrator can switch the session to the current version. */
  repinnable?: boolean
}>

export type SessionVersionNotice = Readonly<{
  code: SessionVersionCode
  issue: SessionVersionIssue
  actions: readonly SessionVersionAction[]
  message: Readonly<{ en: string; 'zh-CN': string }>
}>

const where = (facts: SessionVersionFacts, zh: boolean): string =>
  facts.ledgerPath
    ? zh
      ? `会话：${facts.sessionId}；原始账本：${facts.ledgerPath}。`
      : `Session: ${facts.sessionId}. Raw ledger: ${facts.ledgerPath}.`
    : zh
      ? `会话：${facts.sessionId}。`
      : `Session: ${facts.sessionId}.`

/** Bilingual, second-person text for one refusal. The same facts always produce the same words. */
export function sessionVersionNotice(
  issue: SessionVersionIssue,
  facts: SessionVersionFacts,
): SessionVersionNotice {
  const reasonEn = facts.reason ? ` (${facts.reason})` : ''
  const reasonZh = facts.reason ? `（${facts.reason}）` : ''
  if (issue === 'newer')
    return {
      code: SESSION_VERSION_CODES.newer,
      issue,
      actions: ['upgrade'],
      message: {
        en: `This session was written by a newer version of AGH${reasonEn}, so this version cannot continue it. Upgrade AGH to keep working in it. You can still read it. ${where(facts, false)} Nothing was changed.`,
        'zh-CN': `你的这个会话由更新版本的 AGH 写入${reasonZh}，当前版本无法继续它。请升级 AGH 后再继续；你仍然可以查看它。${where(facts, true)}没有任何内容被改动。`,
      },
    }
  if (issue === 'older')
    return {
      code: SESSION_VERSION_CODES.older,
      issue,
      actions: facts.repinnable ? ['new-session', 'repin'] : ['new-session'],
      message: {
        en: `This session was created with an older version of AGH${reasonEn} that is no longer available, so it cannot continue here. You can still read it, or start a new session.${facts.repinnable ? ' An administrator can switch this session to the current version; that is an explicit, recorded action.' : ''} ${where(facts, false)} Nothing was changed.`,
        'zh-CN': `你的这个会话是用较旧版本的 AGH 创建的${reasonZh}，该版本已不可用，所以无法在这里继续。你仍然可以查看它，也可以新开一个会话。${facts.repinnable ? '管理员可以把此会话切换到当前版本，这是一项明确且会被记录的操作。' : ''}${where(facts, true)}没有任何内容被改动。`,
      },
    }
  return {
    code: SESSION_VERSION_CODES.corrupt,
    issue,
    actions: ['new-session'],
    message: {
      en: `This session's record failed an integrity check${reasonEn}, so it was not opened. You can start a new session. ${where(facts, false)} Nothing was changed; keep the raw ledger for support.`,
      'zh-CN': `你的这个会话记录没有通过完整性检查${reasonZh}，所以没有打开。你可以新开一个会话。${where(facts, true)}没有任何内容被改动；请保留原始账本，方便排查。`,
    },
  }
}
