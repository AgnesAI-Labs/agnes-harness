import type { LocaleCatalog } from '@agnes/web-ui'

export const REFINEMENT_SETTINGS_NAMESPACE = '@agnes/web-admin/refinement'

export const refinementSettingsCatalog: LocaleCatalog = {
  en: {
    'refinement.group.main': 'Task experience (RSI)',
    'refinement.enabled': 'Learn from finished work',
    'refinement.enabled.hint':
      'Off by default. When on, you or the model can request a background review and keep useful lessons for later turns. When off, reviews and the experience tools are unavailable.',
    'refinement.enabled.info':
      'Applies to sessions opened after you turn it on; sessions already open are not affected. Turning it off applies to all sessions at once. To keep lessons for later sessions, also turn workspace memory on (Settings → General → Personalization → Memory: "Ask me first" or "Automatic"); while it is off, lessons last only for the session they were learned in.',
    'refinement.mode': 'How reviews start',
    'refinement.mode.hint':
      'On demand: use /refine, or let the model request a review for this session. With automatic triggers: the system also considers reviews after a successful summary compaction or repeated tool failures, subject to budget, cooldown and frequency limits. The model needs automatic triggers enabled to save lessons beyond this session; memory settings still apply.',
    'refinement.mode.manual': 'On demand',
    'refinement.mode.auto': 'On demand + automatic triggers',
    'refinement.group.allows': 'What turning it on allows',
    'refinement.allows.install': 'Install proven skills in the workspace',
    'refinement.allows.install.hint':
      'A skill lesson that passes the checks is installed in the workspace, trusted and switched on, without the usual install confirmation. Saved skills are instructions only: when a script would help, the skill tells the agent to write it with its own file tools, under its usual permissions. A saved skill nobody confirms again is switched off after 30 days and waits for your review.',
    'refinement.allows.skill': 'Let the model save skills in the workspace',
    'refinement.allows.skill.hint':
      'The model may save a skill straight to the workspace without waiting for a second confirmation, if it cites evidence from the session and passes the static checks. A skill you wrote or changed is never overwritten: the change is kept as a draft for you. You can uninstall a saved skill or roll it back to its earlier version below.',
    'refinement.allows.memory': 'Let the model save memory in the workspace',
    'refinement.allows.memory.hint':
      'Lessons a review wrote, your own saves (/refine --workspace, or Save to workspace on a review) and the model’s saves go into workspace memory, each with a review date 30 days on. The workspace memory setting (off, ask or auto) still decides what is written; under ask each save waits in Needs attention. When workspace memory is full nothing is merged: the save stops and you free space.',
    'refinement.allows.user': 'Write lessons that hold everywhere to user memory',
    'refinement.allows.user.hint':
      'A lesson that holds in every workspace (a preference you stated yourself, naming no project and no full path) is written automatically to user memory, without asking. User memory is read only in workspaces that turn it on. Saved lessons reach the model with task experience, so they take no room from what you wrote yourself; only when the user memory file is full is a lesson not written, and nothing is trimmed. You can also save one yourself with /refine --user, and the model may when refinement is automatic. Withdraw a lesson in the memory settings (Memory files) and it is not written again.',
    'refinement.allows.undo': 'Nothing is brought back',
    'refinement.allows.undo.hint':
      'None of these restores something you uninstalled, rolled back or deleted.',
    'refinement.group.notes': 'Good to know',
    'refinement.approvals': 'More command approvals',
    'refinement.approvals.hint':
      'A learned note reaches the model as untrusted text, so a turn that carries one may ask you to approve more commands.',
    'refinement.cost': 'Cost',
    'refinement.cost.hint':
      'A review is a background model call on your account. The terminal lists its cost on its own “RSI cost” line in the usage details; the web counts it in the session’s usage totals.',
    'refinement.conflict':
      'The experience settings were changed somewhere else. They are shown again as they are now; make your change again.',
    'refinement.notice':
      'New in this release: with task experience on, lessons are now also saved to the workspace memory and as workspace skills without asking again here. The workspace memory setting still applies, and under ask each save still waits for you. Lessons that hold in every workspace are written to user memory, automatically. To stop it, turn off “Learn from finished work” above.',
    'refinement.notice.dismiss': 'Dismiss this notice',
  },
  'zh-CN': {
    'refinement.group.main': '任务经验（RSI）',
    'refinement.enabled': '从完成的工作中学习',
    'refinement.enabled.hint':
      '默认关闭。开启后，你或模型可以发起后台复盘，把有用的经验留给之后的轮次；关闭后不再复盘，也不提供经验工具。',
    'refinement.enabled.info':
      '打开后，之后新开的会话生效；已经打开的会话不受影响。关闭立即对所有会话生效。要把经验留给之后的会话，还需打开工作区记忆（设置 → 通用 → 个性化 → 记忆：「先问我」或「自动」）；记忆为「关闭」时，经验只在学到它的会话里有效。',
    'refinement.mode': '复盘如何开始',
    'refinement.mode.hint':
      '按需：你用 /refine，或由模型主动发起当前会话的复盘。开启自动触发后：系统还会在摘要压缩成功、同类工具错误重复出现时尝试复盘，受预算、冷却时间和次数限制。模型主动把经验保存到工作区或用户记忆，需要开启自动触发；记忆设置仍然有效。',
    'refinement.mode.manual': '按需复盘',
    'refinement.mode.auto': '按需＋自动触发',
    'refinement.group.allows': '开启即表示允许',
    'refinement.allows.install': '把已证实的技能安装到工作区',
    'refinement.allows.install.hint':
      '通过检查的技能经验会自动安装到工作区，并设为受信与启用，省去那一次安装确认。保存的技能是纯指令：需要脚本时，技能正文会让智能体用自己的文件工具、按它原有的权限去写。30 天内没有被再次证实的技能会被停用，等你复核。',
    'refinement.allows.skill': '允许模型把技能存到工作区',
    'refinement.allows.skill.hint':
      '模型可以不等第二次证实，直接把技能存到工作区；前提是引用本会话的证据并通过静态检查。你写的或改过的技能永远不会被覆盖：改动只作为草稿留给你。你可以在下面卸载保存的技能，或回滚到上一版。',
    'refinement.allows.memory': '允许模型把记忆存到工作区',
    'refinement.allows.memory.hint':
      '复盘写下的经验、你自己的保存（/refine --workspace 或复盘记录上的“保存到工作区”）以及模型的保存，会写进工作区记忆，每段带一个 30 天后的复核日期。写不写仍由工作区记忆设置（关闭 / 询问 / 自动）决定；询问模式下每次保存都在“待处理”里等你确认。工作区记忆写满时不会自动合并：保存会停止，需要你腾出空间。',
    'refinement.allows.user': '把处处适用的经验写入用户记忆',
    'refinement.allows.user.hint':
      '适用于所有工作区的经验（你自己说过的偏好，不提具体项目，也不含完整路径）会自动写入用户记忆，不再询问。用户记忆只在开启了它的工作区里被读取。存下的经验随任务经验交给模型，不占你自己写的内容的位置；只有用户记忆文件写满时才不写入，也不会截断任何内容。你也可以用 /refine --user 自己保存，自动模式下模型也可以。在记忆设置（记忆文件）中撤回某条经验后，它不会再被写入。',
    'refinement.allows.undo': '不会恢复已删除的内容',
    'refinement.allows.undo.hint': '以上几条都不会恢复你已卸载、回滚或删除的内容。',
    'refinement.group.notes': '需要知道',
    'refinement.approvals': '可能出现更多命令审批',
    'refinement.approvals.hint':
      '学到的经验会作为不受信任的文字交给模型，所以带着经验的那一轮可能会要求你批准更多命令。',
    'refinement.cost': '费用',
    'refinement.cost.hint':
      '复盘是记在你账户上的一次后台模型调用。终端会在用量详情里单列“RSI 费用”一行；网页里它计入会话的用量合计。',
    'refinement.conflict': '经验设置在别处被修改了。现在显示的是最新状态，请重新做一次你的修改。',
    'refinement.notice':
      '本版本新增：开启任务经验后，经验现在也会保存到工作区记忆和工作区技能，这里不会再次询问。工作区记忆设置仍然有效，询问模式下每次保存仍会等你确认。适用于所有工作区的经验会自动写入用户记忆。要停止，请关闭上面的“从完成的工作中学习”。',
    'refinement.notice.dismiss': '关闭此说明',
  },
}
