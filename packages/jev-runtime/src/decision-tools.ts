/** Versioned decision guidance retained separately from the executable tool catalog. */

import type { DecisionToolProfile, JsonValue, ToolDescriptor } from './types.js'

const KIND = 'jev.decision-tools.v1'
const PHASES = ['INSPECT', 'ACT', 'VERIFY'] as const

/** A recognized decision profile record with invalid JSON fields. */
export class InvalidDecisionToolSnapshot extends Error {
  constructor() {
    super('Invalid jev.decision-tools.v1 resource')
    this.name = 'InvalidDecisionToolSnapshot'
  }
}

function object(value: unknown): { [key: string]: unknown } | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * Parse one recognized durable profile snapshot; other resources remain unrelated evidence.
 * @param resource - committed JSON resource.
 * @returns detached profiles, or undefined for another resource kind.
 */
export function readDecisionToolSnapshot(resource: unknown): readonly DecisionToolProfile[] | undefined {
  const envelope = object(resource)
  if (envelope?.kind !== KIND) return undefined
  if (Object.keys(envelope).length !== 2 || !Array.isArray(envelope.profiles))
    throw new InvalidDecisionToolSnapshot()
  const profiles: DecisionToolProfile[] = []
  const operations = new Set<string>()
  for (const entry of envelope.profiles) {
    const value = object(entry)
    if (
      value === undefined ||
      Object.keys(value).length !== 7 ||
      typeof value.operation !== 'string' ||
      value.operation.length === 0 ||
      typeof value.toolRevision !== 'string' ||
      value.toolRevision.length === 0 ||
      typeof value.selection !== 'string' ||
      value.selection.length === 0 ||
      typeof value.inputs !== 'string' ||
      typeof value.result !== 'string' ||
      !Array.isArray(value.phases) ||
      value.phases.length === 0 ||
      !Array.isArray(value.constraints) ||
      operations.has(value.operation)
    )
      throw new InvalidDecisionToolSnapshot()
    const phases: DecisionToolProfile['phases'][number][] = []
    for (const phase of value.phases) {
      if (
        typeof phase !== 'string' ||
        !PHASES.some((known) => known === phase) ||
        phases.includes(phase as (typeof PHASES)[number])
      ) {
        throw new InvalidDecisionToolSnapshot()
      }
      phases.push(phase as (typeof PHASES)[number])
    }
    const constraints: string[] = []
    for (const constraint of value.constraints) {
      if (typeof constraint !== 'string') throw new InvalidDecisionToolSnapshot()
      constraints.push(constraint)
    }
    operations.add(value.operation)
    profiles.push({
      operation: value.operation,
      toolRevision: value.toolRevision,
      selection: value.selection,
      phases,
      inputs: value.inputs,
      result: value.result,
      constraints,
    })
  }
  return profiles
}

/**
 * Freeze a host profile list into the existing JSON resource protocol.
 * @param profiles - profiles for the observed catalog.
 * @returns validated detached resource, including an empty list that clears earlier profiles.
 */
export function decisionToolSnapshot(profiles: readonly DecisionToolProfile[]): JsonValue {
  const resource: JsonValue = {
    kind: KIND,
    profiles: profiles.map((profile) => ({
      operation: profile.operation,
      toolRevision: profile.toolRevision,
      selection: profile.selection,
      phases: [...profile.phases],
      inputs: profile.inputs,
      result: profile.result,
      constraints: [...profile.constraints],
    })),
  }
  readDecisionToolSnapshot(resource)
  return resource
}

/**
 * Restrict decision phases without broadening an executable descriptor's declared phases.
 * @param tool - current executable descriptor.
 * @param profile - matching recorded guidance, when available.
 * @returns effective decision phases.
 */
export function decisionToolPhases(
  tool: ToolDescriptor,
  profile?: DecisionToolProfile,
): readonly (typeof PHASES)[number][] {
  const declared = tool.phases ?? PHASES
  return profile === undefined ? declared : declared.filter((phase) => profile.phases.includes(phase))
}
