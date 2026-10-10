import type { LocaleCatalog } from '@agnes/web-client'

/** `index.ts` 工作区入口（工具栏按钮、双线对比注册项）的文案。 */
export const entryLocaleCatalog: LocaleCatalog = {
  en: {
    'entry.target.title': 'Two-runtime comparison {id}',
    'entry.target.label': 'Comparison · Native + JevLoop',
    'entry.target.hint':
      'Continue sending to the current comparison; workspace and models are frozen. Open the comparison to inspect results, handle approvals, or stop.',
    'entry.target.model': 'Comparison models frozen',
    'entry.target.workspace': 'Isolated comparison workspaces',
    'entry.open': 'Comparison',
    'entry.configure': 'Configure Jev',
    'entry.mode.unavailable': 'Requires both Native and JevLoop to be available',
    'entry.mode.hint':
      'Both lanes run the same model and default preset in isolated copies; the JevLoop lane can bind per-stage models under “Thinking · Stages”; approvals are handled per lane.',
    'entry.mode.permission':
      'Both lanes will use “{mode}” for the next turn; comparison catalogs stay isolated.',
  },
  'zh-CN': {
    'entry.target.title': '双线对比 {id}',
    'entry.target.label': '双线对比 · Native + JevLoop',
    'entry.target.hint':
      '继续发送给当前双线；工作区与模型已冻结。打开双线对比可查看结果、审批或停止。',
    'entry.target.model': '对比模型已冻结',
    'entry.target.workspace': '双线隔离工作区',
    'entry.open': '双线对比',
    'entry.configure': '配置 Jev',
    'entry.mode.unavailable': '需要 Native 与 JevLoop 均可用',
    'entry.mode.hint':
      '双线使用相同模型与默认预设，在隔离副本中运行；JevLoop 侧可在“思考 · 环节”分环节指定模型；审批分别处理。',
    'entry.mode.permission': '双侧下一轮将使用「{mode}」，对比目录保持隔离。',
  },
}
