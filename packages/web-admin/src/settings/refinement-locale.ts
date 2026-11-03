import type { LocaleCatalog } from '@agnes/web-ui'

export const REFINEMENT_SETTINGS_NAMESPACE = '@agnes/web-admin/refinement'

export const refinementSettingsCatalog: LocaleCatalog = {
  en: {
    'refinement.group.main': 'Task experience (RSI)',
    'refinement.enabled': 'Learn from finished work',
    'refinement.enabled.hint':
      'Off by default. When on, Agnes reviews your sessions in the background and keeps useful lessons as experience for later turns. Turning it on reaches the tools the next time the host starts, so restart to use it. Turning it off takes effect at once.',
    'refinement.mode': 'How reviews start',
    'refinement.mode.hint':
      'Manual: a review runs only when you ask with /refine. Automatic: reviews can also start by themselves, within spending limits.',
    'refinement.mode.manual': 'Manual only',
    'refinement.mode.auto': 'Manual and automatic',
    'refinement.restart': 'Saved. Restart Agnes for the experience tools to appear.',
    'refinement.group.allows': 'What turning it on allows',
    'refinement.later': 'Not available yet; arrives in a later release.',
    'refinement.allows.install': 'Install proven skills in the workspace',
    'refinement.allows.install.hint':
      'A skill that was confirmed twice and is plain instructions or a sandboxed script is installed in the workspace without the usual install confirmation.',
    'refinement.allows.skill': 'Let the model save skills in the workspace',
    'refinement.allows.skill.hint':
      'The model may save a skill straight to the workspace without waiting for a second confirmation, if it cites evidence from the session and passes the static checks.',
    'refinement.allows.memory': 'Let the model save memory in the workspace',
    'refinement.allows.memory.hint':
      'The model may also save memory in the workspace. The workspace memory setting (off, ask or auto) still decides what is written.',
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
  },
  'zh-CN': {
    'refinement.group.main': '任务经验（RSI）',
    'refinement.enabled': '从完成的工作中学习',
    'refinement.enabled.hint':
      '默认关闭。开启后，Agnes 会在后台复盘你的会话，把有用的经验留给之后的轮次。开启要等宿主下次启动才会让工具出现，所以需要重启；关闭则立即生效。',
    'refinement.mode': '复盘如何开始',
    'refinement.mode.hint': '手动：只有你用 /refine 提出时才复盘。自动：也会在费用限额内自行开始复盘。',
    'refinement.mode.manual': '仅手动',
    'refinement.mode.auto': '手动和自动',
    'refinement.restart': '已保存。重启 Agnes 后经验工具才会出现。',
    'refinement.group.allows': '开启即表示允许',
    'refinement.later': '暂未提供，将在后续版本开放。',
    'refinement.allows.install': '把已证实的技能安装到工作区',
    'refinement.allows.install.hint':
      '被证实 2 次、且只是纯指令或沙箱脚本的技能，会自动安装到工作区，省去那一次安装确认。',
    'refinement.allows.skill': '允许模型把技能存到工作区',
    'refinement.allows.skill.hint':
      '模型可以不等第二次证实，直接把技能存到工作区；前提是引用本会话的证据并通过静态检查。',
    'refinement.allows.memory': '允许模型把记忆存到工作区',
    'refinement.allows.memory.hint':
      '模型也可以把记忆存到工作区，写不写仍由工作区记忆设置（关闭 / 询问 / 自动）决定。',
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
  },
}
