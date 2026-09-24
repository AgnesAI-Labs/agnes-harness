import { createHash } from 'node:crypto'
import type { EntryRow } from '@agnes/plugin-runtime/host'
import { type JsonValue, jcs } from '@agnes/protocol'
import type { SkillRuntimeInput } from '../resources/skills.js'

export const SKILL_ROW_ID = 'ext:agnes/skills'

/** The effective Skills view, independent of an MCP-only resource snapshot revision. */
export function skillRowRevision(input: SkillRuntimeInput | undefined): string {
  const listed = [...(input?.list() ?? [])].sort((a, b) => a.resourceId.localeCompare(b.resourceId))
  const canonical = jcs({ supplied: input !== undefined, listed } as unknown as JsonValue)
  return `skill-row:v1:${createHash('sha256').update(canonical).digest('hex')}`
}

/** Preserve every other row, including MCP rows, when the Skills generation changes. */
export function withSkillRow(
  current: readonly Readonly<EntryRow>[],
  skill: Readonly<EntryRow>,
): readonly Readonly<EntryRow>[] {
  if (skill.id !== SKILL_ROW_ID) throw new Error('wrong Skills row')
  const index = current.findIndex((row) => row.id === SKILL_ROW_ID)
  if (index < 0) return Object.freeze([...current, skill])
  return Object.freeze(current.map((row, at) => (at === index ? skill : row)))
}
