/** Template locations only. Never interpolate a real absolute path into this copy. */
export const SKILL_LOCATION_HINTS = [
  '<current-workspace>/.agh/skills/<name>/SKILL.md',
  '~/.agh/skills/<name>/SKILL.md',
  '~/.agents/skills/<name>/SKILL.md',
  '~/.claude/skills/<name>/SKILL.md',
  '~/.codex/skills/<name>/SKILL.md',
] as const

export const SKILL_EMPTY_TITLE = 'No Skills found'
export const SKILL_EMPTY_DESCRIPTION =
  'Add a SKILL.md file at one of these template paths and refresh. Only direct child directories are scanned; nested directories and ordinary skills/ folders are not read.'
export const SKILL_EMPTY_COPY = `${SKILL_EMPTY_TITLE}。${SKILL_EMPTY_DESCRIPTION}\n${SKILL_LOCATION_HINTS.join('\n')}`
