/** Friendly display labels; the recorded source and section id remain available as tooltips. */
export function promptSourceLabel(id: string, source: string, locale: 'en' | 'zh-CN'): string {
  const custom = source === 'profile:system-prompt'
  const labels: Record<string, [string, string]> = {
    persona: ['Official default persona', '官方默认角色'],
    'core:untrusted-envelope': ['Safety boundary for external content', '外部内容安全边界'],
    'summary:system': ['Summary instructions', '摘要指引'],
    'deployment:persona-prefix': [
      'Your custom persona (Settings → System prompt)',
      '你的自定义角色（设置 → 系统提示词）',
    ],
    'deployment:persona-suffix': ['Your closing instructions', '你的结尾指令'],
    'deployment:reply-style': ['Your reply style', '你的回复风格'],
    'deployment:full-override': ['Your replacement prompt', '你的完整替换提示词'],
    environment: ['Working environment', '工作环境'],
    'agents-md': ['Workspace instructions', '工作区指令'],
    'coding-doctrine': ['Coding instructions', '编码指引'],
    'code-doctrine': ['Code guidelines', '代码规范'],
    'tools:sdk': ['Available tools', '可用工具'],
    skills: ['Available skills', '可用技能'],
    'plan-mode': ['Planning instructions', '规划指引'],
    'persistent-goal': ['Goal instructions', '目标指引'],
    'plugin-creator': ['Plugin creation instructions', '插件创建指引'],
    'session-query': ['Session query instructions', '会话查询指引'],
    'channel-style': ['Communication style', '沟通风格'],
    'memory-prompts': ['Session memory', '会话记忆'],
  }
  const label =
    custom && id === 'persona'
      ? labels['deployment:persona-prefix']
      : id === 'persona' && source !== '@agnes/code/prompts/persona.md'
        ? undefined
        : labels[id]
  return (
    label?.[locale === 'zh-CN' ? 1 : 0] ?? (locale === 'zh-CN' ? '插件提供的指令' : 'Plugin instructions')
  )
}
