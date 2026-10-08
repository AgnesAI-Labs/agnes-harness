import type { LocaleCatalog } from '@agnes/web-ui'
export const promptCatalog: LocaleCatalog = {
  en: {
    help: 'Changes apply to new sessions. Existing sessions keep their prompt configuration.',
    custom: 'Customize the persona',
    prefix: 'Opening instructions',
    suffix: 'Closing instructions',
    style: 'Reply style',
    advanced: 'Advanced: replace the default prompt',
    warning:
      'A full override replaces plugin instructions and may reduce reliability. Safety boundaries remain in place.',
    conflict:
      'Full replacement conflicts with opening, closing and reply-style instructions. Clear those fields before saving.',
    override: 'Full replacement',
    confirm: 'I understand and want to replace the default prompt.',
    save: 'Save for new sessions',
    reset: 'Reset to bundle defaults',
    preview: 'Current config preview',
    session: 'This session’s actual version',
    lastRequest:
      'From the latest retained logical request. Final provider bodies and dynamic message context are in Trace.',
    initial:
      'Assembled preview using this session’s pinned configuration. No actual request capture is retained.',
    sources:
      'Sections supplied by the selected prompt plugin. Session context and adapter instructions appear in the actual request trace.',
    loading: 'Loading…',
    failed: 'Unable to read or save the prompt. Check access and try again.',
    saved: 'Saved. Create a new session to use these instructions.',
    empty: 'No custom instructions.',
  },
  'zh-CN': {
    help: '修改仅应用于新会话。已有会话保留创建时的提示词配置。',
    custom: '自定义角色',
    prefix: '开场指令',
    suffix: '结尾指令',
    style: '回复风格',
    advanced: '高级：替换默认提示词',
    warning: '完整替换会覆盖插件提供的指令，可能降低可靠性。安全边界仍然保留。',
    conflict: '完整替换与开场、结尾、回复风格指令冲突。保存前请清空这些字段。',
    override: '完整替换内容',
    confirm: '我已理解，并确认替换默认提示词。',
    save: '保存供新会话使用',
    reset: '恢复 Bundle 默认值',
    preview: '当前配置预览',
    session: '此会话实际版本',
    lastRequest: '来自最近保留的逻辑请求。最终发送正文与动态消息上下文请在轨迹中查看。',
    initial: '使用此会话固定配置组合的预览。当前无保留的实际请求采集。',
    sources: '由选定的提示词插件提供。会话上下文和适配器指令可在实际请求轨迹中查看。',
    loading: '加载中…',
    failed: '无法读取或保存提示词，请检查权限后重试。',
    saved: '已保存。创建新会话即可使用这些指令。',
    empty: '暂无自定义指令。',
  },
}
