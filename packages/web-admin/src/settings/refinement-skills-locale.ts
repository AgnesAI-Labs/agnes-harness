import type { LocaleCatalog } from '@agnes/web-ui'

export const SAVED_SKILLS_NAMESPACE = '@agnes/web-admin/refinement-skills'

export const savedSkillsCatalog: LocaleCatalog = {
  en: {
    'skills.title': 'Saved skills',
    'skills.help':
      'Skills task experience installed in this workspace. A skill nobody confirms again is switched off after 30 days and waits for your review: switch it back on from the Skills page to keep it for another 30 days. Uninstalling or rolling back is remembered: automatic and model saves never bring that skill back; only your own save does.',
    'skills.workspace': 'Workspace',
    'skills.none': 'No skills have been saved in this workspace.',
    'skills.active': 'On, review due {date}.',
    'skills.review-disabled': 'Awaiting review: switched off by the 30-day review on {date}.',
    'skills.capacity':
      'Turned off: workspace limit of 20 skills in use; the one confirmed longest ago goes first. Switch it back on from the Skills page to keep it.',
    'skills.saved': 'Saved experience: {total} (workspace {workspace}, user {user}).',
    'skills.memoryOff':
      'Workspace memory is off for this workspace: lessons stay in the session they were learned in and are not saved for later sessions. Turn it on in Settings → General → Personalization → Memory: "Ask me first" asks you to approve each save, "Automatic" saves without asking.',
    'skills.by': 'Saved {who}.',
    'skills.initiator.auto': 'automatically',
    'skills.initiator.user': 'by you',
    'skills.initiator.model': 'by the model',
    'skills.workflow': 'Made from a finished workflow run; the skill carries its definition.',
    'skills.rollback': 'Roll back to the previous version',
    'skills.uninstall': 'Uninstall',
    'skills.drafts': 'Drafts kept for you',
    'skills.drafts.help':
      'Changes task experience wanted to make to a skill you wrote or changed. They are never written; copy what you want by hand.',
    'skills.draft.human-written': 'You wrote this skill.',
    'skills.draft.changed-since': 'You changed it after it was saved.',
    'skills.failed': 'The saved skills could not be read or changed. Try again.',
  },
  'zh-CN': {
    'skills.title': '保存的技能',
    'skills.help':
      '任务经验安装到这个工作区的技能。30 天内没有被再次证实的技能会被停用，等你复核：在技能页重新启用即可再保留 30 天。卸载或回滚会被记住：自动保存和模型保存都不会再把它装回来，只有你自己的保存可以。',
    'skills.workspace': '工作区',
    'skills.none': '这个工作区还没有保存的技能。',
    'skills.active': '已启用，{date} 复核。',
    'skills.review-disabled': '待复核：已在 {date} 被 30 天复核停用。',
    'skills.capacity':
      '因数量上限停用：这个工作区最多启用 20 个，最久没被证实的先停。在技能页重新启用即可保留。',
    'skills.saved': '已存经验 {total} 条（工作区 {workspace}，用户 {user}）。',
    'skills.memoryOff':
      '这个工作区的记忆是「关闭」：经验只在学到它的会话里有效，不会保存给之后的会话。请到 设置 → 通用 → 个性化 → 记忆 开启：选「先问我」，每次保存都要你批准；选「自动」，自动保存。',
    'skills.by': '保存方式：{who}。',
    'skills.initiator.auto': '自动保存',
    'skills.initiator.user': '你保存的',
    'skills.initiator.model': '模型保存的',
    'skills.workflow': '由一次跑完的工作流生成；技能里带着它的定义。',
    'skills.rollback': '回滚到上一版',
    'skills.uninstall': '卸载',
    'skills.drafts': '留给你的草稿',
    'skills.drafts.help':
      '任务经验想对你写的或改过的技能做的修改。这些修改不会被写入；需要的部分请手动复制。',
    'skills.draft.human-written': '这是你写的技能。',
    'skills.draft.changed-since': '保存之后你改过它。',
    'skills.failed': '无法读取或修改保存的技能，请重试。',
  },
}
