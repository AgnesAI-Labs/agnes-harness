import { createHash } from 'node:crypto'
import type { SkillRuntimeInput } from '@agnes/host-extensions/resources/skills'
import type { EntryRow } from '@agnes/plugin-runtime/host'
import { type JsonValue, jcs } from '@agnes/protocol'

// Runtime skills belong to plugin-row lifetimes; their ephemeral IDs differ across workers.
// Only disk resources determine the reconstructible Skills facade's revision.
export function skillRowRevision(input: SkillRuntimeInput | undefined): string {
  const listed = [...(input?.list() ?? [])]
    .filter((entry) => entry.sourceIdentity.scope !== 'runtime')
    .sort((a, b) => a.resourceId.localeCompare(b.resourceId))
  const canonical = jcs({ supplied: input !== undefined, listed } as unknown as JsonValue)
  return `skill-row:v1:${createHash('sha256').update(canonical).digest('hex')}`
}

/** Replace declaring consumers while preserving every unrelated row identity. */
export function withSkillRows(
  current: readonly Readonly<EntryRow>[],
  skills: readonly Readonly<EntryRow>[],
): readonly Readonly<EntryRow>[] {
  if (skills.some((row) => !row.liveResources?.includes('skills')))
    throw new Error('undeclared Skills consumer')
  const replacements = new Map(skills.map((row) => [row.id, row]))
  return Object.freeze(current.map((row) => replacements.get(row.id) ?? row))
}
