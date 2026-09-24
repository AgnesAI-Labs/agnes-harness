/** Template locations only. Never interpolate a real absolute path into this copy. */
export const SKILL_LOCATION_HINTS = [
  '<当前工作区>/.agh/skills/<名称>/SKILL.md',
  '~/.agh/skills/<名称>/SKILL.md',
  '~/.agents/skills/<名称>/SKILL.md',
  '~/.claude/skills/<名称>/SKILL.md',
  '~/.codex/skills/<名称>/SKILL.md',
] as const

export const SKILL_EMPTY_TITLE = '还没有发现 Skill'
export const SKILL_EMPTY_DESCRIPTION =
  '把 SKILL.md 放到下列模板路径后刷新。只扫描这些根的直属子目录，不会递归，也不会读取普通 skills/ 文件夹。'
export const SKILL_EMPTY_COPY = `${SKILL_EMPTY_TITLE}。${SKILL_EMPTY_DESCRIPTION}\n${SKILL_LOCATION_HINTS.join('\n')}`
