import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { type SkillDescriptor, validateResourceControlData } from '@agnes/protocol'
import { projectRuntimeSkills, type SkillCandidate } from '@agnes/resource-control-runtime'

/** Private management projection, bound to the worker's current immutable resource snapshot. */
export function runtimeSkillView(
  input: { snapshotRevision?: unknown; skills?: unknown },
  path: string | undefined,
  current: (() => readonly SkillCandidate[]) | undefined,
) {
  if (
    typeof input.snapshotRevision !== 'string' ||
    !Array.isArray(input.skills) ||
    input.skills.length > 1024 ||
    !input.skills.every(
      (skill) =>
        validateResourceControlData('SkillDescriptor', skill).ok && skill.sourceIdentity.scope !== 'runtime',
    )
  )
    throw new TypeError('invalid Skill view request')
  if (!path || createHash('sha256').update(readFileSync(path)).digest('hex') !== input.snapshotRevision)
    throw new Error('resource snapshot changed before this Skill view completed')
  if (!current) throw new Error('runtime Skill registry is unavailable')
  return {
    skills: projectRuntimeSkills(input.skills as SkillDescriptor[], current()),
    snapshotRevision: input.snapshotRevision,
  }
}
